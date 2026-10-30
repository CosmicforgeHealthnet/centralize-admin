const ApiError = require("../../../shared/utils/ApiError");
const { sanitizeExecutionEvent } = require("./execution.observability");

const STABLE_ERROR_DEFINITIONS = Object.freeze({
  AD_EXECUTION_DISABLED: Object.freeze({ status: 503, message: "Advertising execution is disabled" }),
  EXECUTION_PLAN_CONFLICT: Object.freeze({ status: 409, message: "Advertising execution plan version or fingerprint is stale" }),
  EXECUTION_VALIDATION_FAILED: Object.freeze({ status: 422, message: "Advertising execution validation failed" }),
  EXECUTION_APPROVAL_REQUIRED: Object.freeze({ status: 409, message: "Current approval requirements are not satisfied" }),
  EXECUTION_SELF_APPROVAL_FORBIDDEN: Object.freeze({ status: 403, message: "Separation of duties forbids self-approval" }),
  EXECUTION_BUDGET_POLICY_VIOLATION: Object.freeze({ status: 422, message: "Advertising spend guardrail was not satisfied" }),
  EXECUTION_CAPABILITY_UNAVAILABLE: Object.freeze({ status: 409, message: "Advertising provider or account capability is unavailable" }),
  EXECUTION_PRECONDITION_CHANGED: Object.freeze({ status: 409, message: "Advertising provider state changed after validation" }),
  EXECUTION_PROVIDER_RATE_LIMITED: Object.freeze({ status: 429, message: "Advertising provider rate limit was reached", retryable: true }),
  EXECUTION_PROVIDER_PERMISSION_ERROR: Object.freeze({ status: 403, message: "Advertising provider permission is unavailable" }),
  EXECUTION_OUTCOME_UNKNOWN: Object.freeze({ status: 502, message: "Advertising provider outcome is uncertain; reconciliation is required" }),
  EXECUTION_RECONCILIATION_DRIFT: Object.freeze({ status: 409, message: "Advertising provider state differs from the approved state" }),
});

const LEGACY_DEFINITIONS = Object.freeze({
  INVALID_PLAN_TRANSITION: [409, "Invalid advertising execution plan transition"],
  PLAN_NOT_EDITABLE: [409, "Advertising execution plan is not editable"],
  INVALID_OPERATION_TRANSITION: [409, "Invalid advertising operation transition"],
  INVALID_EXECUTION_CONFIG: [500, "Advertising execution configuration is invalid"],
  RAW_PROVIDER_PAYLOAD_FORBIDDEN: [400, "Raw provider mutation payloads are forbidden"],
  PERSISTENCE_NOT_IMPLEMENTED: [501, "Durable advertising execution persistence is not implemented"],
  APPROVAL_REASON_REQUIRED: [400, "An explicit written reason is required"],
  INVALID_EXECUTION_PLAN: [400, "Advertising execution request validation failed"],
  COMPENSATION_APPROVAL_REQUIRED: [403, "An approved compensation workflow is required"],
  IMMUTABLE_FIELD_CHANGE: [409, "Advertising resource immutable field change requires replacement"],
  BUDGET_POLICY_REQUIRED: [403, "Advertising budget policy is not configured for this connection"],
  APPROVAL_NOT_ELIGIBLE: [403, "Actor is not eligible for this advertising execution action"],
  EXECUTION_ALREADY_TERMINAL: [409, "Advertising execution is already terminal"],
  PLAN_VERSION_CONFLICT: [409, "Advertising execution plan version conflict"],
  STALE_VALIDATION_FINGERPRINT: [409, "Advertising execution validation fingerprint is stale"],
  SELF_APPROVAL_FORBIDDEN: [403, "Plan author cannot be the sole approver"],
  EXECUTION_DISABLED: [503, "Advertising execution is disabled"],
  PROVIDER_CAPABILITY_UNAVAILABLE: [503, "Advertising provider write capability is unavailable"],
  OPERATION_RETRY_NOT_SAFE: [409, "Advertising operation retry is not safe"],
  OPERATION_OUTCOME_UNKNOWN: [409, "Advertising operation outcome requires verification"],
  DIRECT_PROVIDER_EXECUTION_FORBIDDEN: [403, "Direct provider execution is forbidden"],
  PROVIDER_OPERATION_FAILED: [502, "Advertising provider request failed"],
});

const CODE_ALIASES = Object.freeze({
  PLAN_VERSION_CONFLICT: "EXECUTION_PLAN_CONFLICT",
  STALE_VALIDATION_FINGERPRINT: "EXECUTION_PLAN_CONFLICT",
  SELF_APPROVAL_FORBIDDEN: "EXECUTION_SELF_APPROVAL_FORBIDDEN",
  EXECUTION_DISABLED: "AD_EXECUTION_DISABLED",
  PROVIDER_CAPABILITY_UNAVAILABLE: "EXECUTION_CAPABILITY_UNAVAILABLE",
  OPERATION_RETRY_NOT_SAFE: "EXECUTION_PRECONDITION_CHANGED",
  OPERATION_OUTCOME_UNKNOWN: "EXECUTION_OUTCOME_UNKNOWN",
});

const DEFINITIONS = Object.freeze({
  ...Object.fromEntries(Object.entries(STABLE_ERROR_DEFINITIONS).map(([code, value]) => [code, [value.status, value.message]])),
  ...LEGACY_DEFINITIONS,
});

function executionError(requestedCode, details = {}, overrideMessage) {
  const code = requestedCode;
  const stable = STABLE_ERROR_DEFINITIONS[code];
  const legacy = LEGACY_DEFINITIONS[code];
  const status = stable?.status || legacy?.[0] || 500;
  const message = overrideMessage || stable?.message || legacy?.[1] || "Advertising execution error";
  const safeDetails = sanitizeExecutionEvent(details);
  const error = new ApiError(status, message, [{ code, retryable: stable?.retryable === true, ...safeDetails }]);
  error.code = code;
  error.statusCode = status;
  error.retryable = stable?.retryable === true;
  return error;
}

module.exports = { DEFINITIONS, STABLE_ERROR_DEFINITIONS, CODE_ALIASES, executionError };
