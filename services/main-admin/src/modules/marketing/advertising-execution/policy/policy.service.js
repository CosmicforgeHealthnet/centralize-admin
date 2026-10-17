const { executionError } = require("../execution.errors");
const { PolicyRepository } = require("./policy.repository");
const { createAuditAdapter } = require("../integrations/audit.adapter");

function createPolicyService({ repository = new PolicyRepository(), audit = createAuditAdapter() } = {}) {
  async function update({ actor, policy, expectedVersion, valueType, value, enabled, reason }) {
    if (!actor || !["SUPER", "EXECUTIVE", "EXECUTION_ADMINISTRATOR"].includes(actor.tier || actor.role)) {
      throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ELEVATED_POLICY_AUTHORIZATION_REQUIRED" });
    }
    if (!String(reason || "").trim()) throw executionError("APPROVAL_REASON_REQUIRED");
    const changedFields = ["valueType", "value", "enabled"].filter((field) => field === "valueType" ? policy.valueType !== valueType : field === "enabled" ? policy.enabled !== Boolean(enabled) : JSON.stringify(policy.value) !== JSON.stringify(value));
    const updated = await repository.update({ id: policy.id, expectedVersion, actorId: actor.id, valueType, value, enabled, reason, changedFields, correlationId: actor.correlationId || null });
    await audit.writeImmutable({ actorId: actor.id, action: "MARKETING_EXECUTION_POLICY_UPDATED", reason, scope: { connectionId: policy.connectionId, policyId: policy.id, previousVersion: policy.version, newVersion: updated.version, changedFields }, controlsBypassed: [] });
    return updated;
  }
  return { update };
}

module.exports = { createPolicyService };
