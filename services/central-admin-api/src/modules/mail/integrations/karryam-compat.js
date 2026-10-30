"use strict";

// Scoped, backward-compatible normalizer for Karryam Go's NATIVE
// notification request shape (KarryGo shared/go/notifications.Request,
// snake_case JSON as produced by Go's encoding/json):
//
//   { "idempotency_key": "...", "source_service": "...", "event_type": "...",
//     "recipient": { "type": "...", "id": "...", "email"?: "...", "phone"?: "..." },
//     "channels"?: [...], "template_key"?: "...", "locale"?: "...",
//     "title"?: "...", "body"?: "...", "data"?: {...}, "template_data"?: {...},
//     "priority"?: "..." }
//
// It is accepted ONLY when
//   1. the authenticated integration is the Karryam integration
//      (product "karryam"), AND
//   2. its service identity is listed in MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES
//      (comma separated, default EMPTY = off). The integration row has no
//      per-integration JSON config column, so the flag lives in env.
// Otherwise the request fails 422 MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED.
//
// Mapping rules (fail closed):
//   - event_type is mapped through the explicit table in event-registry.js
//     (booking.completed -> marketing.trigger karryam.booking.completed@1);
//     everything else is refused.
//   - eventId is a UUIDv5-style SHA-1 name hash of idempotency_key in a
//     namespace derived from the integration id, so Karryam retries (which
//     reuse the deterministic idempotency key) dedupe in HQ.
//   - product/organization come from the authenticated integration, never
//     from the payload.
//   - title/body (message content), recipient.phone, recipient lists and any
//     prohibited key (credentials, OTPs, clinical data) are refused.
//   - a product notification can never name a sender/from/reply-to: product
//     senders are authorised per integration in HQ (staff or HQ mailbox
//     addresses can never be claimed) -> 403 MAIL_SENDER_NOT_AUTHORIZED, audited.
//   - recipient.email is used only to look up an existing marketing contact;
//     it is never stored (only the contact id, as for canonical triggers).
//   - Only the approved trigger attributes are forwarded (service derived
//     from source_service; city/bookingCount if present). booking_id and other
//     data keys are dropped and never stored.
//
// Sunset: this shim exists only until Karryam ships a contract-v1 outbox
// publisher (docs/cosmicforge-mail-karryam-handoff.md). Remove the service
// from MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES to turn it off instantly.

const crypto = require("crypto");
const { ContractError, prohibitedKeys } = require("./contracts");
const { KARRYAM_NATIVE_EVENTS, KARRYAM_REFUSED_EVENTS, KARRYAM_SERVICE_ATTRIBUTE, karryamMapping } = require("./event-registry");

const KARRYAM_PRODUCT = "karryam";
const COMPAT_FLAG = "MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES";
const SHAPE = "karryam.notifications.Request";
// Fixed namespace for HQ <- Karryam idempotency ids (random, never change).
const NAMESPACE = "5b0f7c1e-2a4d-5e8f-9c3b-6d7a8e9f0a1b";

