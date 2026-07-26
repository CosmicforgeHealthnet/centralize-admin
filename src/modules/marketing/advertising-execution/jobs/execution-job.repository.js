const crypto = require("crypto");
const { prisma } = require("../../../../shared/config/database");
const { Prisma } = require("../../../../generated/admin-client");
const { executionError } = require("../execution.errors");

function boundedLimit(value, fallback, maximum) { return Math.min(Math.max(Number(value) || fallback, 1), maximum); }
function jobSubmissionIdentity(runId, purpose = "PRIMARY") { return crypto.createHash("sha256").update(JSON.stringify({ version: 1, runId: String(runId).toLowerCase(), purpose: String(purpose).toUpperCase() })).digest("hex"); }

class ExecutionJobRepository {
  constructor({ client = prisma, now = () => new Date(), maximumAttempts = 5 } = {}) { this.client = client; this.now = now; this.maximumAttempts = maximumAttempts; }

  async create({ runId, connectionId, platform, accountExternalId, nextAttemptAt = null, priority = 0, purpose = "PRIMARY" }) {
    let scope = { connectionId, platform, accountExternalId };
    if ((!connectionId || !platform || !accountExternalId) && this.client.marketingExecutionRun?.findUnique) {
      const run = await this.client.marketingExecutionRun.findUnique({ where: { id: runId }, select: { plan: { select: { connectionId: true, platform: true, accountExternalId: true } } } });
      scope = run?.plan || scope;
    }
    if (!scope.connectionId || !scope.platform || !scope.accountExternalId) throw executionError("INVALID_EXECUTION_PLAN", { field: "runId", reasonCode: "JOB_ACCOUNT_SCOPE_REQUIRED" });
    const submissionIdentity = jobSubmissionIdentity(runId, purpose);
    if (typeof this.client.marketingExecutionJob.upsert !== "function") { try { return await this.client.marketingExecutionJob.create({ data: { runId, ...scope, submissionIdentity, status: "PENDING", nextAttemptAt, attemptCount: 0, priority } }); } catch (error) { if (error?.code !== "P2002") throw error; return this.client.marketingExecutionJob.findUnique({ where: { submissionIdentity } }); } }
    return this.client.marketingExecutionJob.upsert({ where: { submissionIdentity }, update: {}, create: { runId, ...scope, submissionIdentity, status: "PENDING", nextAttemptAt, attemptCount: 0, priority } });
  }

