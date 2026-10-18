const { OPERATION_TRANSITIONS } = require("../execution.constants");
const { executionError } = require("../execution.errors");

function transitionOperation(operation, nextState, options = {}) {
  if (!operation || !OPERATION_TRANSITIONS[operation.state]?.includes(nextState)) {
    throw executionError("INVALID_OPERATION_TRANSITION", { from: operation?.state || null, to: nextState });
  }
  if (operation.state === "UNKNOWN" && nextState !== "VERIFYING") throw executionError("OPERATION_OUTCOME_UNKNOWN");
  if (operation.state === "FAILED" && nextState === "RETRY_SCHEDULED" && (!options.retryable || !options.safe)) {
    throw executionError("OPERATION_RETRY_NOT_SAFE", { retryable: Boolean(options.retryable), safe: Boolean(options.safe) });
  }
  return { ...operation, state: nextState };
}

function scheduleRetry(operation, classification = {}) {
  if (operation?.state === "UNKNOWN") throw executionError("OPERATION_OUTCOME_UNKNOWN");
  return transitionOperation(operation, "RETRY_SCHEDULED", classification);
}

function appendEvidence(operation, evidence) {
  if (["VERIFIED", "DRIFTED"].includes(operation?.state)) throw executionError("EXECUTION_ALREADY_TERMINAL", { state: operation.state });
  return { ...operation, evidence: [...(operation.evidence || []), Object.freeze({ ...evidence })] };
}

function deleteEvidence() {
  throw executionError("EXECUTION_ALREADY_TERMINAL", { reasonCode: "EVIDENCE_IMMUTABLE" });
}

module.exports = { transitionOperation, scheduleRetry, appendEvidence, deleteEvidence };
