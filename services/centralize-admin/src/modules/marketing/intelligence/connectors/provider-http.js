const logger = require("../../../../shared/utils/logger");

const { EVENTS, logEvent, providerFailure } = require("../observability");
const { sanitizePlainText } = require("../validation-security");

// Shared HTTP error handling for advertising provider connectors.

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;

class ProviderError extends Error {
  // kind: "auth" | "rate_limit" | "timeout" | "provider" | "malformed" | "config"
  constructor(platform, kind, message, { retryable = false, statusCode = null } = {}) {
    super(`[${platform}] ${message}`);
    this.name = "ProviderError";
    this.platform = platform;
    this.kind = kind;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function providerTimeoutMs() {
  const parsed = Number(process.env.MARKETING_PROVIDER_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function providerMaxRetries() {
  const parsed = Number(process.env.MARKETING_PROVIDER_MAX_RETRIES);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_RETRIES;
}

// Remove anything token-shaped from a string before it can reach logs or
// error messages. Covers query params, headers, and long opaque token blobs.
function sanitizeProviderText(text) {
  if (typeof text !== "string") return text;

  const redacted = text
    .replace(/((?:access[_-]?token|refresh[_-]?token|access[_-]?token[_-]?secret|consumer[_-]?key|consumer[_-]?secret|client[_-]?secret|developer[_-]?token|oauth[_-]?signature|app[_-]?secret|secret)=)[^&\s"']+/gi, "$1***REDACTED***")
    .replace(/("?(?:access[_-]?token|refresh[_-]?token|access[_-]?token[_-]?secret|consumer[_-]?key|consumer[_-]?secret|client[_-]?secret|developer[_-]?token|oauth[_-]?signature|authorization|app[_-]?secret|secret)"?\s*[:=]\s*")[^"]+(")/gi, "$1***REDACTED***$2")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(/\bOAuth\s+[^"\n\r]+/g, "OAuth ***REDACTED***")
    .replace(/\b(EAA|act_token_)[A-Za-z0-9]{20,}\b/g, "***REDACTED***");
  return sanitizePlainText(redacted, 4000) || "";
}

// Classify an axios failure into a ProviderError without leaking credentials.
function classifyAxiosError(platform, error) {
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return new ProviderError(platform, "timeout", "Provider request timed out", {
      retryable: true,
    });
  }

  const status = error.response?.status ?? null;

  if (status === 401 || status === 403) {
    return new ProviderError(
      platform,
      "auth",
      "Provider rejected the credentials (expired or invalid token)",
      { statusCode: status },
    );
  }

  if (status === 429) {
    return new ProviderError(platform, "rate_limit", "Provider rate limit reached", {
      retryable: true,
      statusCode: status,
    });
  }

  if (status !== null && status >= 500) {
    return new ProviderError(platform, "provider", `Provider returned HTTP ${status}`, {
      retryable: true,
      statusCode: status,
    });
  }

  const detail = sanitizeProviderText(
    error.response?.data?.error?.message ||
      error.response?.data?.message ||
      error.message ||
      "request failed",
  );

  return new ProviderError(platform, "provider", `Provider request failed: ${detail}`, {
    statusCode: status,
  });
}

// Run a request function with bounded retries on retryable failures
// (rate limits, timeouts, 5xx). Exponential backoff, no credential logging.
async function requestWithRetry(platform, requestFn, { retryDelayMs = 500 } = {}) {
  const maxRetries = providerMaxRetries();
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestFn();
    } catch (error) {
      const classified =
        error instanceof ProviderError ? error : classifyAxiosError(platform, error);

      if (!classified.retryable || attempt === maxRetries) {
        throw classified;
      }

      lastError = classified;
      const delay = retryDelayMs * 2 ** attempt;
      logEvent(EVENTS.PROVIDER_FAILURE, {
        runId: null, platform, connectionId: null, ...providerFailure(classified),
        attempt: attempt + 1, safeRequestId: null, operation: "PROVIDER_REQUEST", status: "RETRYING",
      }, { log: logger, level: "warn" });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = {
  ProviderError,
  providerTimeoutMs,
  providerMaxRetries,
  sanitizeProviderText,
  classifyAxiosError,
  requestWithRetry,
};
