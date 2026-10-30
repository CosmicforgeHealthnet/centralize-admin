const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Prisma } = require("../../../../generated/admin-client");
const { DEFAULTS: BOOTSTRAP_DEFAULTS, validateSetting, createAlertSettingsService } = require("../alerts/alert-settings.service");
const { DEFAULT_SEVERITY, evaluateCampaignAlerts, evaluateConnectionAlerts } = require("../alerts/alert-rules");
const { createAlertRepository } = require("../alerts/alert.repository");
const { createAlertLifecycleService } = require("../alerts/alert-lifecycle.service");
const { createAlertNotificationAdapter } = require("../alerts/alert-notification.adapter");
const { alertEvaluateSchema } = require("../alerts/alert.validator");
const DEFAULTS = Object.freeze({ ...BOOTSTRAP_DEFAULTS, targetCpa: 25 });

const D = (value) => new Prisma.Decimal(String(value));
function campaign(overrides = {}) {
  return {
    platform: "META", connectionId: "11111111-1111-4111-8111-111111111111", campaignExternalId: "campaign-a", currencyCode: "EUR", currencyCompatible: true,
    windowComplete: true, dataSufficiency: "STRONG", trendConsistent: true, conditionDays: 7, persistenceEvaluations: 3,
    spend: D(200), impressions: 10000n, clicks: 200n, internalConversions: 10n, cpa: D(20), roas: D(3), ctr: D("0.02"), conversionRate: D("0.05"),
    comparisonCpa: D(20), comparisonRoas: D(3), comparisonCtr: D("0.02"), comparisonConversionRate: D("0.05"), comparisonClicks: 200n, comparisonConversions: 10n,
    fatiguedCreativeAssetIds: [], ...overrides,
  };
}

test("alert settings apply connection/platform/global precedence and invalid recipients fall through", async () => {
  const rows = [
    { id: "g", key: "alertSyncStaleHours", scopeType: "GLOBAL", valueJson: 48, version: 1 },
    { id: "p", key: "alertSyncStaleHours", scopeType: "PLATFORM", platform: "META", valueJson: 12, version: 1 },
    { id: "bad", key: "alertRecipientAdminUserIds", scopeType: "CONNECTION", connectionId: "c", valueJson: "not-array", version: 1 },
  ];
  const service = createAlertSettingsService({ prisma: { marketing_intelligence_settings: { findMany: async () => rows } } });
  const result = await service.resolveSettings({ platform: "META", connectionId: "c" });
  assert.equal(result.values.alertSyncStaleHours, 12);
  assert.deepEqual(result.values.alertRecipientAdminUserIds, DEFAULTS.alertRecipientAdminUserIds);
  assert.equal(result.invalidSettings.length, 1);
  assert.throws(() => validateSetting("alertCpaThresholdPct", 2));
});

test("CPA-target alert rules skip when the currency-specific target is unavailable", () => {
  const unavailable = { ...DEFAULTS, targetCpa: null, alertTargetCpa: null };
  const rows = evaluateCampaignAlerts(campaign({ cpa: D(50) }), unavailable);
  assert.equal(rows.some((item) => ["CPA_TARGET_BREACH", "HIGH_PERFORMING_CAMPAIGN"].includes(item.type)), false);
});

test("campaign rules create all six evidence-backed campaign and creative alert types", () => {
  const settings = DEFAULTS;
  assert.equal(evaluateCampaignAlerts(campaign({ cpa: D(40) }), settings)[0].type, "CPA_TARGET_BREACH");
  assert.ok(evaluateCampaignAlerts(campaign({ spend: D(150), internalConversions: 0n, cpa: null }), settings).some((item) => item.type === "SPEND_WITHOUT_CONVERSION"));
  assert.ok(evaluateCampaignAlerts(campaign({ conversionRate: D("0.02") }), settings).some((item) => item.type === "CONVERSION_RATE_DROP"));
  assert.ok(evaluateCampaignAlerts(campaign({ fatiguedCreativeAssetIds: ["creative-1"] }), settings).some((item) => item.type === "CREATIVE_FATIGUE"));
  assert.ok(evaluateCampaignAlerts(campaign({ cpa: D(30), roas: D(2), conversionRate: D("0.03"), ctr: D("0.015") }), settings).some((item) => item.type === "CAMPAIGN_PERFORMANCE_DROP"));
  assert.ok(evaluateCampaignAlerts(campaign({ cpa: D(15) }), settings).some((item) => item.type === "HIGH_PERFORMING_CAMPAIGN"));
});

