const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { requireActiveActor } = require("../actor-validation");
const { assertUuid } = require("../validation-security");

function createRecommendationLifecycleService({ prisma: db = prisma } = {}) {
  const transact = (operation) => db.$transaction ? db.$transaction(operation) : operation(db);
  const actor = (value) => typeof value === "string" ? { id: value } : value;
  async function transition(id, actorValue, { action, equivalent, allowed, data, metadata }) {
    assertUuid(id, "recommendationId");
    const admin = actor(actorValue);
    return transact(async (tx) => {
      await requireActiveActor(tx, admin);
      const row = await tx.marketing_recommendations.findUnique({ where: { id } });
      if (!row) throw new ApiError(404, "Marketing recommendation not found");
      if (equivalent(row)) return row;
      if (!allowed(row)) throw new ApiError(409, `Invalid recommendation lifecycle transition from ${row.status}`, [{ code: "RECOMMENDATION_LIFECYCLE_CONFLICT" }]);
      const previousStatus = row.status;
      const updated = await tx.marketing_recommendations.update({ where: { id }, data: data(admin) });
      if (tx.auditLog?.create) await tx.auditLog.create({ data: {
        adminUserId: admin.id, action, targetId: updated.id, targetType: "marketing_recommendation",
        metadata: { recommendationId: updated.id, recommendationType: updated.type, previousStatus, newStatus: updated.status, evidenceVersion: row.materialEvidenceFingerprint || null, timestamp: new Date().toISOString(), ...metadata },
        ipAddress: admin.ipAddress || null, userAgent: admin.userAgent || null,
      } });
      return updated;
    });
  }
  async function accept(id, adminUser) {
    return transition(id, adminUser, {
      action: "MARKETING_RECOMMENDATION_ACCEPTED",
      equivalent: (row) => row.status === "ACCEPTED",
      allowed: (row) => row.status === "PENDING",
      data: (admin) => ({ status: "ACCEPTED", acceptedAt: new Date(), acceptedByAdminUserId: admin.id }),
    });
  }
  async function dismiss(id, adminUser, reason) {
    return transition(id, adminUser, {
      action: "MARKETING_RECOMMENDATION_DISMISSED",
      equivalent: (row) => row.status === "DISMISSED" && row.dismissalReason === reason,
      allowed: (row) => row.status === "PENDING",
      data: (admin) => ({ status: "DISMISSED", dismissedAt: new Date(), dismissedByAdminUserId: admin.id, dismissalReason: reason }),
      metadata: { reason },
    });
  }
  return { accept, dismiss };
}
module.exports = { createRecommendationLifecycleService };
