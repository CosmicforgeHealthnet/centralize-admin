"use strict";

// Provider-neutral marketing transport contract (M7). CosmicForge is the
// database of record for contacts, consent, audiences, campaigns and
// automations; the provider only receives the exact recipient set computed at
// dispatch time and returns delivery evidence.
//
// Contacts
//   getContact(email) -> { id, email, unsubscribed } | null
//   createContact({ email, firstName, lastName, segmentIds }) -> { id }
//   addContactToSegment(contactId, segmentId) -> void
//   removeContactFromSegment(contactId, segmentId) -> void
// Segments
//   createSegment(name) -> { id }
//   findSegmentByName(name) -> { id } | null
//   deleteSegment(segmentId) -> void
// Broadcasts (provider broadcasts are NOT idempotent; callers reconcile by
// name / status, never by blind retry)
//   createBroadcast({ name, segmentId, from, replyTo, subject, html, text }) -> { id }
//   findBroadcastByName(name) -> { id, status } | null
//   sendBroadcast(broadcastId, { scheduledAt }) -> { id }
//   getBroadcast(broadcastId) -> { id, status: DRAFT|SCHEDULED|QUEUED|SENT|CANCELED|UNKNOWN, sentAt }
//   cancelBroadcast(broadcastId) -> void   (queued -> canceled, scheduled -> draft)
//   deleteBroadcast(broadcastId) -> void   (draft / scheduled only)
// Single marketing emails (automation steps, double opt-in confirmations)
//   sendEmail(request) -> { providerMessageId }   (same shape as the Mail
//   transport sendMessage; uses the provider Idempotency-Key)
// healthProbe() -> { ok, latencyMs, detail }
//
// Errors are MailProviderError (RETRYABLE | AMBIGUOUS | PERMANENT |
// IDEMPOTENCY_CONFLICT | NOT_CONFIGURED), shared with the transport adapter.

const { MailProviderError } = require("../mail-provider.contract");

const MARKETING_METHODS = [
  "getContact",
  "createContact",
  "addContactToSegment",
  "removeContactFromSegment",
  "createSegment",
  "findSegmentByName",
  "deleteSegment",
  "createBroadcast",
  "findBroadcastByName",
  "sendBroadcast",
  "getBroadcast",
  "cancelBroadcast",
  "deleteBroadcast",
  "sendEmail",
  "healthProbe",
];

const BROADCAST_STATUS = Object.freeze({ draft: "DRAFT", scheduled: "SCHEDULED", queued: "QUEUED", sending: "QUEUED", sent: "SENT", canceled: "CANCELED", cancelled: "CANCELED" });

function normalizeBroadcastStatus(value) {
  return BROADCAST_STATUS[String(value || "").toLowerCase()] || "UNKNOWN";
}

function assertMarketingAdapter(adapter) {
  for (const method of MARKETING_METHODS) {
    if (typeof adapter?.[method] !== "function") throw new Error(`Marketing provider adapter missing ${method}`);
  }
  return adapter;
}

function unconfiguredMarketingAdapter(reason) {
  const fail = async () => {
    throw new MailProviderError("NOT_CONFIGURED", "MARKETING_PROVIDER_NOT_CONFIGURED", reason);
  };
  const adapter = { name: "unconfigured", configured: false };
  for (const method of MARKETING_METHODS) adapter[method] = fail;
  adapter.healthProbe = async () => ({ ok: false, latencyMs: 0, detail: reason });
  return adapter;
}

module.exports = { MARKETING_METHODS, assertMarketingAdapter, unconfiguredMarketingAdapter, normalizeBroadcastStatus, MailProviderError };
