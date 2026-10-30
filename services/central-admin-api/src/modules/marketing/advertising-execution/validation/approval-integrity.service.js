const { executionError } = require("../execution.errors");

const TIER_RANK = { EMPLOYEE: 1, ADMIN: 2, EXECUTIVE: 3, SUPER: 4 };
function assertApprovalIntegrity({ plan, run, approvals = [], now = new Date() }) {
  if (!plan || !run || !["APPROVED", "QUEUED", "EXECUTING"].includes(plan.status)) throw executionError("STALE_VALIDATION_FINGERPRINT", { reasonCode: "PLAN_NOT_APPROVAL_QUALIFIED" });
  if (run.planId !== plan.id || run.approvedPlanVersion !== plan.version || run.approvalFingerprint !== plan.validationFingerprint) throw executionError("STALE_VALIDATION_FINGERPRINT", { reasonCode: "APPROVAL_PACKET_MISMATCH" });
  if (!plan.validationFingerprint || plan.expiresAt && plan.expiresAt <= now) throw executionError("STALE_VALIDATION_FINGERPRINT", { reasonCode: "APPROVAL_PACKET_EXPIRED" });
  const decision = (approval) => approval.events?.at(-1)?.decision || approval.decision;
  const current = approvals.filter((approval) => approval.planId === plan.id && approval.planVersion === plan.version && approval.validationFingerprint === plan.validationFingerprint && decision(approval) === "APPROVED");
  if (approvals.some((approval) => approval.planId === plan.id && approval.planVersion === plan.version && approval.validationFingerprint === plan.validationFingerprint && decision(approval) === "REJECTED")) throw executionError("EXECUTION_APPROVAL_REQUIRED", { reasonCode: "APPROVAL_REJECTED" });
  const policy = plan.desiredState?.approvalPolicy || {};
  const required = Math.max(1, Number(policy.requiredApprovals) || 1); const requiredTier = policy.requiredTier || "EMPLOYEE";
  const eligible = current.filter((approval) => approval.approverAdminUserId !== plan.createdByAdminUserId && (TIER_RANK[approval.approvalScope?.approverTier || approval.approvalScope?.tier || "EMPLOYEE"] || 0) >= TIER_RANK[requiredTier]);
  if (eligible.length < required) throw executionError("EXECUTION_APPROVAL_REQUIRED", { reasonCode: "REQUIRED_APPROVALS_NOT_MET", required, actual: eligible.length });
  for (const approval of eligible) {
    const scope = approval.approvalScope || {};
    if (scope.provider && scope.provider !== plan.platform || scope.connectionId && scope.connectionId !== plan.connectionId || scope.currencyCode && scope.currencyCode !== plan.currencyCode) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "APPROVAL_SCOPE_MISMATCH" });
  }
  return { required, approvals: eligible.map((approval) => approval.id), tier: requiredTier };
}
module.exports = { TIER_RANK, assertApprovalIntegrity };
