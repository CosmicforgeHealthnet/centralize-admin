const RETRY_ERROR_CATEGORIES = Object.freeze({
  RETRYABLE: "RETRYABLE",
  PERMANENT: "PERMANENT",
  RATE_LIMITED: "RATE_LIMITED",
  PROVIDER_POLICY: "PROVIDER_POLICY",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  RETRYABLE_EXHAUSTED: "RETRYABLE_EXHAUSTED",
});

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /temporar/i,
  /try again/i,
  /unavailable/i,
  /network/i,
  /\b5\d\d\b/,
];

const PERMANENT_PATTERNS = [
  /permission/i,
  /policy/i,
  /unsupported/i,
  /not found/i,
  /disabled/i,
  /native_only/i,
  /unsupported_account_type/i,
  /requires_platform_approval/i,
  /requires_reauthorization/i,
];

const SENSITIVE_ERROR_PATTERNS = [
  /(access[_-]?token=)[^&\s]+/gi,
  /(refresh[_-]?token=)[^&\s]+/gi,
  /(authorization:\s*bearer\s+)[^\s]+/gi,
  /(password=)[^&\s]+/gi,
  /(secret=)[^&\s]+/gi,
];

function sanitizeError(error) {
  const raw =
    typeof error === "string"
      ? error
      : error?.safeMessage || error?.message || error?.name || "Provider operation failed";
  return SENSITIVE_ERROR_PATTERNS.reduce(
    (message, pattern) => message.replace(pattern, "$1[REDACTED]"),
    String(raw).slice(0, 500),
  );
}

function retryAfterToDate(retryAfter, now = new Date()) {
  if (!retryAfter) return null;
  if (retryAfter instanceof Date && !Number.isNaN(retryAfter.getTime())) return retryAfter;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return new Date(now.getTime() + retryAfter * 1000);
  }

  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric)) return new Date(now.getTime() + numeric * 1000);

  const parsed = new Date(retryAfter);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function classifyProviderError(error = {}) {
  const status = error.capabilityStatus || error.status || error.statusCode;
  const reasonCode = String(error.reasonCode || error.code || "");
  const message = sanitizeError(error);
  const combined = `${reasonCode} ${message}`;

  if (status === "REQUIRES_REAUTHORIZATION" || /auth/i.test(reasonCode)) {
    return RETRY_ERROR_CATEGORIES.AUTH_REQUIRED;
  }
  if (status === "RATE_LIMITED" || error.retryAfter || /rate/i.test(combined)) {
    return RETRY_ERROR_CATEGORIES.RATE_LIMITED;
  }
  if (
    ["NATIVE_ONLY", "UNSUPPORTED_ACCOUNT_TYPE", "REQUIRES_PLATFORM_APPROVAL"].includes(status) ||
    PERMANENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return RETRY_ERROR_CATEGORIES.PROVIDER_POLICY;
  }
  if (error.permanent === true) return RETRY_ERROR_CATEGORIES.PERMANENT;
  if (error.retryable === true || RETRYABLE_PATTERNS.some((pattern) => pattern.test(combined))) {
    return RETRY_ERROR_CATEGORIES.RETRYABLE;
  }
  return RETRY_ERROR_CATEGORIES.PERMANENT;
}

function isRetryableCategory(category) {
  return [
    RETRY_ERROR_CATEGORIES.RETRYABLE,
    RETRY_ERROR_CATEGORIES.RATE_LIMITED,
  ].includes(category);
}

function computeRetryDelayMs({
  attemptNumber,
  retryAfter,
  now = new Date(),
  baseDelayMs = 60 * 1000,
  maxDelayMs = 60 * 60 * 1000,
  jitterRatio = 0.2,
  random = Math.random,
} = {}) {
  const retryAfterDate = retryAfterToDate(retryAfter, now);
  if (retryAfterDate && retryAfterDate.getTime() > now.getTime()) {
    return Math.min(retryAfterDate.getTime() - now.getTime(), maxDelayMs);
  }

  const exponent = Math.max(0, Number(attemptNumber || 1) - 1);
  const rawDelay = Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
  const jitterWindow = rawDelay * jitterRatio;
  const jitter = (random() * 2 - 1) * jitterWindow;
  return Math.max(1000, Math.min(maxDelayMs, Math.round(rawDelay + jitter)));
}

function planRetry({
  attemptNumber,
  maxAttempts,
  error,
  now = new Date(),
  random = Math.random,
} = {}) {
  const category = classifyProviderError(error);
  const exhausted = Number(attemptNumber || 0) >= Number(maxAttempts || 1);
  const retryable = isRetryableCategory(category) && !exhausted;

  if (!retryable) {
    return {
      retryable: false,
      exhausted: isRetryableCategory(category) && exhausted,
      errorCategory: isRetryableCategory(category) && exhausted
        ? RETRY_ERROR_CATEGORIES.RETRYABLE_EXHAUSTED
        : category,
      nextAttemptAt: null,
      sanitizedError: sanitizeError(error),
    };
  }

  const delayMs = computeRetryDelayMs({
    attemptNumber,
    retryAfter: error?.retryAfter || error?.retryAfterSeconds || error?.retryAfterAt,
    now,
    random,
  });

  return {
    retryable: true,
    exhausted: false,
    errorCategory:
      category === RETRY_ERROR_CATEGORIES.RATE_LIMITED
        ? RETRY_ERROR_CATEGORIES.RATE_LIMITED
        : RETRY_ERROR_CATEGORIES.RETRYABLE,
    nextAttemptAt: new Date(now.getTime() + delayMs),
    sanitizedError: sanitizeError(error),
  };
}

module.exports = {
  RETRY_ERROR_CATEGORIES,
  sanitizeError,
  retryAfterToDate,
  classifyProviderError,
  isRetryableCategory,
  computeRetryDelayMs,
  planRetry,
};
