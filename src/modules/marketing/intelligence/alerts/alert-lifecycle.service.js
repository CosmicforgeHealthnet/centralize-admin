const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { requireActiveActor } = require("../actor-validation");
const { assertUuid } = require("../validation-security");

function createAlertLifecycleService({ prisma: db = prisma } = {}) {
  const transact = (operation) => db.$transaction ? db.$transaction(operation) : operation(db);
  const actor = (value) => typeof value === "string" ? { id: value } : value;
  async function transition(id, actorValue, { action, equivalent, allowed, data, metadata }) {
    assertUuid(id, "alertId");
    const admin = actor(actorValue);
    return transact(async (tx) => {
      await requireActiveActor(tx, admin);
      const alert = await tx.marketing_alerts.findUnique({ where: { id } });
      if (!alert) throw new ApiError(404, "Marketing alert not found");
      if (equivalent(alert)) return alert;
      if (!allowed(alert)) throw new ApiError(409, "Invalid alert lifecycle transition", [{ code: "ALERT_LIFECYCLE_CONFLICT" }]);
      const previousStatus = alert.status;
      const updated = await tx.marketing_alerts.update({ where: { id }, data: data(admin) });
      if (tx.auditLog?.create) await tx.auditLog.create({ data: {
        adminUserId: admin.id, action, targetId: updated.id, targetType: "marketing_alert",
        metadata: { alertId: updated.id, alertType: updated.type, previousStatus, newStatus: updated.status, timestamp: new Date().toISOString(), ...metadata },
        ipAddress: admin.ipAddress || null, userAgent: admin.userAgent || null,
      } });
      return updated;
    });
  }
  async function acknowledge(id, adminUser) {
    return transition(id, adminUser, {
      action: "MARKETING_ALERT_ACKNOWLEDGED",
      equivalent: (alert) => alert.status === "ACKNOWLEDGED",
      allowed: (alert) => alert.status === "OPEN",
      data: (admin) => ({ status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByAdminUserId: admin.id }),
    });
  }

  async function resolve(id, adminUser, reason) {
    return transition(id, adminUser, {
      action: "MARKETING_ALERT_RESOLVED",
      equivalent: (alert) => alert.status === "RESOLVED" && alert.resolutionReason === reason,
      allowed: (alert) => ["OPEN", "ACKNOWLEDGED"].includes(alert.status),
      data: (admin) => ({ status: "RESOLVED", resolvedAt: new Date(), resolvedByAdminUserId: admin.id, resolutionReason: reason }),
      metadata: { reason },
    });
  }
  return { acknowledge, resolve };
}

module.exports = { createAlertLifecycleService };