const TOP_LEVEL_KEYS = new Set(["idempotency_key", "source_service", "event_type", "recipient", "channels", "template_key", "locale", "title", "body", "data", "template_data", "priority"]);
const RECIPIENT_KEYS = new Set(["type", "id", "email", "phone"]);
const CHANNELS = new Set(["push", "email", "websocket", "in_app"]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const SENDER_KEY = /^(from|sender|from_?(email|address|name|mailbox)|sender_?(email|address|name|mailbox)|reply_?to|return_?path|mailbox|mailbox_?id)$/i;
const RECIPIENT_LIST_KEY = /^(to|cc|bcc|recipients|recipient_?list|emails)$/i;
// Karryam-specific secrets on top of the canonical prohibited-key list.
const KARRYAM_PROHIBITED_KEY = /^(otp|code|otp_?code|verification_?code|pin|one_?time_?(code|password))$/i;
const EMAIL = /^[^\s@<>()",;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;
const PERSONAL_VALUE = /([^\s@]+@[^\s@]+\.[a-z]{2,})|(\+\d[\d\s().-]{6,}\d)/i;

function parseCompatServices(value) {
  return new Set(String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

// A body is the legacy shape when it is not a contract envelope and carries
// any of the native Request discriminator keys.
function isLegacyKarryamShape(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (Object.prototype.hasOwnProperty.call(body, "contractVersion")) return false;
  return ["idempotency_key", "source_service", "event_type"].some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function compatDecision(integration, env = process.env) {
  if (!integration || integration.product !== KARRYAM_PRODUCT) return { allowed: false, reason: "NOT_KARRYAM_INTEGRATION" };
  if (!parseCompatServices(env[COMPAT_FLAG]).has(integration.serviceName)) return { allowed: false, reason: "COMPAT_FLAG_OFF" };
  return { allowed: true };
}

function notEnabledError(reason) {
  return new ContractError("MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED", 422, {
    reason,
    shape: SHAPE,
    flag: COMPAT_FLAG,
    expected: "contractVersion 1 envelope (docs/cosmicforge-mail-karryam-handoff.md)",
  });
}

function uuidBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// RFC 4122 version-5 UUID (SHA-1 name-based).
function uuidV5(name, namespace) {
  const hash = crypto.createHash("sha1").update(Buffer.concat([uuidBytes(namespace), Buffer.from(String(name), "utf8")])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

// Stable HQ eventId for a Karryam idempotency key, namespaced by integration
// so two integrations can never collide.
function deriveKarryamEventId(integrationId, idempotencyKey) {
  return uuidV5(idempotencyKey, uuidV5(`integration:${integrationId}`, NAMESPACE));
}

function findKeys(value, pattern, path, found = [], depth = 0) {
  if (depth > 6 || value == null || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    if (pattern.test(key)) found.push({ field: `${path}.${key}`, value: entry });
    findKeys(entry, pattern, `${path}.${key}`, found, depth + 1);
  }
  return found;
}

function flatObject(value, field) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field });
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry === "object") throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: `${field}.${key}`, reason: "NESTED_VALUES_NOT_ALLOWED" });
  }
  return value;
}

function stringField(value, field, { pattern = null, max = 160, optional = false } = {}) {
  if (value == null || value === "") {
    if (optional) return null;
    throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field });
  }
  if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field });
  return value;
}

/**
 * Validates a native Karryam Request and returns the canonical contract-v1
 * envelope object (to be parsed by parseEnvelope like any other body).
 * Throws ContractError. `spoof` details mark sender-claim attempts.
 */
