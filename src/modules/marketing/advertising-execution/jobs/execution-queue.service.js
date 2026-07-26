const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionEvent } = require("../execution.observability");
const { assertApprovalIntegrity } = require("../validation/approval-integrity.service");
const { operationIdentity, createProviderOperationKey } = require("../operations/idempotency.service");
const { ExecutionRunRepository } = require("../runs/execution-run.repository");
const { ExecutionJobRepository } = require("./execution-job.repository");
const { OperationRepository } = require("../operations/operation.repository");
const { consumeOverrideInTransaction } = require("../policy/emergency-override.service");

function assertQueuePacket(plan, { expectedVersion, fingerprint, now, policyEvidence }) {
  if (!plan || !["APPROVED", "QUEUED"].includes(plan.status)) throw executionError("EXECUTION_APPROVAL_REQUIRED", { reasonCode: "APPROVED_PLAN_REQUIRED" });
  if (plan.version !== expectedVersion || plan.validationFingerprint !== fingerprint) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "CURRENT_APPROVED_PACKET_REQUIRED" });
  const packet = plan.validationPackets?.[0];
  if (!packet || !packet.valid || packet.planVersion !== plan.version || packet.validationFingerprint !== fingerprint) throw executionError("EXECUTION_VALIDATION_FAILED", { reasonCode: "VALIDATION_PACKET_REQUIRED" });
  if (plan.expiresAt && plan.expiresAt <= now || packet.expiresAt <= now) throw executionError("EXECUTION_APPROVAL_REQUIRED", { reasonCode: "APPROVAL_PACKET_EXPIRED" });
  if (policyEvidence?.capabilityValid !== true) throw executionError("EXECUTION_CAPABILITY_UNAVAILABLE", { reasonCode: "QUEUE_CAPABILITY_NOT_CURRENT" });
  if (policyEvidence?.globalEnabled !== true || policyEvidence?.providerEnabled !== true || policyEvidence?.connectionWriteEnabled !== true) throw executionError("AD_EXECUTION_DISABLED", { reasonCode: "QUEUE_EXECUTION_GATE_DISABLED" });
  return packet;
}

