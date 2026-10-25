"use strict";

// M9 monitoring: a content-free metrics snapshot, alert evaluation with
// de-duplication, and a Prometheus text rendering for the token-protected
// metrics endpoint. Nothing here contains message content, subjects or
// addresses: only counts, ages and codes.

const crypto = require("crypto");
const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");
const { publicStatus } = require("../mail.config");
const { utcDay } = require("./usage.service");

const ACTIVE_JOB_STATUSES = ["PENDING", "LEASED", "RETRY_SCHEDULED", "RECONCILING"];

// Provider error codes that mean "provider degraded" (rate limit, 5xx, timeout).
const PROVIDER_DEGRADED = /^(RESEND_HTTP_(429|5\d\d)|PROVIDER_(TIMEOUT|NETWORK_ERROR))$/;

function createOpsMonitor({ client, config, notifications, health = async () => ({}), runtime = null, metrics = null, clock = () => new Date(), logger = null }) {
  const now = () => clock();
  const thresholds = config.ops.thresholds;

  const stopOnly = (reason) => (reason && !reason.startsWith("MAIL_ROLLOUT_") ? reason : null);

  async function snapshot() {
    const at = now();
    const day = new Date(at.getTime() - 86400000);
    const hour = new Date(at.getTime() - 3600000);
    const [queue, oldest, deadLetters24h, webhookBacklog, webhookFailed24h, scanBacklog, outcomeUnknown24h, recipients24h, broadcastRecipients24h, integrationRejections1h, retention, usageToday, limits, openAlerts] = await Promise.all([
      client.mailOutboxJob.groupBy({ by: ["queue", "status"], _count: { _all: true } }),
      client.mailOutboxJob.groupBy({ by: ["queue"], where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] }, nextAttemptAt: { lte: at } }, _min: { nextAttemptAt: true } }),
      client.mailOutboxJob.groupBy({ by: ["queue", "kind"], where: { status: "DEAD_LETTER", updatedAt: { gt: day } }, _count: { _all: true } }),
      client.mailWebhookEvent.aggregate({ where: { status: "RECEIVED" }, _count: { _all: true }, _min: { receivedAt: true } }),
      client.mailWebhookEvent.count({ where: { status: "FAILED", receivedAt: { gt: day } } }),
      client.mailAttachment.aggregate({ where: { scanStatus: { in: ["PENDING", "SCANNER_UNAVAILABLE"] } }, _count: { _all: true }, _min: { createdAt: true } }),
      client.mailMessageRecipient.count({ where: { status: "OUTCOME_UNKNOWN", lastEventAt: { gt: day } } }),
      client.mailMessageRecipient.groupBy({ by: ["status"], where: { lastEventAt: { gt: day }, status: { in: ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED", "FAILED"] } }, _count: { _all: true } }),
      client.marketingBroadcastRecipient.groupBy({ by: ["organizationId", "status"], where: { acceptedAt: { gt: day } }, _count: { _all: true } }),
      client.mailProductIntegrationEvent.groupBy({ by: ["integrationId"], where: { status: "REJECTED", receivedAt: { gt: hour } }, _count: { _all: true } }),
      client.mailRetentionRun.groupBy({ by: ["status"], where: { createdAt: { gt: new Date(at.getTime() - 7 * 86400000) } }, _count: { _all: true } }),
      client.mailUsageDaily.findMany({ where: { day: new Date(`${utcDay(at)}T00:00:00Z`) } }),
      client.mailQuotaLimit.findMany(),
      client.mailOpsAlert.findMany({ where: { resolvedAt: null }, orderBy: { lastSeenAt: "desc" }, take: 100 }),
    ]);
    // §20: provider degradation, webhook processing lag and inbound reconciliation.
    const [retrying, processedRecently, lastReconcile, recovered24h] = await Promise.all([
      client.mailOutboxJob.groupBy({ by: ["lastErrorCode"], where: { status: "RETRY_SCHEDULED" }, _count: { _all: true } }),
      client.mailWebhookEvent.findMany({ where: { processedAt: { gt: hour } }, select: { receivedAt: true, processedAt: true }, orderBy: { processedAt: "desc" }, take: 1000 }),
      client.mailOutboxJob.findFirst({ where: { kind: "RECONCILE_INBOUND", status: "SUCCEEDED" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
      client.mailOutboxJob.count({ where: { kind: "PROCESS_INBOUND", idempotencyKey: { startsWith: "inbound:reconcile:" }, nextAttemptAt: { gt: day } } }),
    ]);
    const lags = processedRecently.map((row) => Math.max(0, Math.round((row.processedAt.getTime() - row.receivedAt.getTime()) / 1000))).sort((a, b) => a - b);
    const ageSeconds = (date) => (date ? Math.max(0, Math.round((at.getTime() - new Date(date).getTime()) / 1000)) : 0);
    const staffRates = Object.fromEntries(recipients24h.map((row) => [row.status, row._count._all]));
    const brandRates = new Map();
    for (const row of broadcastRecipients24h) {
      const entry = brandRates.get(row.organizationId) || { organizationId: row.organizationId, handed: 0, bounced: 0, complained: 0 };
      entry.handed += row._count._all;
      if (row.status === "BOUNCED") entry.bounced += row._count._all;
      if (row.status === "COMPLAINED") entry.complained += row._count._all;
      brandRates.set(row.organizationId, entry);
    }
    const limitByKey = new Map(limits.map((limit) => [`${limit.organizationId}:${limit.purpose}`, limit]));
    return {
      generatedAt: at.toISOString(),
      flags: publicStatus(config),
      // Only stops count here; "not rolled out" (M10) is normal, not a halt.
      runtimeHalt: runtime ? { staffMail: stopOnly(await runtime.haltReason("STAFF_MAIL")), marketing: stopOnly(await runtime.haltReason("MARKETING_BROADCAST")) } : null,
      queue: {
        byStatus: queue.map((row) => ({ queue: row.queue, status: row.status, count: row._count._all })),
        oldestDueSeconds: Object.fromEntries(oldest.map((row) => [row.queue, ageSeconds(row._min.nextAttemptAt)])),
        active: queue.filter((row) => ACTIVE_JOB_STATUSES.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0),
        deadLetters24h: deadLetters24h.map((row) => ({ queue: row.queue, kind: row.kind, count: row._count._all })),
      },
      webhooks: { backlog: webhookBacklog._count._all, oldestBacklogSeconds: ageSeconds(webhookBacklog._min.receivedAt), failed24h: webhookFailed24h },
      scanning: { backlog: scanBacklog._count._all, oldestBacklogSeconds: ageSeconds(scanBacklog._min.createdAt) },
      delivery: { staff24h: staffRates, outcomeUnknown24h, broadcast24h: [...brandRates.values()] },
      integrations: { rejections1h: integrationRejections1h.map((row) => ({ integrationId: row.integrationId, count: row._count._all })) },
      retention: Object.fromEntries(retention.map((row) => [row.status, row._count._all])),
      usageToday: usageToday.map((row) => {
        const limit = limitByKey.get(`${row.organizationId}:${row.purpose}`);
        return { organizationId: row.organizationId, purpose: row.purpose, accepted: row.accepted, received: row.received, dailySoftLimit: limit?.dailySoftLimit ?? null, dailyHardLimit: limit?.dailyHardLimit ?? null };
      }),
      provider: { retrying: retrying.filter((row) => PROVIDER_DEGRADED.test(String(row.lastErrorCode || ""))).reduce((sum, row) => sum + row._count._all, 0) },
      webhookLag1h: { sample: lags.length, maxSeconds: lags.length ? lags[lags.length - 1] : 0, p95Seconds: lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.95))] : 0 },
      reconciliation: {
        enabled: Boolean(config.receivingEnabled && config.reconciliation.enabled),
        lastSuccessAt: lastReconcile?.completedAt?.toISOString() || null,
        lastSuccessAgeSeconds: lastReconcile?.completedAt ? ageSeconds(lastReconcile.completedAt) : null,
        recovered24h,
      },
      process: metrics ? { authDenials: metrics.total("auth_denials"), providerErrors: metrics.total("provider_errors") } : null,
      openAlerts: openAlerts.map(serializeAlert),
    };
  }

  function serializeAlert(alert) {
    return { id: alert.id, code: alert.code, severity: alert.severity, organizationId: alert.organizationId, detail: alert.detail, occurrences: alert.occurrences, firstSeenAt: alert.firstSeenAt.toISOString(), lastSeenAt: alert.lastSeenAt.toISOString(), acknowledgedAt: alert.acknowledgedAt?.toISOString() || null, resolvedAt: alert.resolvedAt?.toISOString() || null };
  }

  // Pure rule evaluation over a snapshot (unit-testable).
  function evaluate(snap, healthReport = {}) {
    const alerts = [];
    const push = (code, severity, detail = {}, organizationId = null) => alerts.push({ code, severity, detail, organizationId, fingerprint: `${code}:${organizationId || "-"}:${detail.key || ""}` });
    for (const [queue, seconds] of Object.entries(snap.queue.oldestDueSeconds)) if (seconds > thresholds.queueOldestPendingSeconds) push("MAIL_QUEUE_STALLED", seconds > thresholds.queueOldestPendingSeconds * 4 ? "critical" : "warning", { key: queue, queue, oldestDueSeconds: seconds });
    const dead = snap.queue.deadLetters24h.reduce((sum, row) => sum + row.count, 0);
    if (dead >= thresholds.deadLetters24h) push("MAIL_DEAD_LETTERS", "warning", { count: dead, byKind: snap.queue.deadLetters24h.map((row) => `${row.queue}/${row.kind}:${row.count}`) });
    if (snap.webhooks.backlog && snap.webhooks.oldestBacklogSeconds > thresholds.webhookBacklogSeconds) push("MAIL_WEBHOOK_BACKLOG", "warning", { backlog: snap.webhooks.backlog, oldestSeconds: snap.webhooks.oldestBacklogSeconds });
    if (snap.scanning.backlog && snap.scanning.oldestBacklogSeconds > thresholds.scanBacklogSeconds) push("MAIL_SCAN_BACKLOG", "warning", { backlog: snap.scanning.backlog, oldestSeconds: snap.scanning.oldestBacklogSeconds });
    if (snap.delivery.outcomeUnknown24h >= thresholds.outcomeUnknown24h) push("MAIL_OUTCOME_UNKNOWN", "warning", { count: snap.delivery.outcomeUnknown24h });
    const staff = snap.delivery.staff24h;
    const staffTotal = ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED"].reduce((sum, key) => sum + (staff[key] || 0), 0);
    if (staffTotal >= thresholds.minSampleForRates && ((staff.BOUNCED || 0) * 100) / staffTotal >= thresholds.bounceRatePercent) push("MAIL_BOUNCE_RATE_HIGH", "critical", { key: "staff", scope: "staff", sample: staffTotal, bounced: staff.BOUNCED || 0 });
    for (const brand of snap.delivery.broadcast24h) {
      if (brand.handed < thresholds.minSampleForRates) continue;
      if ((brand.bounced * 100) / brand.handed >= thresholds.bounceRatePercent) push("MAIL_BOUNCE_RATE_HIGH", "critical", { key: "marketing", scope: "marketing", sample: brand.handed, bounced: brand.bounced }, brand.organizationId);
      if ((brand.complained * 1000) / brand.handed >= thresholds.complaintRatePerThousand) push("MAIL_COMPLAINT_RATE_HIGH", "critical", { key: "marketing", sample: brand.handed, complained: brand.complained }, brand.organizationId);
    }
    for (const row of snap.integrations.rejections1h) if (row.count >= thresholds.integrationRejections1h) push("MAIL_INTEGRATION_REJECTIONS", "warning", { key: row.integrationId, integrationId: row.integrationId, count: row.count });
    if (snap.retention.FAILED) push("MAIL_RETENTION_RUN_FAILED", "warning", { count: snap.retention.FAILED });
    for (const usage of snap.usageToday) {
      if (usage.dailyHardLimit && usage.accepted >= usage.dailyHardLimit) push("MAIL_QUOTA_HARD_LIMIT_REACHED", "critical", { key: usage.purpose, purpose: usage.purpose, accepted: usage.accepted, limit: usage.dailyHardLimit }, usage.organizationId);
      else if (usage.dailySoftLimit && usage.accepted >= usage.dailySoftLimit) push("MAIL_QUOTA_SOFT_LIMIT_REACHED", "warning", { key: usage.purpose, purpose: usage.purpose, accepted: usage.accepted, limit: usage.dailySoftLimit }, usage.organizationId);
    }
    if (snap.provider && snap.provider.retrying >= thresholds.providerRetrying) push("MAIL_PROVIDER_DEGRADED", "warning", { retrying: snap.provider.retrying });
    if (snap.webhookLag1h && snap.webhookLag1h.p95Seconds > thresholds.webhookLagSeconds) push("MAIL_WEBHOOK_LAG_HIGH", "warning", { p95Seconds: snap.webhookLag1h.p95Seconds, maxSeconds: snap.webhookLag1h.maxSeconds, sample: snap.webhookLag1h.sample });
    if (snap.reconciliation?.enabled) {
      const interval = config.reconciliation.inboundIntervalSeconds;
      if (snap.reconciliation.lastSuccessAgeSeconds === null || snap.reconciliation.lastSuccessAgeSeconds > interval * 3) push("MAIL_RECONCILIATION_STALE", "warning", { lastSuccessAgeSeconds: snap.reconciliation.lastSuccessAgeSeconds, intervalSeconds: interval });
      if (snap.reconciliation.recovered24h > 0) push("MAIL_INBOUND_WEBHOOKS_MISSED", "warning", { recovered24h: snap.reconciliation.recovered24h });
    }
    if (snap.runtimeHalt?.staffMail || snap.runtimeHalt?.marketing) push("MAIL_EMERGENCY_STOP_ACTIVE", "warning", { key: "halt", staffMail: snap.runtimeHalt.staffMail, marketing: snap.runtimeHalt.marketing });
    if (healthReport.storage && healthReport.storage.ok === false && config.enabled) push("MAIL_STORAGE_UNHEALTHY", "critical", { detail: healthReport.storage.detail });
    if (healthReport.encryption && healthReport.encryption.available === false && config.enabled) push("MAIL_ENCRYPTION_UNAVAILABLE", "critical", { error: healthReport.encryption.error });
    if (healthReport.infrastructure?.violations?.length) push("MAIL_INFRASTRUCTURE_VIOLATION", "critical", { violations: healthReport.infrastructure.violations });
    return alerts;
  }

  async function adminRecipients() {
    const rows = await client.adminSectionGrant.findMany({ where: { module: "mail", section: "admin", revokedAt: null }, select: { adminUserId: true } });
    return [...new Set(rows.map((row) => row.adminUserId))];
  }

  // Persist: open new alerts, bump repeats, escalate severity, resolve cleared.
  async function processEvaluate() {
    if (!config.ops.alertsEnabled) return { skipped: "OPS_ALERTS_DISABLED" };
    const [snap, healthReport] = await Promise.all([snapshot(), health().catch(() => ({}))]);
    const found = evaluate(snap, healthReport);
    const at = now();
    const open = await client.mailOpsAlert.findMany({ where: { resolvedAt: null } });
    const openByFingerprint = new Map(open.map((alert) => [alert.fingerprint, alert]));
    const toNotify = [];
    for (const alert of found) {
      const fingerprint = crypto.createHash("sha256").update(alert.fingerprint).digest("hex").slice(0, 64);
      const existing = openByFingerprint.get(fingerprint);
      if (existing) {
        openByFingerprint.delete(fingerprint);
        const escalated = existing.severity !== "critical" && alert.severity === "critical";
        await client.mailOpsAlert.update({ where: { id: existing.id }, data: { occurrences: existing.occurrences + 1, lastSeenAt: at, detail: alert.detail, ...(escalated ? { severity: "critical", notifiedAt: at } : {}) } });
        if (escalated) toNotify.push(alert);
        continue;
      }
      try {
        await client.mailOpsAlert.create({ data: { code: alert.code, severity: alert.severity, organizationId: alert.organizationId, fingerprint, detail: alert.detail, firstSeenAt: at, lastSeenAt: at, notifiedAt: at } });
        toNotify.push(alert);
      } catch (error) {
        if (error.code !== "P2002") throw error; // another worker opened it
      }
    }
    // Conditions that cleared resolve automatically.
    for (const stale of openByFingerprint.values()) await client.mailOpsAlert.update({ where: { id: stale.id }, data: { resolvedAt: at } });
    if (toNotify.length) {
      const recipients = await adminRecipients();
      for (const alert of toNotify) await notifications.notifyUsers(recipients, { icon: alert.severity === "critical" ? "xcircle" : "alert", title: `Mail ${alert.severity}: ${alert.code}`, subtitle: "Open Mail operations for details." }).catch((error) => logger?.warn?.(`[MailOps] notify failed: ${error?.code || error?.message}`));
    }
    return { evaluated: found.length, notified: toNotify.length, resolved: openByFingerprint.size };
  }

  async function listAlerts(user, { includeResolved } = {}) {
    await policy.requireMailAdmin(client, user, "VIEW");
    const rows = await client.mailOpsAlert.findMany({ where: includeResolved === "true" || includeResolved === true ? {} : { resolvedAt: null }, orderBy: { lastSeenAt: "desc" }, take: 200 });
    return rows.map(serializeAlert);
  }

  async function acknowledge(user, alertId, audit, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const alert = policy.isUuid(alertId) ? await client.mailOpsAlert.findUnique({ where: { id: alertId } }) : null;
    if (!alert) throw mailError("MAIL_NOT_FOUND", { resource: "ops_alert" });
    const row = await client.mailOpsAlert.update({ where: { id: alert.id }, data: { acknowledgedAt: now(), acknowledgedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_OPS_ALERT_ACKNOWLEDGED", targetType: "mail_ops_alert", targetId: alert.id, organizationId: alert.organizationId, metadata: { code: alert.code } }, context);
    return serializeAlert(row);
  }

  async function adminSnapshot(user) {
    await policy.requireMailAdmin(client, user, "VIEW");
    return snapshot();
  }

  // Prometheus text exposition (counts and ages only).
  async function prometheus() {
    const snap = await snapshot();
    const lines = [];
    const metric = (name, help, type, samples) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`).join(",")}}` : ""} ${Number(value) || 0}`);
    };
    metric("cf_mail_jobs", "Mail jobs by queue and status", "gauge", snap.queue.byStatus.map((row) => [{ queue: row.queue, status: row.status }, row.count]));
    metric("cf_mail_queue_oldest_due_seconds", "Age of the oldest due job", "gauge", Object.entries(snap.queue.oldestDueSeconds).map(([queue, value]) => [{ queue }, value]));
    metric("cf_mail_dead_letters_24h", "Dead-lettered jobs in the last 24h", "gauge", snap.queue.deadLetters24h.map((row) => [{ queue: row.queue, kind: row.kind }, row.count]));
    metric("cf_mail_webhook_backlog", "Unprocessed provider webhooks", "gauge", [[null, snap.webhooks.backlog]]);
    metric("cf_mail_webhook_backlog_oldest_seconds", "Age of the oldest unprocessed webhook", "gauge", [[null, snap.webhooks.oldestBacklogSeconds]]);
    metric("cf_mail_scan_backlog", "Attachments waiting for a malware verdict", "gauge", [[null, snap.scanning.backlog]]);
    metric("cf_mail_outcome_unknown_24h", "Recipients with unknown send outcome (24h)", "gauge", [[null, snap.delivery.outcomeUnknown24h]]);
    metric("cf_mail_staff_recipients_24h", "Staff mail recipient outcomes (24h)", "gauge", Object.entries(snap.delivery.staff24h).map(([status, value]) => [{ status }, value]));
    metric("cf_mail_usage_today", "Accepted messages today by brand and purpose", "gauge", snap.usageToday.map((row) => [{ organization: row.organizationId, purpose: row.purpose }, row.accepted]));
    metric("cf_mail_open_alerts", "Open Mail ops alerts", "gauge", ["critical", "warning", "info"].map((severity) => [{ severity }, snap.openAlerts.filter((alert) => alert.severity === severity).length]));
    metric("cf_mail_provider_retrying_jobs", "Jobs backing off on provider 429/5xx/timeouts", "gauge", [[null, snap.provider.retrying]]);
    metric("cf_mail_webhook_processing_lag_seconds", "Webhook receive-to-processed lag over the last hour", "gauge", [[{ quantile: "0.95" }, snap.webhookLag1h.p95Seconds], [{ quantile: "max" }, snap.webhookLag1h.maxSeconds]]);
    metric("cf_mail_inbound_reconciled_24h", "Inbound emails recovered by reconciliation (missed webhooks, 24h)", "gauge", [[null, snap.reconciliation.recovered24h]]);
    metric("cf_mail_inbound_reconciliation_age_seconds", "Seconds since the last successful inbound reconciliation", "gauge", [[null, snap.reconciliation.lastSuccessAgeSeconds ?? -1]]);
    if (metrics) {
      metric("cf_mail_auth_denials_total", "Mail API requests refused with 401/403 (this process)", "counter", metrics.samples("auth_denials"));
      metric("cf_mail_provider_errors_total", "Provider call errors by channel, kind and status (this process)", "counter", metrics.samples("provider_errors"));
    }
    metric("cf_mail_halted", "1 when an emergency stop halts the purpose", "gauge", [[{ purpose: "staff" }, snap.runtimeHalt?.staffMail ? 1 : 0], [{ purpose: "marketing" }, snap.runtimeHalt?.marketing ? 1 : 0]]);
    return `${lines.join("\n")}\n`;
  }

  function metricsAuthorized(header) {
    const token = config.ops.metricsToken;
    if (token.length < 32) return { enabled: false };
    const provided = Buffer.from(String(header || "").replace(/^Bearer\s+/i, ""), "utf8");
    const expected = Buffer.from(token, "utf8");
    return { enabled: true, ok: provided.length === expected.length && crypto.timingSafeEqual(provided, expected) };
  }

  return { snapshot, evaluate, processEvaluate, listAlerts, acknowledge, adminSnapshot, prometheus, metricsAuthorized };
}

module.exports = { createOpsMonitor };