  async findExpiredLeases({ limit = 100 } = {}) { return this.client.marketingExecutionJob.findMany({ where: { status: { in: ["CLAIMED", "RUNNING"] }, leaseExpiresAt: { lt: this.now() } }, include: { run: { include: { operations: true } } }, orderBy: { leaseExpiresAt: "asc" }, take: boundedLimit(limit, 100, 500) }); }
  async findEligible({ limit = 20 } = {}) { return this.client.marketingExecutionJob.findMany({ where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: this.now() } }] }, orderBy: [{ priority: "desc" }, { nextAttemptAt: "asc" }, { createdAt: "asc" }], take: boundedLimit(limit, 20, 100) }); }

  async recoverExpiredLeases({ reconciliationRepository, audit } = {}) {
    const expired = await this.findExpiredLeases();
    const results = [];
    for (const job of expired) {
      const hasUnknown = job.run.operations.some((operation) => operation.status === "UNKNOWN" || operation.outcomeCertainty === "UNKNOWN" && operation.status === "EXECUTING");
      const knownSuccessIncomplete = job.run.operations.some((operation) => ["SUCCEEDED", "VERIFYING"].includes(operation.status));
      const exhausted = job.attemptCount >= this.maximumAttempts;
      const outcome = exhausted ? "ATTEMPTS_EXHAUSTED" : hasUnknown || knownSuccessIncomplete ? "RECONCILIATION_REQUIRED" : job.status === "CLAIMED" ? "SAFE_TO_RETRY" : "NON_RETRYABLE";
      const nextStatus = outcome === "SAFE_TO_RETRY" ? "RETRY_SCHEDULED" : outcome === "RECONCILIATION_REQUIRED" ? "RECONCILING" : outcome === "ATTEMPTS_EXHAUSTED" ? "DEAD_LETTER" : "FAILED";
      const recovered = await this.client.$transaction(async (tx) => {
        const updated = await tx.marketingExecutionJob.updateMany({ where: { id: job.id, leaseOwner: job.leaseOwner, status: job.status, leaseExpiresAt: { lt: this.now() } }, data: { status: nextStatus, nextAttemptAt: nextStatus === "RETRY_SCHEDULED" ? this.now() : null, recoveryReason: `EXPIRED_${job.status}_${outcome}`, previousLeaseOwner: job.leaseOwner, recoveredAt: this.now(), recoveryOutcome: outcome, reconciliationRequired: outcome === "RECONCILIATION_REQUIRED", leaseOwner: null, leaseExpiresAt: null } });
        if (updated.count !== 1) return null;
        if (nextStatus === "DEAD_LETTER") await tx.marketingExecutionDeadLetterReview.upsert({ where: { jobId: job.id }, create: { jobId: job.id }, update: {} });
        return tx.marketingExecutionJob.findUnique({ where: { id: job.id } });
      });
      if (!recovered) continue;
      if (outcome === "RECONCILIATION_REQUIRED" && reconciliationRepository) for (const operation of job.run.operations.filter((entry) => entry.status === "UNKNOWN" || ["SUCCEEDED", "VERIFYING"].includes(entry.status))) await reconciliationRepository.enqueue({ operationId: operation.id, runId: job.runId, planId: job.run.planId, reason: operation.status === "UNKNOWN" ? "UNKNOWN_PROVIDER_OUTCOME" : "POST_WRITE_VERIFICATION", providerIdentity: { providerRequestId: operation.providerRequestId, nativeResourceId: operation.nativeResourceId } });
      if (audit) await audit.event({ actorId: null, action: "MARKETING_EXECUTION_LEASE_RECOVERED", targetId: job.id, targetType: "marketing_execution_job", metadata: { outcome, previousLeaseOwner: job.leaseOwner, status: nextStatus } });
      results.push(recovered);
    }
    return results;
  }

  async claimEligibleApproved({ leaseOwner, leaseSeconds = 60, limit = 1, enabledProviders = [] }) {
    if (!String(leaseOwner || "").trim()) throw executionError("INVALID_EXECUTION_PLAN", { field: "leaseOwner", reasonCode: "LEASE_OWNER_REQUIRED" });
    if (!enabledProviders.length) return [];
    const take = boundedLimit(limit, 1, 20); const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + Math.min(Math.max(Number(leaseSeconds) || 60, 15), 900) * 1000);
    return this.client.$transaction((tx) => tx.$queryRaw(Prisma.sql`
      WITH candidates AS (
        SELECT job.id
        FROM marketing_execution_jobs job
        JOIN marketing_execution_runs run ON run.id = job.run_id
        JOIN marketing_execution_plans plan ON plan.id = run.plan_id
        WHERE job.status IN ('PENDING', 'RETRY_SCHEDULED')
          AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${now})
          AND plan.status IN ('APPROVED', 'QUEUED', 'EXECUTING')
          AND run.approved_plan_version = plan.version
          AND run.approval_fingerprint = plan.validation_fingerprint
          AND plan.validation_fingerprint IS NOT NULL
          AND (plan.expires_at IS NULL OR plan.expires_at > ${now})
          AND job.platform::text IN (${Prisma.join(enabledProviders)})
          AND job.connection_id = plan.connection_id AND job.platform = plan.platform AND job.account_external_id = plan.account_external_id
          AND (SELECT count(*) FROM marketing_execution_approvals approval
               WHERE approval.plan_id = plan.id AND approval.plan_version = plan.version
                 AND approval.validation_fingerprint = plan.validation_fingerprint AND approval.decision = 'APPROVED'
                 AND approval.approver_admin_user_id <> plan.created_by_admin_user_id) >=
              GREATEST(1, COALESCE((plan.desired_state #>> '{approvalPolicy,requiredApprovals}')::integer, 1))
          AND NOT EXISTS (SELECT 1 FROM marketing_execution_approvals approval
                          WHERE approval.plan_id = plan.id AND approval.plan_version = plan.version
                            AND approval.validation_fingerprint = plan.validation_fingerprint
                            AND approval.decision IN ('REJECTED', 'REVOKED'))
          AND NOT EXISTS (SELECT 1 FROM marketing_execution_jobs active
                          WHERE active.platform = job.platform AND active.connection_id = job.connection_id
                            AND active.account_external_id = job.account_external_id AND active.id <> job.id
                            AND active.status IN ('CLAIMED', 'RUNNING'))
        ORDER BY job.priority DESC, job.created_at ASC
        FOR UPDATE OF job SKIP LOCKED LIMIT ${take}
      )
      UPDATE marketing_execution_jobs job
      SET status = 'CLAIMED', lease_owner = ${leaseOwner}, lease_expires_at = ${leaseExpiresAt},
          attempt_count = attempt_count + 1, updated_at = ${now}
      FROM candidates WHERE job.id = candidates.id RETURNING job.*
    `));
  }

  async loadExecutionBundle(id) { return this.client.marketingExecutionJob.findUnique({ where: { id }, include: { run: { include: { plan: { include: { approvals: true, items: true, connection: true } }, operations: { include: { item: true, attempts: { orderBy: { number: "desc" }, take: 1 }, snapshots: true } } } } } }); }
  async markRunningOwned({ id, leaseOwner }) { return this.updateOwned({ id, leaseOwner, statuses: ["CLAIMED"], data: { status: "RUNNING" } }); }
  async heartbeatOwned({ id, leaseOwner, leaseSeconds = 60 }) { return this.updateOwned({ id, leaseOwner, statuses: ["CLAIMED", "RUNNING"], data: { leaseExpiresAt: new Date(this.now().getTime() + Math.min(Math.max(Number(leaseSeconds) || 60, 15), 900) * 1000) } }); }
  async scheduleRetryOwned({ id, leaseOwner, nextAttemptAt }) { return this.updateOwned({ id, leaseOwner, statuses: ["RUNNING"], data: { status: "RETRY_SCHEDULED", nextAttemptAt, leaseOwner: null, leaseExpiresAt: null } }); }
  async releaseOwned({ id, leaseOwner, reason }) { return this.updateOwned({ id, leaseOwner, statuses: ["CLAIMED"], data: { status: "PENDING", recoveryReason: reason || null, leaseOwner: null, leaseExpiresAt: null } }); }
  async observeCancellationOwned({ id, leaseOwner }) {
    return this.client.$transaction(async (tx) => {
      const job = await tx.marketingExecutionJob.findFirst({ where: { id, leaseOwner, status: "CLAIMED", cancellationRequestedAt: { not: null } }, include: { run: true } });
      if (!job) return null;
      const observedAt = this.now();
      const updated = await tx.marketingExecutionJob.updateMany({ where: { id, leaseOwner, status: "CLAIMED", cancellationRequestedAt: job.cancellationRequestedAt }, data: { status: "CANCELLED", cancellationObservedAt: observedAt, cancellationOutcome: "CANCELLED_BEFORE_PROVIDER_MUTATION", completedAt: observedAt, recoveryReason: "USER_CANCELLATION_OBSERVED", leaseOwner: null, leaseExpiresAt: null } });
      if (updated.count !== 1) return null;
      await tx.marketingExecutionRun.updateMany({ where: { id: job.runId, status: "QUEUED" }, data: { status: "CANCELLED", completedAt: observedAt } });
      await tx.marketingExecutionPlan.updateMany({ where: { id: job.run.planId, status: "QUEUED" }, data: { status: "CANCELLED" } });
      return tx.marketingExecutionJob.findUnique({ where: { id } });
    });
  }
  async markReconcilingOwned({ id, leaseOwner, reason }) { return this.updateOwned({ id, leaseOwner, statuses: ["RUNNING"], data: { status: "RECONCILING", recoveryReason: reason, reconciliationRequired: true, leaseOwner: null, leaseExpiresAt: null } }); }
  async updateOwned({ id, leaseOwner, statuses, data }) { const updated = await this.client.marketingExecutionJob.updateMany({ where: { id, leaseOwner, status: { in: statuses } }, data }); if (updated.count !== 1) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "LEASE_OWNER_MISMATCH" }); return this.client.marketingExecutionJob.findUnique({ where: { id } }); }
  async completeOwned({ id, leaseOwner, status, runStatus = status }) {
    if (!["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(status)) throw executionError("INVALID_OPERATION_TRANSITION", { status });
    if (!["SUCCEEDED", "FAILED", "PARTIAL_SUCCESS"].includes(runStatus)) runStatus = status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
    return this.client.$transaction(async (tx) => { const completedAt = this.now(); const job = await tx.marketingExecutionJob.findFirst({ where: { id, leaseOwner, status: "RUNNING" }, include: { run: { include: { plan: true } } } }); if (!job) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "LEASE_OWNER_MISMATCH" }); const updated = await tx.marketingExecutionJob.updateMany({ where: { id, leaseOwner, status: "RUNNING" }, data: { status, completedAt, leaseOwner: null, leaseExpiresAt: null } }); if (updated.count !== 1) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "LEASE_OWNER_MISMATCH" }); await tx.marketingExecutionRun.update({ where: { id: job.runId }, data: { status: runStatus, completedAt } }); const planStatus = job.run.plan.sourceType === "ROLLBACK" ? runStatus === "SUCCEEDED" ? "ROLLED_BACK" : "ROLLBACK_FAILED" : runStatus; await tx.marketingExecutionPlan.update({ where: { id: job.run.planId }, data: { status: planStatus } }); if (status === "DEAD_LETTER") await tx.marketingExecutionDeadLetterReview.upsert({ where: { jobId: id }, create: { jobId: id }, update: {} }); return tx.marketingExecutionJob.findUnique({ where: { id } }); });
  }
}

module.exports = { boundedLimit, jobSubmissionIdentity, ExecutionJobRepository };
