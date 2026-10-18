const { executionError } = require("../execution.errors");

function boundedRetryAfterAt(value, observedAt = new Date()) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  let date;
  if (/^\d{1,7}$/.test(text)) date = new Date(observedAt.getTime() + Math.min(Number(text), 3600) * 1000);
  else date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  const maximum = observedAt.getTime() + 3600 * 1000;
  return new Date(Math.min(Math.max(date.getTime(), observedAt.getTime()), maximum));
}

function decorate(error, { code, category, statusCode, outcomeCertain, providerProcessing, retryAfterAt, retryable }) {
  error.code = code;
  error.category = category;
  error.statusCode = statusCode || error.statusCode || error.status || 0;
  error.outcomeCertain = outcomeCertain;
  error.providerProcessing = providerProcessing;
  error.retryAfterAt = retryAfterAt;
  error.retryable = retryable;
  return error;
}

function normalizeProviderError(error, context = {}) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const category = String(error?.category || error?.code || error?.errors?.[0]?.code || "").toUpperCase();
  const observedAt = context.observedAt instanceof Date ? context.observedAt : new Date();
  const retryAfterAt = boundedRetryAfterAt(error?.retryAfterAt || error?.retryAfter || error?.response?.headers?.["retry-after"] || error?.response?.headers?.get?.("retry-after"), observedAt);
  const uncertain = error?.outcomeCertain === false || error?.outcomeUnknown === true || category.includes("UNKNOWN_OUTCOME") || category.includes("TIMEOUT_AFTER_SEND") || category.includes("TIMEOUT") && error?.providerProcessing !== "NOT_STARTED";
  const providerProcessing = uncertain ? "UNKNOWN" : error?.providerProcessing || "NOT_STARTED";
  const details = {
    provider: context.provider,
    operationId: context.operationId,
    providerCode: String(error?.providerCode || error?.code || "UNKNOWN").replace(/[^A-Z0-9_.:-]/gi, "").slice(0, 100),
    providerRequestId: String(error?.providerRequestId || error?.response?.headers?.["x-request-id"] || "").replace(/[^A-Z0-9_.:-]/gi, "").slice(0, 255) || undefined,
  };
  if (status === 429 || category.includes("RATE_LIMIT") || category.includes("QUOTA")) return decorate(executionError("EXECUTION_PROVIDER_RATE_LIMITED", { ...details, retryAfterAt: retryAfterAt?.toISOString() }), { code: "EXECUTION_PROVIDER_RATE_LIMITED", category: "RATE_LIMIT", statusCode: 429, outcomeCertain: true, providerProcessing, retryAfterAt, retryable: true });
  if ([401, 403].includes(status) || category.includes("PERMISSION") || category.includes("AUTH")) return decorate(executionError("EXECUTION_PROVIDER_PERMISSION_ERROR", details), { code: "EXECUTION_PROVIDER_PERMISSION_ERROR", category: "PERMISSION", statusCode: status || 403, outcomeCertain: true, providerProcessing, retryAfterAt: null, retryable: false });
  if (category.includes("PRECONDITION") || category.includes("STATE_CHANGED")) return decorate(executionError("EXECUTION_PRECONDITION_CHANGED", details), { code: "EXECUTION_PRECONDITION_CHANGED", category: "PRECONDITION", statusCode: status || 409, outcomeCertain: true, providerProcessing, retryAfterAt: null, retryable: false });
  if (category.includes("VALIDATION") || status === 400 || status === 422) return decorate(executionError("EXECUTION_VALIDATION_FAILED", details), { code: "EXECUTION_VALIDATION_FAILED", category: "VALIDATION", statusCode: status || 422, outcomeCertain: true, providerProcessing, retryAfterAt: null, retryable: false });
  if (category.includes("CAPABILITY")) return decorate(executionError("EXECUTION_CAPABILITY_UNAVAILABLE", details), { code: "EXECUTION_CAPABILITY_UNAVAILABLE", category: "CAPABILITY", statusCode: status || 409, outcomeCertain: true, providerProcessing, retryAfterAt: null, retryable: false });
  if (category.includes("DRIFT")) return decorate(executionError("EXECUTION_RECONCILIATION_DRIFT", details), { code: "EXECUTION_RECONCILIATION_DRIFT", category: "DRIFT", statusCode: status || 409, outcomeCertain: true, providerProcessing, retryAfterAt: null, retryable: false });
  if (uncertain) return decorate(executionError("EXECUTION_OUTCOME_UNKNOWN", details), { code: "EXECUTION_OUTCOME_UNKNOWN", category: "UNKNOWN", statusCode: status || 502, outcomeCertain: false, providerProcessing: "UNKNOWN", retryAfterAt: null, retryable: false });
  return decorate(executionError("PROVIDER_OPERATION_FAILED", { ...details, reasonCode: "PROVIDER_REQUEST_FAILED" }), { code: "PROVIDER_OPERATION_FAILED", category: status >= 500 ? "TRANSIENT" : "PROVIDER", statusCode: status || 502, outcomeCertain: true, providerProcessing, retryAfterAt, retryable: status >= 500 });
}

module.exports = { boundedRetryAfterAt, normalizeProviderError };
