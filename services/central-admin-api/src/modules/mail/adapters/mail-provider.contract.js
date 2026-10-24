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
//   NOT_CONFIGURED - adapter has no credentials / disabled

class MailProviderError extends Error {
  constructor(kind, code, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = "MailProviderError";
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

module.exports = { MailProviderError, assertProviderAdapter, broadcastDisabled, REQUIRED_METHODS };