test("campaign alert boundaries require sufficient persistent compatible internal evidence", () => {
  assert.deepEqual(evaluateCampaignAlerts(campaign({ cpa: D(40), currencyCompatible: false, trendConsistent: false, dataSufficiency: "INSUFFICIENT", windowComplete: false }), DEFAULTS), []);
  assert.equal(evaluateCampaignAlerts(campaign({ cpa: D(40), internalConversions: 1n }), DEFAULTS).some((item) => item.type === "CPA_TARGET_BREACH"), false);
  assert.ok(!evaluateCampaignAlerts(campaign({ fatiguedCreativeAssetIds: [] }), DEFAULTS).some((item) => item.type === "CREATIVE_FATIGUE"));
});

test("connection rules create stale, refresh, degraded, and permission alerts with sanitized evidence", () => {
  const stale = evaluateConnectionAlerts({ id: "c1", platform: "META", status: "ACTIVE", lastSyncedAt: new Date(0) }, DEFAULTS, new Date("2026-07-19T00:00:00Z"));
  assert.equal(stale[0].type, "SYNC_STALE");
  const refresh = evaluateConnectionAlerts({ id: "c2", platform: "META", status: "ERROR", requiresReauthorization: true, lastSyncError: "Bearer secret-token raw provider body" }, DEFAULTS);
  assert.ok(refresh.some((item) => item.type === "TOKEN_REFRESH_FAILED"));
  assert.doesNotMatch(JSON.stringify(refresh), /secret-token|raw provider body/);
  const degraded = evaluateConnectionAlerts({ id: "c3", platform: "X", status: "ERROR", connectionMetadata: { consecutiveFailures: 3 }, lastSyncError: "timeout" }, DEFAULTS);
  assert.ok(degraded.some((item) => item.type === "CONNECTION_DEGRADED"));
  const permission = evaluateConnectionAlerts({ id: "c4", platform: "LINKEDIN", status: "ERROR", sanitizedValidationError: "permission denied: raw-response" }, DEFAULTS);
  assert.ok(permission.some((item) => item.type === "PLATFORM_PERMISSION_ERROR"));
  assert.doesNotMatch(JSON.stringify(permission), /raw-response/);
});

test("default severities match the required ten-type mapping", () => {
  assert.deepEqual(DEFAULT_SEVERITY, {
    CPA_TARGET_BREACH: "WARNING", SPEND_WITHOUT_CONVERSION: "CRITICAL", CONVERSION_RATE_DROP: "WARNING", CREATIVE_FATIGUE: "WARNING", SYNC_STALE: "WARNING", CAMPAIGN_PERFORMANCE_DROP: "WARNING", HIGH_PERFORMING_CAMPAIGN: "INFO", TOKEN_REFRESH_FAILED: "CRITICAL", CONNECTION_DEGRADED: "WARNING", PLATFORM_PERMISSION_ERROR: "CRITICAL",
  });
});

function memoryAlertDb(initial = []) {
  const rows = initial.map((row) => ({ ...row }));
  return { rows, marketing_alerts: {
    findFirst: async ({ where }) => rows.filter((row) => row.conditionKey === where.conditionKey).sort((a, b) => b.lifecycle - a.lifecycle)[0] || null,
    create: async ({ data }) => { const row = { id: `a${rows.length + 1}`, occurrenceCount: 1, createdAt: new Date(), ...data }; rows.push(row); return { ...row }; },
    update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); for (const [key, value] of Object.entries(data)) row[key] = value?.increment ? Number(row[key] || 0) + value.increment : value; return { ...row }; },
    findMany: async () => rows.filter((row) => ["OPEN", "ACKNOWLEDGED"].includes(row.status)),
  } };
}