function createExecutionQueueService({ client = prisma, audit, events, metrics, failureInjector = null, now = () => new Date() } = {}) {
  async function inject(point, context) { if (failureInjector) await failureInjector(point, context); }

  async function queue({ planId, actor, trigger = "MANUAL", expectedVersion, fingerprint, policyEvidence = {}, correlationId = null, overrideId = null }) {
    if (!actor?.id) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "AUTHENTICATED_ACTOR_REQUIRED" });
    const execute = () => client.$transaction(async (tx) => {
      if (typeof tx.$queryRawUnsafe === "function") await tx.$queryRawUnsafe("SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS guard", String(planId));
      const plan = await tx.marketingExecutionPlan.findUnique({
        where: { id: planId },
        include: {
          approvals: { include: { events: { orderBy: { decidedAt: "asc" } } } },
          items: { orderBy: { sequence: "asc" } },
          validationPackets: { where: { planVersion: expectedVersion, validationFingerprint: fingerprint }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      const packet = assertQueuePacket(plan, { expectedVersion, fingerprint, now: now(), policyEvidence });
      if (overrideId) await consumeOverrideInTransaction(tx, { overrideId, actor, plan, correlationId, consume: false, now: now() });
      const effectiveTrigger = plan.sourceType === "ROLLBACK" ? "COMPENSATION" : trigger;
      const runInput = { planId: plan.id, approvedPlanVersion: plan.version, approvalFingerprint: plan.validationFingerprint, trigger: effectiveTrigger };
      const approval = assertApprovalIntegrity({ plan, run: runInput, approvals: plan.approvals, now: now() });
      const runRepository = new ExecutionRunRepository({ client: tx });
      const operationRepository = new OperationRepository({ client: tx, now });
      const jobRepository = new ExecutionJobRepository({ client: tx, now });
      const { run, created } = await runRepository.createIdempotent(runInput);
      const usedOverride = overrideId && created ? await consumeOverrideInTransaction(tx, { overrideId, actor, plan, correlationId, consume: true, now: now() }) : null;
      await inject("after-run", { plan, run });
      let firstOperationId = null;
      if (created) {
        for (const item of plan.items) {
          const identity = operationIdentity({ version: 2, provider: plan.platform, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId, approvedPlanId: plan.id, approvedPlanVersion: plan.version, itemId: item.id, operationType: item.operationType, resourceType: item.resourceType, materialHash: item.materialHash });
          const operation = await operationRepository.createOperation({ runId: run.id, itemId: item.id, providerOperationKey: createProviderOperationKey(identity), idempotencyIdentity: identity, status: "READY", safeToRetry: false, outcomeCertainty: "UNKNOWN" });
          firstOperationId ||= operation.id;
          await inject("after-operation", { plan, run, operation });
          await operationRepository.createSnapshot({ operationId: operation.id, kind: "BEFORE", normalizedState: item.beforeState || { exists: false } });
          await operationRepository.createSnapshot({ operationId: operation.id, kind: "DESIRED", normalizedState: item.intent });
          await inject("after-snapshots", { plan, run, operation });
        }
        await inject("after-operations", { plan, run });
        if (plan.sourceType === "ROLLBACK") {
          await tx.marketingExecutionCompensationLink.update({ where: { compensationPlanId: plan.id }, data: { compensationRunId: run.id, compensationOperationId: firstOperationId } });
          await inject("after-compensation-link", { plan, run });
        }
      }
      const job = await jobRepository.create({ runId: run.id, connectionId: plan.connectionId, platform: plan.platform, accountExternalId: plan.accountExternalId, purpose: "PRIMARY" });
      await inject("after-job", { plan, run, job });
      if (plan.status === "APPROVED") {
        const changed = await tx.marketingExecutionPlan.updateMany({ where: { id: plan.id, version: plan.version, status: "APPROVED", validationFingerprint: fingerprint }, data: { status: "QUEUED" } });
        if (changed.count !== 1) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "QUEUE_PLAN_STATE_CHANGED" });
      }
      await tx.marketingExecutionRun.update({ where: { id: run.id }, data: { status: "QUEUED", summary: sanitizeExecutionEvent({ correlationId, approvalCount: approval.approvals.length, requiredTier: approval.tier, budgetExposure: String(packet.budgetExposure), activationExposure: packet.activationExposure }) } });
      await inject("before-audit", { plan, run, job });
      if (created) await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_QUEUED", targetId: job.id, targetType: "marketing_execution_job", metadata: sanitizeExecutionEvent({ correlationId, planId: plan.id, runId: run.id, jobId: job.id, trigger: effectiveTrigger, approvedPlanVersion: plan.version, fingerprint, budgetExposure: String(packet.budgetExposure), activationExposure: packet.activationExposure }) } });
      await inject("before-commit", { plan, run, job });
      return { planId: plan.id, run, job, created, platform: plan.platform, recipients: [plan.createdByAdminUserId], usedOverride };
    }, { isolationLevel: "Serializable" });
    let result;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { result = await execute(); break; }
      catch (error) { if (error?.code !== "P2034" || attempt === 3) throw error; }
    }
    if (result.created) {
      metrics?.increment("plansQueued", 1, { provider: result.platform });
      await events?.emit(result.run.trigger === "COMPENSATION" ? "COMPENSATION_QUEUED" : "JOB_QUEUED", { correlationId, jobId: result.job.id, runId: result.run.id, planId: result.planId, platform: result.platform }, result.recipients);
      if (result.usedOverride) await events?.emit("EMERGENCY_OVERRIDE_USED", { correlationId, overrideId: result.usedOverride.id, planId: result.planId, runId: result.run.id, controlsBypassed: result.usedOverride.allowedControls, expiresAt: result.usedOverride.expiresAt }, [actor.id]);
    } else metrics?.increment("idempotentDuplicates", 1, { provider: result.platform });
    return result;
  }
  return Object.freeze({ queue });
}

module.exports = { assertQueuePacket, createExecutionQueueService };
