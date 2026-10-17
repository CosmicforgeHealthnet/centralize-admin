const ApiError = require("../../../shared/utils/ApiError");

const ERROR_DEFINITIONS = Object.freeze({
  MARKETING_INTELLIGENCE_PHASE2_DISABLED: { status: 503, retryable: false, message: "Marketing Intelligence Phase 2 is disabled" },
  PROVIDER_UNAVAILABLE: { status: 503, retryable: true, message: "The advertising provider is temporarily unavailable" },
  PROVIDER_PERMISSION_DENIED: { status: 403, retryable: false, message: "The advertising provider denied this operation" },
  TOKEN_REFRESH_FAILED: { status: 503, retryable: true, message: "Provider authorization could not be refreshed" },
  LOCK_CONFLICT: { status: 409, retryable: true, message: "The requested operation is already running" },
  LOCK_OWNERSHIP_LOST: { status: 409, retryable: true, message: "The operation lock was lost" },
  INSUFFICIENT_DATA: { status: 422, retryable: false, message: "There is not enough data for this operation" },
  INVALID_TRANSITION: { status: 409, retryable: false, message: "The requested lifecycle transition is invalid" },
  DUPLICATE_ACTION: { status: 409, retryable: false, message: "The requested action has already been completed" },
  PARTIAL_SUCCESS: { status: 200, retryable: true, message: "The operation completed with partial results" },
  VALIDATION_ERROR: { status: 400, retryable: false, message: "Validation failed" },
  NOT_FOUND: { status: 404, retryable: false, message: "The requested resource was not found" },
  FORBIDDEN: { status: 403, retryable: false, message: "You are not allowed to perform this operation" },
  RATE_LIMITED: { status: 429, retryable: true, message: "Too many requests" },
  STALE_VERSION: { status: 409, retryable: false, message: "The setting was modified by another request" },
  SETTING_INVALID: { status: 400, retryable: false, message: "The setting value is invalid" },
  TASK_INTEGRITY_CONFLICT: { status: 409, retryable: false, message: "The linked task is inconsistent" },
});

function marketingError(code, details = [], overrides = {}) {
  const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.VALIDATION_ERROR;
  const error = new ApiError(overrides.status || definition.status, overrides.message || definition.message, [{ code, ...overrides.detail }, ...details]);
  error.code = code;
  error.retryable = overrides.retryable ?? definition.retryable;
  return error;
}

module.exports = { ERROR_DEFINITIONS, marketingError };