test("repository deduplicates active alerts, preserves triggeredAt, escalates, and suppresses cooldown", async () => {
  const db = memoryAlertDb(); const repository = createAlertRepository({ prisma: db });
  const base = { type: "CPA_TARGET_BREACH", severity: "WARNING", conditionKey: "key", message: "safe", evidence: {}, platform: "META" };
  const first = await repository.persist(base, { now: new Date("2026-07-19T00:00:00Z") });
  await repository.markDelivery(first.alert.id, { notificationId: "n1", cooldownMinutes: 60, deliveredAt: new Date("2026-07-19T00:00:00Z") });
  const repeated = await repository.persist(base, { now: new Date("2026-07-19T00:30:00Z") });
  assert.equal(repeated.shouldNotify, false); assert.equal(repeated.alert.occurrenceCount, 2); assert.equal(repeated.alert.triggeredAt.toISOString(), "2026-07-19T00:00:00.000Z");
  const escalated = await repository.persist({ ...base, severity: "CRITICAL" }, { now: new Date("2026-07-19T00:31:00Z") });
  assert.equal(escalated.shouldNotify, true); assert.equal(escalated.escalated, true); assert.equal(db.rows.length, 1);
  const downgraded = await repository.persist({ ...base, severity: "INFO" }, { now: new Date("2026-07-19T00:32:00Z") });
  assert.equal(downgraded.alert.severity, "CRITICAL");
});

test("recovery requires consecutive evaluations and a returned resolved condition starts a new lifecycle", async () => {
  const db = memoryAlertDb([{ id: "a1", conditionKey: "key", lifecycle: 1, dedupeKey: "key:1", status: "OPEN", severity: "WARNING", recoveryStreak: 0, triggeredAt: new Date(), createdAt: new Date() }]);
  const repository = createAlertRepository({ prisma: db });
  assert.deepEqual(await repository.recoverAbsent({ activeConditionKeys: new Set(), recoveryEvaluations: 2 }), []);
  assert.equal(db.rows[0].status, "OPEN");
  assert.deepEqual(await repository.recoverAbsent({ activeConditionKeys: new Set(), recoveryEvaluations: 2 }), ["a1"]);
  assert.equal(db.rows[0].status, "RESOLVED");
  const next = await repository.persist({ type: "CPA_TARGET_BREACH", severity: "WARNING", conditionKey: "key", message: "safe", evidence: {} });
  assert.equal(next.alert.lifecycle, 2); assert.equal(db.rows.length, 2);
});

test("manual lifecycle permits OPEN acknowledge and OPEN/ACKNOWLEDGED resolve only", async () => {
  const alertId = "11111111-1111-4111-8111-111111111111";
  const adminId = "22222222-2222-4222-8222-222222222222";
  const rows = [{ id: alertId, status: "OPEN", type: "SYNC_STALE" }];
  const audits = [];
  const db = { marketing_alerts: { findUnique: async () => rows[0], update: async ({ data }) => Object.assign(rows[0], data) }, auditLog: { create: async ({ data }) => { audits.push(data); return data; } } };
  const lifecycle = createAlertLifecycleService({ prisma: db });
  assert.equal((await lifecycle.acknowledge(alertId, adminId)).status, "ACKNOWLEDGED");
  assert.equal((await lifecycle.resolve(alertId, adminId, "fixed")).status, "RESOLVED");
  rows[0].status = "RESOLVED"; assert.equal((await lifecycle.resolve(alertId, adminId, "fixed")).status, "RESOLVED");
  assert.equal(audits.length, 2); assert.equal(audits[0].metadata.previousStatus, "OPEN"); assert.equal(audits[1].metadata.previousStatus, "ACKNOWLEDGED");
});

test("recipient targeting filters inactive users and realtime follows persisted Notification", async () => {
  const events = [];
  const db = { adminUser: { findMany: async ({ where }) => where.id ? [{ id: "active" }] : [] } };
  const adapter = createAlertNotificationAdapter({ prisma: db, notifications: { createNotification: async ({ adminUserId }) => { events.push(`persist:${adminUserId}`); return { id: "n1" }; } }, realtime: (id) => events.push(`realtime:${id}`) });
  const result = await adapter.deliver({ id: "a", type: "SYNC_STALE", severity: "WARNING", message: "safe", triggeredAt: new Date() }, { alertRecipientAdminUserIds: ["11111111-1111-4111-8111-111111111111"], alertRecipientDepartment: "MARKETING" });
  assert.deepEqual(events, ["persist:active", "realtime:active"]); assert.equal(result.notifications.length, 1);
});

