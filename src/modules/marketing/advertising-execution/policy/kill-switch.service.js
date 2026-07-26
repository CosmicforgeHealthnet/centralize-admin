const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");

function createKillSwitchService({ client = prisma, policyRepository, audit, events, metrics } = {}) {
  async function change({ actor, policy, expectedVersion, enabled, reason, source = "ADMIN_API" }) {
    if (!actor?.id || !["SUPER", "ADMIN"].includes(actor.tier) || !String(reason || "").trim()) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ELEVATED_KILL_SWITCH_AUTHORIZATION_REQUIRED" });
    const activeJobs = await client.marketingExecutionJob.count({ where: { status: { in: ["CLAIMED", "RUNNING"] }, ...(policy.connectionId ? { connectionId: policy.connectionId } : {}), ...(policy.platform ? { platform: policy.platform } : {}) } });
    const previous = policy.enabled === true && policy.value === true;
    const updated = await policyRepository.update({ id: policy.id, expectedVersion, actorId: actor.id, valueType: "BOOLEAN", value: Boolean(enabled), enabled: true });
    const resultingAction = enabled ? "NEW_CLAIMS_MAY_PROCEED_AFTER_ALL_GATES" : "NEW_CLAIMS_AND_NOT_STARTED_MUTATIONS_BLOCKED";
    await audit.event({ actorId: actor.id, action: "MARKETING_EXECUTION_KILL_SWITCH_CHANGED", targetId: policy.id, targetType: "marketing_execution_policy", metadata: { scope: policy.scope, provider: policy.platform || null, connectionId: policy.connectionId || null, previousValue: previous, newValue: Boolean(enabled), reason, source, activeJobs, resultingAction, version: updated.version } });
    await events.emit("KILL_SWITCH_CHANGED", { policyId: policy.id, previous, enabled: Boolean(enabled), activeJobs, resultingAction });
    metrics.increment("killSwitchChanges");
    return { policy: updated, activeJobs, resultingAction };
  }
  return Object.freeze({ change });
}
module.exports = { createKillSwitchService };
