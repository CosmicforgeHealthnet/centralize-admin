const { ACTOR_ROLES } = require("../execution.constants");
const { executionError } = require("../execution.errors");
const { validateEmergencyOverride } = require("./policy.validator");

const ROLE_ACTIONS = Object.freeze({
  VIEWER: Object.freeze(["READ"]),
  AUTHOR: Object.freeze(["READ", "CREATE_PLAN", "EDIT_PLAN", "VALIDATE_PLAN", "SUBMIT_PLAN"]),
  APPROVER: Object.freeze(["READ", "APPROVE_PLAN", "REJECT_PLAN", "REVOKE_APPROVAL"]),
  EXECUTION_ADMINISTRATOR: Object.freeze(["READ", "MANAGE_POLICY", "MANAGE_APPROVERS", "MANAGE_KILL_SWITCH", "EMERGENCY_OVERRIDE"]),
  SYSTEM_WORKER: Object.freeze(["CLAIM_JOB", "EXECUTE_OPERATION", "VERIFY_OPERATION", "PERSIST_RESULT"]),
  AUDITOR: Object.freeze(["READ", "READ_AUDIT", "READ_SANITIZED_EVIDENCE"]),
});

function actorRoles(actor) {
  const roles = Array.isArray(actor?.executionRoles) ? actor.executionRoles : [];
  return roles.filter((role) => ACTOR_ROLES.includes(role));
}

function assertActionAllowed(actor, action) {
  if (!actor || actor.status !== "ACTIVE") throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ACTOR_NOT_ACTIVE" });
  const allowed = actorRoles(actor).some((role) => ROLE_ACTIONS[role]?.includes(action));
  if (!allowed) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ROLE_ACTION_FORBIDDEN", action });
  return true;
}

function assertApprovalEligibility({ actor, plan, policy, approval }) {
  assertActionAllowed(actor, "APPROVE_PLAN");
  if (actorRoles(actor).includes("SYSTEM_WORKER")) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "WORKER_CANNOT_APPROVE" });
  if (!actor.hasEditPermission) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "EDIT_PERMISSION_REQUIRED" });
  if (!actor.eligibleProviders?.includes(plan.provider)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "PROVIDER_NOT_ELIGIBLE" });
  if (!actor.eligibleConnectionIds?.includes(plan.connectionId)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CONNECTION_NOT_ELIGIBLE" });
  if (!actor.eligibleCurrencies?.includes(plan.currencyCode)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CURRENCY_NOT_ELIGIBLE" });
  if (plan.approvalTier && !actor.eligibleApprovalTiers?.includes(plan.approvalTier)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "APPROVAL_TIER_NOT_ELIGIBLE" });
  if (Number(plan.budgetLimit || 0) > Number(actor.maximumApprovalAmount ?? -1)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "THRESHOLD_EXCEEDED" });
  if (approval.planVersion !== plan.version) throw executionError("PLAN_VERSION_CONFLICT", { expectedVersion: plan.version, actualVersion: approval.planVersion });
  if (!plan.validationFingerprint || approval.validationFingerprint !== plan.validationFingerprint) throw executionError("STALE_VALIDATION_FINGERPRINT");
  const requiredApprovals = Math.max(1, Number(policy?.requiredApprovals || 1));
  const canAuthorJoinMultiApproval = Boolean(policy?.allowAuthorAsNonSoleApprover) && requiredApprovals > 1;
  if (actor.id === plan.authorId && !canAuthorJoinMultiApproval) throw executionError("SELF_APPROVAL_FORBIDDEN");
  return true;
}

function countEligibleApprovals(approvals, plan) {
  const actorIds = new Set((approvals || []).filter((approval) => (
    (approval.status || approval.decision) === "APPROVED"
    && approval.active !== false
    && !(approval.events || []).some((event) => event.decision === "REVOKED")
    && approval.planVersion === plan.version
    && approval.validationFingerprint === plan.validationFingerprint
  )).map((approval) => approval.actorId || approval.approverAdminUserId));
  return actorIds.size;
}

async function authorizeEmergencyOverride({ actor, override, executionConfig, policy, auditWriter }) {
  assertActionAllowed(actor, "EMERGENCY_OVERRIDE");
  if (!["ADMIN", "SUPER"].includes(actor.tier)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ELEVATED_AUTHORIZATION_REQUIRED" });
  if (!actor.twoFactorEnabled) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "TWO_FACTOR_REQUIRED" });
  if (!policy?.emergencyOverrideAllowed) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "OVERRIDE_POLICY_DISABLED" });
  if (!executionConfig?.enabled) throw executionError("EXECUTION_DISABLED", { reasonCode: "GLOBAL_SWITCH_CANNOT_BE_BYPASSED" });
  const validated = validateEmergencyOverride(override);
  if (!auditWriter?.writeImmutable) throw executionError("PERSISTENCE_NOT_IMPLEMENTED", { reasonCode: "AUDIT_WRITER_REQUIRED" });
  await auditWriter.writeImmutable({ actorId: actor.id, action: "EMERGENCY_OVERRIDE_USED", ...validated });
  return validated;
}

module.exports = {
  ROLE_ACTIONS,
  actorRoles,
  assertActionAllowed,
  assertApprovalEligibility,
  countEligibleApprovals,
  authorizeEmergencyOverride,
};