test("realtime failure is sanitized and does not remove persisted notification", async () => {
  const adapter = createAlertNotificationAdapter({ prisma: { adminUser: { findMany: async () => [{ id: "active" }] } }, notifications: { createNotification: async () => ({ id: "n1" }) }, realtime: () => { throw new Error("Bearer top-secret"); } });
  const result = await adapter.deliver({ id: "a", type: "TOKEN_REFRESH_FAILED", severity: "CRITICAL", message: "safe", triggeredAt: new Date() }, { alertRecipientAdminUserIds: ["11111111-1111-4111-8111-111111111111"] });
  assert.equal(result.notifications.length, 1); assert.equal(result.realtimeFailures.length, 1); assert.doesNotMatch(result.realtimeFailures[0], /top-secret/);
});

test("no-recipient and notification-persistence failures remain sanitized delivery results", async () => {
  const noRecipient = createAlertNotificationAdapter({ prisma: { adminUser: { findMany: async () => [] } } });
  const empty = await noRecipient.deliver({ id: "a", type: "SYNC_STALE", severity: "WARNING", message: "safe", triggeredAt: new Date() }, { alertRecipientAdminUserIds: [], alertRecipientDepartment: "MARKETING" });
  assert.equal(empty.reason, "NO_VALID_RECIPIENT"); assert.equal(empty.notifications.length, 0);
  const failed = createAlertNotificationAdapter({ prisma: { adminUser: { findMany: async () => [{ id: "active" }] } }, notifications: { createNotification: async () => { throw new Error("Bearer secret-token"); } } });
  const result = await failed.deliver({ id: "a", type: "SYNC_STALE", severity: "WARNING", message: "safe", triggeredAt: new Date() }, { alertRecipientAdminUserIds: ["11111111-1111-4111-8111-111111111111"] });
  assert.equal(result.notifications.length, 0); assert.equal(result.persistenceFailures.length, 1); assert.doesNotMatch(result.persistenceFailures[0], /secret-token/);
});

test("alert trigger boundaries reject one-evaluation spend, incomplete decline, WATCH fatigue, and mixed-currency deterioration", () => {
  assert.equal(evaluateCampaignAlerts(campaign({ internalConversions: 0n, spend: D(150), cpa: null, persistenceEvaluations: 1 }), DEFAULTS).some((row) => row.type === "SPEND_WITHOUT_CONVERSION"), false);
  assert.equal(evaluateCampaignAlerts(campaign({ conversionRate: D("0.01"), windowComplete: false }), DEFAULTS).some((row) => row.type === "CONVERSION_RATE_DROP"), false);
  assert.equal(evaluateCampaignAlerts(campaign({ fatiguedCreativeAssetIds: [], fatigueStatus: "WATCH" }), DEFAULTS).some((row) => row.type === "CREATIVE_FATIGUE"), false);
  assert.equal(evaluateCampaignAlerts(campaign({ cpa: D(30), roas: D(2), conversionRate: D("0.03"), ctr: D("0.015"), currencyCompatible: false }), DEFAULTS).some((row) => row.type === "CAMPAIGN_PERFORMANCE_DROP"), false);
});

test("alert API validation, route RBAC, and existing socket server boundary are enforced", () => {
  assert.equal(alertEvaluateSchema.safeParse({ platform: "META", from: "2026-07-01", to: "2026-07-07" }).success, true);
  assert.equal(alertEvaluateSchema.safeParse({ from: "2026-07-07", to: "2026-07-01" }).success, false);
  const routes = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  assert.match(routes, /"\/alerts"[\s\S]*?"VIEW"/); assert.match(routes, /"\/alerts\/evaluate"[\s\S]*?"EDIT"/); assert.match(routes, /"\/alerts\/:id\/acknowledge"[\s\S]*?"EDIT"/); assert.match(routes, /"\/alerts\/:id\/resolve"[\s\S]*?"EDIT"/);
  const socket = fs.readFileSync(path.join(__dirname, "../../../../websocket/index.js"), "utf8");
  assert.equal((socket.match(/new Server\(/g) || []).length, 1); assert.doesNotMatch(socket, /of\("\/marketing|of\("\/notifications/);
});

test("alert implementation contains no provider writes or live network calls", () => {
  const dir = path.join(__dirname, "../alerts");
  const source = fs.readdirSync(dir).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
  assert.doesNotMatch(source, /fetch\(|axios\.|\.pauseCampaign|\.updateBudget|\.refreshToken\(/);
});
