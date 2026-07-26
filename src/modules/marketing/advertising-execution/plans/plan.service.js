const {
  PLAN_TRANSITIONS,
  TERMINAL_PLAN_STATES,
} = require("../execution.constants");
const { executionError } = require("../execution.errors");
const { validatePlanInput } = require("./plan.validator");
const { fingerprintPlan } = require("./plan-fingerprint");
const { PlanRepository } = require("./plan.repository");
const { ApprovalRepository } = require("../approvals/approval.repository");

function assertPlanTransition(plan, nextState, {
  compensationApproved = false,
  approvalThresholdMet = false,
  approvalPacketCurrent = false,
} = {}) {
  if (!plan || !PLAN_TRANSITIONS[plan.state]?.includes(nextState)) {
    throw executionError("INVALID_PLAN_TRANSITION", { from: plan?.state || null, to: nextState });
  }
  if (nextState === "ROLLBACK_PENDING" && !compensationApproved) {
    throw executionError("COMPENSATION_APPROVAL_REQUIRED", { from: plan.state, to: nextState });
  }
  if (nextState === "APPROVED" && !approvalThresholdMet) {
    throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "APPROVAL_THRESHOLD_NOT_MET" });
  }
  if (nextState === "QUEUED" && !approvalPacketCurrent) {
    throw executionError("STALE_VALIDATION_FINGERPRINT", { reasonCode: "CURRENT_APPROVAL_PACKET_REQUIRED" });
  }
  return true;
}

function transitionPlan(plan, nextState, options = {}) {
  assertPlanTransition(plan, nextState, options);
  return { ...plan, state: nextState };
}

function assertEditable(plan) {
  if (plan?.state !== "DRAFT") throw executionError("PLAN_NOT_EDITABLE", { state: plan?.state || null });
}

function assertEvidenceMutable(plan) {
  if ([...TERMINAL_PLAN_STATES, "FAILED", "PARTIAL_SUCCESS"].includes(plan?.state)) {
    throw executionError("EXECUTION_ALREADY_TERMINAL", { state: plan.state });
  }
}

function createPlanService({ repository = new PlanRepository(), approvalRepository = new ApprovalRepository() } = {}) {
  async function createDraft({ input, actor }) {
    if (!repository) throw executionError("PERSISTENCE_NOT_IMPLEMENTED");
    const normalized = validatePlanInput(input);
    return repository.create({ intent: normalized, state: "DRAFT", version: 1, authorId: actor.id });
  }

  async function editDraft({ plan, input, expectedVersion }) {
    assertEditable(plan);
    if (plan.version !== expectedVersion) throw executionError("PLAN_VERSION_CONFLICT", { expectedVersion, actualVersion: plan.version });
    const normalized = validatePlanInput(input);
    const next = {
      ...plan,
      intent: normalized,
      version: plan.version + 1,
      state: "DRAFT",
      validationFingerprint: null,
      validationSnapshot: null,
      validatedAt: null,
    };
    if (approvalRepository?.invalidateForPlan) await approvalRepository.invalidateForPlan(plan.id, "PLAN_MATERIAL_EDIT");
    if (!repository) throw executionError("PERSISTENCE_NOT_IMPLEMENTED");
    return repository.save(next);
  }

  function beginValidation(plan) {
    return transitionPlan(plan, "VALIDATING");
  }

  function completeValidation(plan) {
    if (plan.state !== "VALIDATING") throw executionError("INVALID_PLAN_TRANSITION", { from: plan.state, to: "VALIDATED" });
    const validated = validatePlanInput(plan.intent);
    const packet = fingerprintPlan(validated, plan.version);
    return {
      ...plan,
      state: "VALIDATED",
      validationFingerprint: packet.fingerprint,
      validationSnapshot: packet.normalizedSnapshot,
      validatedAt: new Date().toISOString(),
    };
  }

  function reopenValidatedForMaterialEdit(plan, input = plan.intent) {
    if (plan.state !== "VALIDATED") throw executionError("PLAN_NOT_EDITABLE", { state: plan.state });
    const normalized = validatePlanInput(input);
    return {
      ...transitionPlan(plan, "DRAFT"),
      intent: normalized,
      version: plan.version + 1,
      validationFingerprint: null,
      validationSnapshot: null,
      validatedAt: null,
      approvals: [],
    };
  }

  function cancel(plan) {
    if (plan.state === "EXECUTING") throw executionError("INVALID_PLAN_TRANSITION", { from: "EXECUTING", to: "CANCELLED", reconciliationRequired: true });
    return transitionPlan(plan, "CANCELLED");
  }

  return {
    createDraft, editDraft, beginValidation, completeValidation,
    reopenValidatedForMaterialEdit, cancel, transitionPlan, assertEvidenceMutable,
  };
}

module.exports = {
  assertPlanTransition,
  transitionPlan,
  assertEditable,
  assertEvidenceMutable,
  createPlanService,
};