function normalizeKarryamRequest(body, { integration, organization, now = new Date() }) {
  // 1. Sender claims anywhere: product notifications cannot choose a sender.
  const senderClaims = findKeys(body, SENDER_KEY, "request");
  if (senderClaims.length) {
    const claimed = senderClaims.map((entry) => entry.value).find((value) => typeof value === "string") || null;
    throw new ContractError("MAIL_SENDER_NOT_AUTHORIZED", 403, { reason: "PRODUCT_NOTIFICATION_CANNOT_SET_SENDER", field: senderClaims[0].field, spoof: true, claimedSender: claimed ? String(claimed).toLowerCase().slice(0, 320) : null });
  }
  // 2. Raw recipient lists are never accepted.
  const lists = findKeys(body, RECIPIENT_LIST_KEY, "request");
  if (lists.length || Array.isArray(body.recipient)) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { reason: "RECIPIENT_LIST_NOT_ALLOWED", fields: lists.length ? lists.map((entry) => entry.field).slice(0, 10) : ["request.recipient"] });
  // 3. Strict top-level keys (exactly the Go struct's JSON names).
  const unknown = Object.keys(body).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length) throw new ContractError("MAIL_INTEGRATION_UNKNOWN_FIELDS", 422, { fields: unknown.map((key) => `request.${key}`) });
  // 4. Events that must never leave Karryam are refused by name first.
  const refused = typeof body.event_type === "string" ? KARRYAM_REFUSED_EVENTS[body.event_type] : null;
  if (refused) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { reason: refused, eventType: body.event_type });
  // 5. Message content never reaches HQ.
  const content = ["title", "body"].filter((key) => body[key] != null && body[key] !== "");
  if (content.length) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { reason: "MESSAGE_CONTENT_NOT_ALLOWED", fields: content.map((key) => `request.${key}`) });
  // 6. Prohibited keys (credentials, OTPs, clinical data) in data maps.
  const prohibited = [...prohibitedKeys(body.data, "request.data"), ...prohibitedKeys(body.template_data, "request.template_data"), ...findKeys(body.data, KARRYAM_PROHIBITED_KEY, "request.data").map((entry) => entry.field), ...findKeys(body.template_data, KARRYAM_PROHIBITED_KEY, "request.template_data").map((entry) => entry.field)];
  if (prohibited.length) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { fields: [...new Set(prohibited)].slice(0, 20) });

  const idempotencyKey = stringField(body.idempotency_key, "request.idempotency_key", { pattern: /^[\x21-\x7e]{1,255}$/, max: 255 });
  const nativeEventType = stringField(body.event_type, "request.event_type", { pattern: /^[a-z][a-z0-9_.]{1,95}$/, max: 96 });
  const mapping = karryamMapping(nativeEventType);
  if (!mapping) throw new ContractError("MAIL_INTEGRATION_UNSUPPORTED_EVENT", 422, { eventType: nativeEventType, shape: SHAPE, supported: Object.keys(KARRYAM_NATIVE_EVENTS) });
  const sourceService = stringField(body.source_service, "request.source_service", { pattern: /^[a-z][a-z0-9-]{1,95}$/, max: 96 });
  if (!mapping.sources.includes(sourceService)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "request.source_service", reason: "SOURCE_SERVICE_NOT_MAPPED", allowed: mapping.sources });

  const recipient = body.recipient;
  if (!recipient || typeof recipient !== "object") throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "request.recipient" });
  const extraRecipient = Object.keys(recipient).filter((key) => !RECIPIENT_KEYS.has(key));
  if (extraRecipient.length) throw new ContractError("MAIL_INTEGRATION_UNKNOWN_FIELDS", 422, { fields: extraRecipient.map((key) => `request.recipient.${key}`) });
  if (recipient.phone != null && recipient.phone !== "") throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { reason: "RAW_CONTACT_DATA_NOT_ALLOWED", field: "request.recipient.phone" });
  if (recipient.type !== "customer") throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "request.recipient.type", reason: "CUSTOMER_RECIPIENT_REQUIRED" });
  stringField(recipient.id, "request.recipient.id", { max: 160 });
  if (recipient.email == null || recipient.email === "") throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "request.recipient.email", reason: "KARRYAM_RECIPIENT_EMAIL_REQUIRED" });
  const contactEmail = stringField(recipient.email, "request.recipient.email", { pattern: EMAIL, max: 320 }).trim().toLowerCase();

  if (body.channels != null && (!Array.isArray(body.channels) || body.channels.length > 4 || body.channels.some((channel) => !CHANNELS.has(channel)))) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "request.channels" });
  stringField(body.template_key, "request.template_key", { pattern: /^[a-z0-9][a-z0-9_.:-]{0,95}$/i, max: 96, optional: true });
  stringField(body.locale, "request.locale", { pattern: /^[a-z]{2}(-[A-Z]{2})?$/, max: 8, optional: true });
  if (body.priority != null && body.priority !== "" && !PRIORITIES.has(body.priority)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "request.priority" });
  const data = flatObject(body.data, "request.data");
  flatObject(body.template_data, "request.template_data");

  // Only approved attributes are forwarded; the rest is dropped here.
  const attributes = { service: KARRYAM_SERVICE_ATTRIBUTE[sourceService] };
  if (typeof data.city === "string" && data.city && !PERSONAL_VALUE.test(data.city)) attributes.city = data.city.slice(0, 120);
  const count = data.bookingCount ?? data.booking_count;
  if (Number.isInteger(count) && count >= 0) attributes.bookingCount = count;

  return {
    nativeEventType,
    sourceService,
    envelope: {
      contractVersion: 1,
      product: integration.product,
      organization: organization.slug,
      eventId: deriveKarryamEventId(integration.id, idempotencyKey),
      eventType: mapping.eventType,
      eventVersion: mapping.eventVersion,
      occurredAt: now.toISOString(),
      data: { triggerType: mapping.triggerType, triggerVersion: mapping.triggerVersion, contactEmail, attributes },
    },
  };
}

module.exports = { isLegacyKarryamShape, compatDecision, notEnabledError, normalizeKarryamRequest, deriveKarryamEventId, uuidV5, parseCompatServices, KARRYAM_PRODUCT, COMPAT_FLAG, SHAPE };
