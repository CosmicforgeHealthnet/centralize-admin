"use strict";

// Provider-neutral transport contract. Adapters translate to/from provider
// shapes; no provider SDK types or response shapes leak past this boundary.
//
// sendMessage(request) -> { providerMessageId }
//   request: { idempotencyKey, from: {address,name}, replyTo, to/cc/bcc: [{address,name}],
//              subject, html, text, headers: {Message-ID, In-Reply-To, References},
//              attachments: [{ filename, contentType, content: Buffer, contentId?, inline? }] }
// fetchInboundMessage(providerEmailId) -> NormalizedInbound
// fetchInboundAttachments(providerEmailId) -> [{ providerAttachmentId, filename, contentType,
//              sizeBytes, contentId, inline, download(): Promise<Buffer> }]
// validateDomain(providerDomainId | domain) -> { status, sendingStatus, receivingStatus, records }
// retrieveDeliveryEvents(providerMessageId) -> [{ type, occurredAt, recipient }]
// healthProbe() -> { ok, latencyMs, detail }
// Broadcast operations (M7, disabled): createBroadcast/sendBroadcast throw.
//
// Errors thrown by adapters are MailProviderError with kind:
//   RETRYABLE  - safe to retry (429, 5xx, provider says retry)
//   AMBIGUOUS  - request may have been accepted (timeout / connection reset after send)
//   PERMANENT  - will not succeed on retry (validation, auth, forbidden sender)
//   IDEMPOTENCY_CONFLICT - the key was already used with a different payload:
//                the provider may already have sent an earlier request, so the
//                outcome is UNKNOWN (never treated as a clean failure or retried)
//   NOT_CONFIGURED - adapter has no credentials / disabled

// Normalized categories (§18). Business code may branch on `kind` (retry
// semantics) or `category` (what went wrong); it never parses provider error
// bodies. `retryable` is true only when an automatic retry is safe: an
// OUTCOME_UNKNOWN write is never retried blindly (reconciliation decides).
const PROVIDER_ERROR_CATEGORIES = Object.freeze([
  "AUTHENTICATION_FAILED",
  "PERMISSION_DENIED",
  "DOMAIN_NOT_VERIFIED",
  "INVALID_RECIPIENT",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "OUTCOME_UNKNOWN",
  "NOT_SUPPORTED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "NOT_CONFIGURED",
]);
const CATEGORY_SET = new Set(PROVIDER_ERROR_CATEGORIES);

const DEFAULT_CATEGORY = Object.freeze({
  RETRYABLE: "PROVIDER_UNAVAILABLE",
  AMBIGUOUS: "OUTCOME_UNKNOWN",
  PERMANENT: "VALIDATION_FAILED",
  IDEMPOTENCY_CONFLICT: "OUTCOME_UNKNOWN",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

class MailProviderError extends Error {
  constructor(kind, code, message, { status = null, retryAfterSeconds = null, category = null, providerErrorName = null, rateLimit = null, operation = null, provider = null } = {}) {
    super(message);
    this.name = "MailProviderError";
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.category = CATEGORY_SET.has(category) ? category : DEFAULT_CATEGORY[kind] || "PROVIDER_UNAVAILABLE";
    // Safe to retry automatically with the same request (never for unknown outcomes).
    this.retryable = kind === "RETRYABLE";
    this.providerErrorName = providerErrorName ? String(providerErrorName).slice(0, 64) : null;
    this.rateLimit = rateLimit || null;
    this.operation = operation;
    this.provider = provider;
  }

  // Safe structured description for audit/logs/job records: no message
  // content, addresses, credentials or provider bodies.
  describe() {
    return describeProviderError(this);
  }
}

function describeProviderError(error) {
  if (!error) return null;
  return {
    kind: error.kind || null,
    category: error.category || null,
    code: error.code ? String(error.code).slice(0, 80) : null,
    status: Number.isFinite(error.status) ? error.status : null,
    retryable: Boolean(error.retryable),
    retryAfterSeconds: Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : null,
    providerErrorName: error.providerErrorName || null,
    operation: error.operation || null,
    provider: error.provider || null,
    rateLimit: error.rateLimit || null,
  };
}

const REQUIRED_METHODS = [
  "sendMessage",
  "fetchInboundMessage",
  "fetchInboundAttachments",
  "validateDomain",
  "retrieveDeliveryEvents",
  "healthProbe",
  "createBroadcast",
  "sendBroadcast",
];

function assertProviderAdapter(adapter) {
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter?.[method] !== "function") throw new Error(`Mail provider adapter missing ${method}`);
  }
  return adapter;
}

async function broadcastDisabled() {
  throw new MailProviderError("NOT_CONFIGURED", "BROADCAST_NOT_ENABLED", "Marketing broadcast dispatch is an M7 capability and is not enabled");
}

module.exports = { MailProviderError, assertProviderAdapter, broadcastDisabled, REQUIRED_METHODS, PROVIDER_ERROR_CATEGORIES, describeProviderError };
