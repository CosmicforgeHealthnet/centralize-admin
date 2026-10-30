const { executionError } = require("../execution.errors");
const {
  assertApprovalEligibility,
  assertActionAllowed,
  countEligibleApprovals,
} = require("../policy/execution-policy.service");
const { validateApprovalInput } = require("./approval.validator");
const { ApprovalRepository } = require("./approval.repository");

function createApprovalService({ repository = new ApprovalRepository() } = {}) {
  async function decide({ actor, plan, policy, input }) {
    if (plan.state !== "PENDING_APPROVAL") throw executionError("INVALID_PLAN_TRANSITION", { from: plan.state, to: input?.decision });
    const approval = validateApprovalInput(input);
    assertApprovalEligibility({ actor, plan, policy, approval });
    if (!repository) throw executionError("PERSISTENCE_NOT_IMPLEMENTED");
    return repository.create({
      planId: plan.id,
      actorId: actor.id,
      planVersion: approval.planVersion,
      validationFingerprint: approval.validationFingerprint,
      decision: approval.decision,
      reason: approval.reason || null,
      approvalScope: {
        provider: plan.provider,
        connectionId: plan.connectionId,
        currencyCode: plan.currencyCode,
        budgetLimit: plan.budgetLimit || 0,
        eligibleApprovalTiers: actor.eligibleApprovalTiers || [],
      },
    });
  }

  async function revoke({ actor, approval, reason }) {
    assertActionAllowed(actor, "REVOKE_APPROVAL");
    if (!approval || (approval.status || approval.decision) !== "APPROVED" || approval.active === false) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "APPROVAL_NOT_CURRENT" });
    if (!repository) throw executionError("PERSISTENCE_NOT_IMPLEMENTED");
    return repository.revoke(approval.id, actor.id, reason);
  }

  function approvalThresholdMet({ approvals, plan, policy }) {
    return countEligibleApprovals(approvals, plan) >= Math.max(1, Number(policy?.requiredApprovals || 1));
  }

  return { decide, revoke, approvalThresholdMet };
}

module.exports = { createApprovalService };
