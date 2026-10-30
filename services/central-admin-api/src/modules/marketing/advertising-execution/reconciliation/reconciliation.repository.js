const { prisma } = require("../../../../shared/config/database");
const { Prisma } = require("../../../../generated/admin-client");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { executionError } = require("../execution.errors");

class ReconciliationRepository {
  constructor({ client = prisma, now = () => new Date() } = {}) { this.client = client; this.now = now; }
  async enqueue({ operationId, runId, planId, reason, providerIdentity = {}, priority = 0 }) {
    const data = { operationId, runId, planId, reason, status: "PENDING", providerIdentity: sanitizeExecutionJson(providerIdentity, "summary"), priority };
    try { return await this.client.marketingExecutionReconciliationJob.create({ data }); }
    catch (error) { if (error?.code !== "P2002") throw error; return this.client.marketingExecutionReconciliationJob.findFirst({ where: { operationId, reason, status: { in: ["PENDING", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"] } }, orderBy: { createdAt: "desc" } }); }
  }
  async claim({ owner, leaseSeconds = 60 }) {
    const now = this.now(); const expiry = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.client.$transaction((tx) => tx.$queryRaw(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM marketing_execution_reconciliation_jobs
        WHERE status IN ('PENDING','RETRY_SCHEDULED') AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        ORDER BY priority DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE marketing_execution_reconciliation_jobs job
        SET status='CLAIMED', lease_owner=${owner}, lease_expires_at=${expiry}, attempt_count=attempt_count+1, updated_at=${now}
        FROM candidate WHERE job.id=candidate.id RETURNING job.*
    `));
    return rows[0] || null;
  }
  async loadBundle(id) { return this.client.marketingExecutionReconciliationJob.findUnique({ where: { id }, include: { operation: { include: { item: true, snapshots: true, run: { include: { plan: true } } } }, run: true, plan: true } }); }
  async markRunning({ id, owner }) { return this.updateOwned({ id, owner, statuses: ["CLAIMED"], data: { status: "RUNNING" } }); }
  async heartbeat({ id, owner, leaseSeconds = 60 }) { return this.updateOwned({ id, owner, statuses: ["CLAIMED", "RUNNING"], data: { leaseExpiresAt: new Date(this.now().getTime() + leaseSeconds * 1000) } }); }
  async reschedule({ id, owner, nextAttemptAt, category }) { return this.updateOwned({ id, owner, statuses: ["RUNNING"], data: { status: "RETRY_SCHEDULED", nextAttemptAt, lastErrorCategory: category, leaseOwner: null, leaseExpiresAt: null } }); }
  async finish({ id, owner, status, category = null }) { if (!["SUCCEEDED", "ESCALATED", "FAILED"].includes(status)) throw executionError("INVALID_OPERATION_TRANSITION", { status }); return this.updateOwned({ id, owner, statuses: ["RUNNING"], data: { status, lastErrorCategory: category, completedAt: this.now(), escalatedAt: status === "ESCALATED" ? this.now() : null, leaseOwner: null, leaseExpiresAt: null } }); }
  async updateOwned({ id, owner, statuses, data }) { const result = await this.client.marketingExecutionReconciliationJob.updateMany({ where: { id, leaseOwner: owner, status: { in: statuses } }, data }); if (result.count !== 1) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "RECONCILIATION_LEASE_OWNER_MISMATCH" }); return this.client.marketingExecutionReconciliationJob.findUnique({ where: { id } }); }
}
module.exports = { ReconciliationRepository };
