const { executionError } = require("../execution.errors");

function boundedBackoff(attempt, { baseMs = 1000, maximumMs = 300000, jitterRatio = 0 } = {}) {
  const count = Math.min(Math.max(Number(attempt) || 1, 1), 20);
  const raw = Math.min(baseMs * 2 ** (count - 1), maximumMs);
  return Math.round(raw * (1 + Math.min(Math.max(jitterRatio, 0), 0.25)));
}

function decideRetry({ category, statusCode, providerProcessing, outcomeCertain, localPersistenceFailed = false, independentOperation = true, retryAfterAt = null, quotaResetAt = null, approvalExpiresAt = null, preconditionFresh = true, attempt = 1, maximumAttempts = 5 } = {}) {
  const normalized = String(category || "UNKNOWN").toUpperCase();
  if (localPersistenceFailed && outcomeCertain === true) return Object.freeze({ automaticRetry: false, action: "RECONCILE_LOCAL_PERSISTENCE", safe: false, retryAfterAt: null, evidence: { localPersistenceFailed: true, providerSuccessKnown: true } });
  if (outcomeCertain === false || providerProcessing === "UNKNOWN") return Object.freeze({ automaticRetry: false, action: "RECONCILE_BEFORE_RETRY", safe: false, retryAfterAt: null, evidence: { outcomeCertain: false } });
  if (!preconditionFresh || approvalExpiresAt && new Date(approvalExpiresAt) <= new Date()) return Object.freeze({ automaticRetry: false, action: "REVALIDATE_AND_REAPPROVE", safe: false, retryAfterAt: null, evidence: { preconditionFresh, approvalExpiresAt } });
  if (["VALIDATION", "POLICY", "PERMISSION", "PRECONDITION"].includes(normalized)) return Object.freeze({ automaticRetry: false, action: normalized === "PRECONDITION" ? "REVALIDATE_AND_REAPPROVE" : "HUMAN_CORRECTION_REQUIRED", safe: false, retryAfterAt: null });
  if (normalized === "PARTIAL_SUCCESS" && !independentOperation) return Object.freeze({ automaticRetry: false, action: "PRESERVE_SUCCESS_AND_REPLAN", safe: false, retryAfterAt: null });
  const transient = normalized === "RATE_LIMIT" || normalized === "TRANSIENT" || Number(statusCode) >= 500;
  const providerRetryAt = retryAfterAt || quotaResetAt;
  if (transient && providerProcessing === "NOT_STARTED" && attempt < maximumAttempts) return Object.freeze({ automaticRetry: true, action: "BOUNDED_RETRY", safe: true, retryAfterAt: providerRetryAt, backoffMs: providerRetryAt ? null : boundedBackoff(attempt), evidence: { category: normalized, statusCode: Number(statusCode) || null, attempt, maximumAttempts, quotaResetAt } });
  return Object.freeze({ automaticRetry: false, action: attempt >= maximumAttempts ? "DEAD_LETTER_MANUAL_REVIEW" : "MANUAL_REVIEW", safe: false, retryAfterAt: null });
}

function assertRetrySafe(decision) { if (!decision?.automaticRetry || !decision.safe) throw executionError("OPERATION_RETRY_NOT_SAFE", { action: decision?.action || "UNKNOWN" }); return decision; }

module.exports = { boundedBackoff, decideRetry, assertRetrySafe };
