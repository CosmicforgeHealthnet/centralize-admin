const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");

class ApprovalRepository {
  constructor({ client = prisma, now = () => new Date() } = {}) {
    this.client = client;
    this.now = now;
  }

  async create(data) {
    const decision = data.decision || data.status;
    if (["REJECTED", "REVOKED"].includes(decision) && !String(data.reason || "").trim()) {
      throw executionError("APPROVAL_REASON_REQUIRED");
    }
    return this.client.marketingExecutionApproval.create({
      data: {
        planId: data.planId,
        planVersion: data.planVersion,
        validationFingerprint: data.validationFingerprint,
        decision,
        approverAdminUserId: data.approverAdminUserId || data.actorId,
        reason: data.reason || null,
        approvalScope: sanitizeExecutionJson(data.approvalScope || {}, "approvalScope"),
        decidedAt: data.decidedAt || this.now(),
      },
    });
  }

  async listForPlan(planId) {
    return this.client.marketingExecutionApproval.findMany({
      where: { planId },
      include: { events: { orderBy: { decidedAt: "asc" } } },
      orderBy: { decidedAt: "asc" },
    });
  }

  async revoke(approvalId, actorId, reason) {
    if (!String(reason || "").trim()) throw executionError("APPROVAL_REASON_REQUIRED");
    const approval = await this.client.marketingExecutionApproval.findUnique({ where: { id: approvalId } });
    if (!approval || approval.approverAdminUserId !== actorId || approval.decision !== "APPROVED") {
      throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "APPROVAL_NOT_REVOCABLE" });
    }
    return this.client.marketingExecutionApprovalEvent.create({
      data: { approvalId, decision: "REVOKED", reason, decidedAt: this.now() },
    });
  }

  async invalidateForPlan() {
    return { count: 0, strategy: "VERSIONED_STALENESS" };
  }
}

module.exports = { ApprovalRepository };
