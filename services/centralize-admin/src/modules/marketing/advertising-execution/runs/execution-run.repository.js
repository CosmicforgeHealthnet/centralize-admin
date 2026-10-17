const { prisma } = require("../../../../shared/config/database");
const { sanitizeExecutionJson, canonicalJson } = require("../execution-json.validator");
const crypto = require("crypto");

function submissionIdentity({ planId, approvedPlanVersion, approvalFingerprint, trigger, originalOperationId = null }) {
  return crypto.createHash("sha256").update(canonicalJson({ version: 2, planId: String(planId).toLowerCase(), approvedPlanVersion: Number(approvedPlanVersion), approvalFingerprint: String(approvalFingerprint).toLowerCase(), trigger: String(trigger).toUpperCase(), originalOperationId: originalOperationId ? String(originalOperationId).toLowerCase() : null })).digest("hex");
}

function submissionKey(planIdOrInput, approvalFingerprint) {
  return submissionIdentity(typeof planIdOrInput === "object" ? planIdOrInput : { planId: planIdOrInput, approvedPlanVersion: 1, approvalFingerprint, trigger: "MANUAL" });
}

class ExecutionRunRepository {
  constructor({ client = prisma } = {}) { this.client = client; }
  async create(input) {
    const key = submissionIdentity(input);
    return this.client.marketingExecutionRun.create({ data: {
      planId: input.planId, submissionKey: key, trigger: input.trigger, approvalFingerprint: input.approvalFingerprint,
      approvedPlanVersion: input.approvedPlanVersion, status: "QUEUED", summary: input.summary == null ? null : sanitizeExecutionJson(input.summary, "summary"),
    } });
  }
  async createIdempotent(input) {
    const key = submissionIdentity(input);
    const existing = await this.client.marketingExecutionRun.findUnique({ where: { submissionKey: key } });
    if (existing) return { run: existing, created: false };
    if (typeof this.client.marketingExecutionRun.upsert !== "function") { try { return { run: await this.create(input), created: true }; } catch (error) { if (error?.code !== "P2002") throw error; return { run: await this.client.marketingExecutionRun.findUnique({ where: { submissionKey: key } }), created: false }; } }
    const run = await this.client.marketingExecutionRun.upsert({ where: { submissionKey: key }, update: {}, create: { planId: input.planId, submissionKey: key, trigger: input.trigger, approvalFingerprint: input.approvalFingerprint, approvedPlanVersion: input.approvedPlanVersion, status: "QUEUED", summary: input.summary == null ? null : sanitizeExecutionJson(input.summary, "summary") } });
    return { run, created: true };
  }
  async updateStatus({ id, fromStatus, status, summary, startedAt, completedAt }) {
    return this.client.marketingExecutionRun.updateMany({ where: { id, status: fromStatus }, data: { status, ...(summary !== undefined ? { summary: sanitizeExecutionJson(summary, "summary") } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(completedAt !== undefined ? { completedAt } : {}) } });
  }
}

module.exports = { submissionIdentity, submissionKey, ExecutionRunRepository };
