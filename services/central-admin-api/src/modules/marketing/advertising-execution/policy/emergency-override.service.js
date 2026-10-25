const { hasFreshVerifiedMfa, evidenceReference } = require("../../../../shared/auth/privileged-mfa");
const { isMfaEnrolled } = require("../../../../shared/auth/mfa-core");
const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionEvent } = require("../execution.observability");

const MAXIMUM_DURATION_MS = 2 * 60 * 60 * 1000;
const OVERRIDABLE_CONTROLS = Object.freeze(["CONNECTION_WRITE_GATE"]);
const NON_OVERRIDABLE_CONTROLS = Object.freeze([
  "PROVIDER_CAPABILITY", "VALID_CREDENTIALS", "SECRET_REDACTION", "AUDIT_IMMUTABILITY", "IDEMPOTENCY",
  "UNKNOWN_OUTCOME_NO_BLIND_RETRY", "REGULATED_CATEGORY_PROHIBITION", "PROVIDER_HOST_ALLOWLIST",
  "BEFORE_STATE_SAFETY", "GLOBAL_HARD_SHUTDOWN", "PROVIDER_HARD_SHUTDOWN",
]);

function safeControls(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== "CONNECTION_WRITE_GATE") throw executionError("INVALID_EXECUTION_PLAN", { field: "body.allowedControls", reasonCode: "UNSUPPORTED_OVERRIDE_CONTROL" });
  return [...OVERRIDABLE_CONTROLS];
}

async function loadExactScope(client, { planId, runId = null, operationId = null }) {
  const plan = await client.marketingExecutionPlan.findUnique({ where: { id: planId }, select: { id: true, platform: true, connectionId: true, accountExternalId: true } });
  if (!plan) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "OVERRIDE_PLAN_NOT_FOUND" });
  if (runId) {
    const run = await client.marketingExecutionRun.findFirst({ where: { id: runId, planId }, select: { id: true } });
    if (!run) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "OVERRIDE_RUN_SCOPE_MISMATCH" });
  }
  if (operationId) {
    const operation = await client.marketingProviderOperation.findFirst({ where: { id: operationId, run: { planId } }, select: { id: true, runId: true } });
    if (!operation || runId && operation.runId !== runId) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "OVERRIDE_OPERATION_SCOPE_MISMATCH" });
  }
  return plan;
}

function assertOverrideMatches(override, { actor, plan, now = new Date() }) {
  if (!override || override.status !== "ACTIVE" || override.revokedAt || override.startsAt > now || override.expiresAt <= now) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "EMERGENCY_OVERRIDE_INACTIVE_OR_EXPIRED" });
  if (!override.approvedByAdminUserId || !override.mfaEvidenceReference) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "EMERGENCY_OVERRIDE_APPROVAL_OR_MFA_REQUIRED" });
  if (!Array.isArray(override.allowedControls) || !override.allowedControls.includes("CONNECTION_WRITE_GATE")) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "OVERRIDE_CONTROL_NOT_ALLOWED" });
  if (override.planId !== plan.id || override.platform !== plan.platform || override.connectionId !== plan.connectionId || override.accountExternalId !== plan.accountExternalId) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "EMERGENCY_OVERRIDE_SCOPE_MISMATCH" });
  if (override.requestedByAdminUserId !== actor.id && actor.tier !== "SUPER") throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "EMERGENCY_OVERRIDE_ACTOR_MISMATCH" });
  const stillEnforced = Array.isArray(override.nonOverridableControls) ? override.nonOverridableControls : [];
  if (NON_OVERRIDABLE_CONTROLS.some((control) => !stillEnforced.includes(control))) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "NON_OVERRIDABLE_CONTROLS_INCOMPLETE" });
  return override;
}

