"use strict";

// Single marketing email send (automation steps, double opt-in confirmations)
// through the brand's marketing provider account, with the same outcome
// rules as transactional mail:
// - one stable Idempotency-Key per logical send;
// - ambiguous outcomes are retried with the same key only inside the
//   provider's idempotency window (config.reconciliation.idempotencyWindowHours,
//   max 23 h of Resend's 24 h); after that, or on an idempotency conflict, the
//   outcome is UNKNOWN and is never retried automatically;
// - provider acceptance is recorded as PROVIDER_ACCEPTED, never as delivered.

function classifySendError(error, { firstAttemptAt, now, windowHours }) {
  const outsideWindow = firstAttemptAt && now.getTime() - new Date(firstAttemptAt).getTime() > windowHours * 3600000;
  switch (error?.kind) {
    case "IDEMPOTENCY_CONFLICT":
      return { outcome: "UNKNOWN", code: "PROVIDER_IDEMPOTENCY_CONFLICT" };
    case "AMBIGUOUS":
      return outsideWindow ? { outcome: "UNKNOWN", code: "AMBIGUOUS_OUTSIDE_IDEMPOTENCY_WINDOW" } : { outcome: "RETRY", code: error.code || "PROVIDER_AMBIGUOUS" };
    case "RETRYABLE":
      return outsideWindow ? { outcome: "UNKNOWN", code: "RETRY_OUTSIDE_IDEMPOTENCY_WINDOW" } : { outcome: "RETRY", code: error.code || "PROVIDER_RETRYABLE", retryAfterSeconds: error.retryAfterSeconds ?? null };
    case "NOT_CONFIGURED":
      return { outcome: "DEFER", code: error.code || "PROVIDER_NOT_CONFIGURED" };
    default:
      return { outcome: "FAILED", code: error?.code || "PROVIDER_REJECTED" };
  }
}

function unsubscribeHeaders(url) {
  if (!url) return {};
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

module.exports = { classifySendError, unsubscribeHeaders };
