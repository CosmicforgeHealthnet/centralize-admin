const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  RETRY_ERROR_CATEGORIES,
  sanitizeError,
  classifyProviderError,
  computeRetryDelayMs,
  planRetry,
} = require("../src/modules/marketing/social-operations/workers/retry-policy");

test("retry policy sanitizes provider errors", () => {
  assert.equal(
    sanitizeError("authorization: Bearer abc access_token=secret"),
    "authorization: Bearer [REDACTED] access_token=[REDACTED]",
  );
});

test("retry policy classifies retryable, rate-limited and policy errors", () => {
  assert.equal(classifyProviderError({ message: "network timeout" }), "RETRYABLE");
  assert.equal(classifyProviderError({ retryAfter: 30 }), "RATE_LIMITED");
  assert.equal(
    classifyProviderError({ capabilityStatus: "NATIVE_ONLY" }),
    RETRY_ERROR_CATEGORIES.PROVIDER_POLICY,
  );
});

test("retry policy honors Retry-After and jittered exponential backoff", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.equal(computeRetryDelayMs({ retryAfter: 30, now }), 30_000);
  assert.equal(
    computeRetryDelayMs({ attemptNumber: 3, now, random: () => 0.5, jitterRatio: 0 }),
    240_000,
  );
});

test("retry policy respects max attempts and never creates DEAD_LETTER", () => {
  const retry = planRetry({
    attemptNumber: 1,
    maxAttempts: 3,
    error: { retryable: true, message: "timeout" },
    random: () => 0.5,
  });
  assert.equal(retry.retryable, true);

  const exhausted = planRetry({
    attemptNumber: 3,
    maxAttempts: 3,
    error: { retryable: true, message: "timeout" },
  });
  assert.equal(exhausted.retryable, false);
  assert.equal(exhausted.errorCategory, "RETRYABLE_EXHAUSTED");
  assert.notEqual(exhausted.errorCategory, "DEAD_LETTER");
});
