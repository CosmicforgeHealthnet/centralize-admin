"use strict";

// M9 retention runs (administration side).
//
// Safety model:
// - Every run starts as a DRY_RUN: it only counts what a policy would touch
//   and what legal holds protect. No content or addresses are recorded.
// - EXECUTE is refused unless MAIL_RETENTION_EXECUTION_ENABLED=true, a
//   completed dry run for the same policy/category is recent
//   (MAIL_RETENTION_DRY_RUN_VALID_HOURS), the policy has not changed since, and
//   the caller passes an MFA step-up for MAIL_RETENTION_EXECUTE.
// - EXECUTE reuses the dry run's fixed cutoff, so it can never act on mail
//   newer than what was reviewed. One execution per dry run (DB unique).
// - Legal holds are re-evaluated by the processor for every batch.
// - Retention periods are never defaulted here; policies are configured by
//   authorised operators and system categories need an explicit period.

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");

const SYSTEM_CATEGORIES = Object.freeze({
  WEBHOOK_PAYLOADS: { action: "REDACT" },
  INTEGRATION_EVENTS: { action: "DELETE" },
  PRODUCT_DELIVERY_EVENTS: { action: "DELETE" },
});
const OPEN_STATUSES = ["QUEUED", "RUNNING"];

function serializeRun(run) {
  return {
    id: run.id, organizationId: run.organizationId, policyId: run.policyId, category: run.category, action: run.action, mode: run.mode, status: run.status,
    cutoff: run.cutoff.toISOString(), dryRunId: run.dryRunId, requestedBy: run.requestedBy, counts: run.counts || {}, errorCode: run.errorCode,
    startedAt: run.startedAt?.toISOString() || null, completedAt: run.completedAt?.toISOString() || null, createdAt: run.createdAt.toISOString(),
  };
}