async function consumeOverrideInTransaction(tx, { overrideId, actor, plan, correlationId = null, consume = true, now = new Date() }) {
  const override = await tx.marketingExecutionEmergencyOverride.findUnique({ where: { id: overrideId } });
  assertOverrideMatches(override, { actor, plan, now });
  if (!consume) return override;
  const changed = await tx.marketingExecutionEmergencyOverride.updateMany({ where: { id: override.id, status: "ACTIVE", expiresAt: { gt: now }, revokedAt: null, useCount: override.useCount }, data: { useCount: { increment: 1 } } });
  if (changed.count !== 1) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "EMERGENCY_OVERRIDE_CHANGED" });
  await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_OVERRIDE_USED", targetId: override.id, targetType: "marketing_execution_emergency_override", metadata: sanitizeExecutionEvent({ correlationId, overrideId: override.id, planId: plan.id, runId: override.runId, operationId: override.operationId, controlsBypassed: override.allowedControls, controlsStillEnforced: override.nonOverridableControls, reason: override.reason, expiresAt: override.expiresAt }) } });
  return { ...override, useCount: override.useCount + 1 };
}

function createEmergencyOverrideService({ client = prisma, events, now = () => new Date() } = {}) {
  async function create({ actor, input, correlationId = null }) {
    if (!actor?.id || actor.tier !== "SUPER") throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "SUPER_EMERGENCY_OPERATOR_REQUIRED" });
    // Verified enrollment (from the DB, not the token) AND a fresh step-up on this session.
    const currentActor = await client.adminUser.findUnique({ where: { id: actor.id }, select: { id: true, tier: true, status: true, mfaEnrolledAt: true, mfaSecretEncrypted: true } });
    if (!currentActor || currentActor.status !== "ACTIVE" || currentActor.tier !== "SUPER" || !isMfaEnrolled(currentActor)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CURRENT_MFA_CAPABLE_STATUS_REQUIRED" });
    if (!hasFreshVerifiedMfa(actor, { now: now().getTime() })) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "FRESH_MFA_STEP_UP_REQUIRED" });
    const startsAt = now(); const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= startsAt || expiresAt.getTime() - startsAt.getTime() > MAXIMUM_DURATION_MS) throw executionError("INVALID_EXECUTION_PLAN", { field: "body.expiresAt", reasonCode: "OVERRIDE_EXPIRY_MUST_BE_WITHIN_TWO_HOURS" });
    const reason = String(input.reason || "").trim();
    if (reason.length < 10 || reason.length > 2000) throw executionError("APPROVAL_REASON_REQUIRED", { reasonCode: "BOUNDED_OVERRIDE_REASON_REQUIRED" });
    const controls = safeControls(input.allowedControls);
    const scope = await loadExactScope(client, { planId: input.planId, runId: input.runId, operationId: input.operationId });
    const scopeType = input.operationId ? "OPERATION" : input.runId ? "RUN" : "PLAN";
    const row = await client.marketingExecutionEmergencyOverride.create({ data: { scopeType, platform: scope.platform, connectionId: scope.connectionId, accountExternalId: scope.accountExternalId, planId: scope.id, runId: input.runId || null, operationId: input.operationId || null, allowedControls: controls, nonOverridableControls: [...NON_OVERRIDABLE_CONTROLS], reason, requestedByAdminUserId: actor.id, approvedByAdminUserId: actor.id, mfaEvidenceReference: evidenceReference(actor), startsAt, expiresAt, status: "ACTIVE" } });
    await events?.emit("EMERGENCY_OVERRIDE_CONFIGURED", { correlationId, overrideId: row.id, planId: row.planId, expiresAt: row.expiresAt, status: row.status }, [actor.id]);
    return { id: row.id, scopeType: row.scopeType, planId: row.planId, runId: row.runId, operationId: row.operationId, allowedControls: row.allowedControls, controlsStillEnforced: row.nonOverridableControls, startsAt: row.startsAt, expiresAt: row.expiresAt, status: row.status, useCount: row.useCount };
  }
  return Object.freeze({ create });
}

module.exports = { MAXIMUM_DURATION_MS, OVERRIDABLE_CONTROLS, NON_OVERRIDABLE_CONTROLS, assertOverrideMatches, consumeOverrideInTransaction, createEmergencyOverrideService };
