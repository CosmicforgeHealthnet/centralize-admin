const { prisma } = require("../../../../shared/config/database");
const { sanitizeExecutionEvent } = require("../execution.observability");

function createAuditAdapter({ client = prisma } = {}) {
  const adapter = {
    async event({ actorId, action, targetId, targetType = "marketing_advertising_execution", metadata = {} }) {
      return client.auditLog.create({ data: { adminUserId: actorId || null, action, targetId: targetId || null, targetType: String(targetType).slice(0, 255), metadata: sanitizeExecutionEvent(metadata) } });
    },
    async writeImmutable({ actorId, action, reason, scope, controlsBypassed }) {
      return adapter.event({ actorId, action, targetId: scope?.planId || scope?.connectionId || scope?.policyId || null, targetType: "marketing_ad_execution_override", metadata: { reason: String(reason || "").slice(0, 2000), scope, controlsBypassed } });
    },
  };
  return adapter;
}

module.exports = { createAuditAdapter };