function createRetentionService({ client, config, audit, jobs, stepUp, clock = () => new Date() }) {
  const now = () => clock();

  async function enqueue(tx, run) {
    await jobs.enqueue(tx, { queue: "EVENTS", kind: "RETENTION_RUN", idempotencyKey: `retention-run:${run.id}`, payload: { runId: run.id }, maxAttempts: 10 });
  }

  async function resolveTarget({ policyId, category }) {
    if (policyId) {
      const row = policy.isUuid(policyId) ? await client.mailRetentionPolicy.findUnique({ where: { id: policyId } }) : null;
      if (!row) throw mailError("MAIL_NOT_FOUND", { resource: "retention_policy" });
      if (!row.enabled) throw mailError("MAIL_VALIDATION_FAILED", { field: "policyId", reason: "POLICY_DISABLED" });
      return { category: "POLICY", policy: row, action: row.action, organizationId: row.organizationId, days: row.retainDays };
    }
    if (!SYSTEM_CATEGORIES[category]) throw mailError("MAIL_VALIDATION_FAILED", { field: "category" });
    const days = config.retention.systemDays[category];
    if (!days) throw mailError("MAIL_RETENTION_PERIOD_NOT_CONFIGURED", { category });
    return { category, policy: null, action: SYSTEM_CATEGORIES[category].action, organizationId: null, days };
  }

  async function startDryRun(user, input = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const target = await resolveTarget(input);
    const open = await client.mailRetentionRun.findFirst({ where: { category: target.category, policyId: target.policy?.id || null, status: { in: OPEN_STATUSES } } });
    if (open) throw mailError("MAIL_INVALID_TRANSITION", { reason: "RUN_IN_PROGRESS", runId: open.id });
    const cutoff = new Date(now().getTime() - target.days * 86400000);
    const run = await client.$transaction(async (tx) => {
      const created = await tx.mailRetentionRun.create({ data: { organizationId: target.organizationId, policyId: target.policy?.id || null, category: target.category, action: target.action, mode: "DRY_RUN", cutoff, requestedBy: user.id, counts: { retainDays: target.days }, createdAt: now() } });
      await enqueue(tx, created);
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_RETENTION_DRY_RUN_REQUESTED", targetType: "mail_retention_run", targetId: created.id, organizationId: target.organizationId, metadata: { category: target.category, policyId: target.policy?.id || null, action: target.action, cutoff: cutoff.toISOString() } }, context, tx);
      return created;
    });
    return serializeRun(run);
  }

  async function execute(user, dryRunId, { stepUpId } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!config.retention.executionEnabled) throw mailError("MAIL_RETENTION_EXECUTION_DISABLED");
    const dryRun = policy.isUuid(dryRunId) ? await client.mailRetentionRun.findUnique({ where: { id: dryRunId } }) : null;
    if (!dryRun || dryRun.mode !== "DRY_RUN") throw mailError("MAIL_NOT_FOUND", { resource: "retention_run" });
    const fresh = dryRun.status === "COMPLETED" && dryRun.completedAt && now().getTime() - dryRun.completedAt.getTime() <= config.retention.dryRunValidHours * 3600000;
    if (!fresh) throw mailError("MAIL_RETENTION_DRY_RUN_REQUIRED", { reason: dryRun.status === "COMPLETED" ? "DRY_RUN_EXPIRED" : "DRY_RUN_NOT_COMPLETED" });
    if (dryRun.category === "POLICY") {
      const current = await client.mailRetentionPolicy.findUnique({ where: { id: dryRun.policyId } });
      if (!current?.enabled || current.action !== dryRun.action || current.retainDays !== dryRun.counts?.retainDays) throw mailError("MAIL_RETENTION_DRY_RUN_REQUIRED", { reason: "POLICY_CHANGED" });
    } else if (config.retention.systemDays[dryRun.category] !== dryRun.counts?.retainDays) {
      throw mailError("MAIL_RETENTION_DRY_RUN_REQUIRED", { reason: "PERIOD_CHANGED" });
    }
    const run = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_RETENTION_EXECUTE", context);
      const created = await tx.mailRetentionRun.create({ data: { organizationId: dryRun.organizationId, policyId: dryRun.policyId, category: dryRun.category, action: dryRun.action, mode: "EXECUTE", cutoff: dryRun.cutoff, dryRunId: dryRun.id, requestedBy: user.id, counts: { retainDays: dryRun.counts?.retainDays, dryRunCandidates: dryRun.counts?.candidates ?? null }, createdAt: now() } }).catch((error) => {
        if (error.code === "P2002") throw mailError("MAIL_INVALID_TRANSITION", { reason: "DRY_RUN_ALREADY_EXECUTED" });
        throw error;
      });
      await enqueue(tx, created);
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_RETENTION_EXECUTION_REQUESTED", targetType: "mail_retention_run", targetId: created.id, organizationId: dryRun.organizationId, metadata: { dryRunId: dryRun.id, category: dryRun.category, action: dryRun.action, cutoff: dryRun.cutoff.toISOString(), dryRunCandidates: dryRun.counts?.candidates ?? null } }, context, tx);
      return created;
    });
    return serializeRun(run);
  }

  async function cancel(user, runId, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const run = policy.isUuid(runId) ? await client.mailRetentionRun.findUnique({ where: { id: runId } }) : null;
    if (!run) throw mailError("MAIL_NOT_FOUND", { resource: "retention_run" });
    const result = await client.mailRetentionRun.updateMany({ where: { id: run.id, status: { in: OPEN_STATUSES } }, data: { status: "CANCELLED", completedAt: now(), errorCode: "CANCELLED_BY_ADMIN" } });
    if (!result.count) throw mailError("MAIL_INVALID_TRANSITION", { from: run.status });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_RETENTION_RUN_CANCELLED", targetType: "mail_retention_run", targetId: run.id, organizationId: run.organizationId, metadata: { mode: run.mode } }, context);
    return serializeRun(await client.mailRetentionRun.findUnique({ where: { id: run.id } }));
  }

  async function list(user, { organizationId, limit } = {}) {
    await policy.requireMailAdmin(client, user, "VIEW");
    const rows = await client.mailRetentionRun.findMany({ where: policy.isUuid(organizationId) ? { organizationId } : {}, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(Number(limit) || 50, 1), 200) });
    return rows.map(serializeRun);
  }

  async function get(user, runId) {
    await policy.requireMailAdmin(client, user, "VIEW");
    const run = policy.isUuid(runId) ? await client.mailRetentionRun.findUnique({ where: { id: runId } }) : null;
    if (!run) throw mailError("MAIL_NOT_FOUND", { resource: "retention_run" });
    return serializeRun(run);
  }

  function capabilities() {
    return {
      executionEnabled: config.retention.executionEnabled,
      dryRunValidHours: config.retention.dryRunValidHours,
      systemCategories: Object.entries(SYSTEM_CATEGORIES).map(([category, meta]) => ({ category, action: meta.action, retainDays: config.retention.systemDays[category] })),
    };
  }

  return { startDryRun, execute, cancel, list, get, capabilities };
}

module.exports = { createRetentionService, serializeRun, SYSTEM_CATEGORIES };
