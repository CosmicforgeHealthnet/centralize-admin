"use strict";

// Versioned product -> HQ Mail event contracts (contract version 1).
//
// Envelope (strict: unknown keys are rejected):
//   { contractVersion: 1, product, organization, eventId, eventType,
//     eventVersion, correlationId?, idempotencyKey?, occurredAt, data }
// Event types:
//   mail.delivery_status@1  delivery metadata for PRODUCT-OWNED transactional
//                           mail (HQ never sends it). Recipient address is
//                           hashed on receipt and never stored.
//   marketing.trigger@1     an approved product event for marketing
//                           automation triggers (never consent).
//   ops.alert@1             a low-sensitivity operational alert.
// Message content (html/text/body/subject), attachments, credentials and any
// clinical or patient data are prohibited in every contract and rejected
// fail-closed. RESTRICTED_HEALTH integrations (HealthNet) may only send
// ops.alert@1 with no personal data at all; their summary is a fixed code.

const crypto = require("crypto");

const SUPPORTED_CONTRACT_VERSIONS = new Set([1]);
const RESERVED_EVENT_ID_PREFIXES = Object.freeze(["rejected:", "idem:"]);
const EVENT_TYPES = Object.freeze({
  "mail.delivery_status": { versions: [1] },
  "marketing.trigger": { versions: [1] },
  "ops.alert": { versions: [1] },
});
const ENVELOPE_KEYS = new Set(["contractVersion", "product", "organization", "eventId", "eventType", "eventVersion", "correlationId", "idempotencyKey", "occurredAt", "data"]);
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SLUG = /^[a-z][a-z0-9-]{1,63}$/;
const EMAIL = /^[^\s@<>()",;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;
const DELIVERY_STATUSES = new Set(["ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED", "FAILED", "SUPPRESSED"]);
const PROVIDERS = new Set(["resend", "smtp", "ses", "sendgrid", "mailgun", "other"]);

// Keys that must never appear anywhere in an integration payload.
const PROHIBITED_KEY = /(patient|diagnos|clinic|prescri|medicat|symptom|condition|treatment|icd|lab_?result|vital|allerg|date_?of_?birth|^dob$|mrn|medical|health_?record|consultation|insurance_?(number|id)|ssn|^nin$|^bvn$|card_?number|^pan$|cvv|password|passcode|secret|token|api_?key|^html$|^text$|^body$|content|attachment|^subject$)/i;
const PERSONAL_DATA_VALUE = /([^\s@]+@[^\s@]+\.[a-z]{2,})|(\+?\d[\d\s().-]{6,}\d)/i;

class ContractError extends Error {
  constructor(code, status = 422, details = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function prohibitedKeys(value, path = "data", found = [], depth = 0) {
  if (depth > 6 || value == null || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    if (PROHIBITED_KEY.test(key)) found.push(`${path}.${key}`);
    prohibitedKeys(entry, `${path}.${key}`, found, depth + 1);
  }
  return found;
}

function strictKeys(object, allowed, path) {
  const extra = Object.keys(object || {}).filter((key) => !allowed.has(key));
  if (extra.length) throw new ContractError("MAIL_INTEGRATION_UNKNOWN_FIELDS", 422, { fields: extra.map((key) => `${path}.${key}`) });
}

function requireString(object, key, pattern, path, { optional = false, max = 160 } = {}) {
  const value = object[key];
  if (value == null || value === "") {
    if (optional) return null;
    throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: `${path}.${key}` });
  }
  if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: `${path}.${key}` });
  return value;
}

function parseEnvelope(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "body" });
  strictKeys(body, ENVELOPE_KEYS, "envelope");
  if (!SUPPORTED_CONTRACT_VERSIONS.has(body.contractVersion)) throw new ContractError("MAIL_INTEGRATION_UNSUPPORTED_VERSION", 422, { supported: [...SUPPORTED_CONTRACT_VERSIONS] });
  const envelope = {
    product: requireString(body, "product", SLUG, "envelope"),
    organization: requireString(body, "organization", SLUG, "envelope"),
    eventId: requireString(body, "eventId", ID, "envelope"),
    eventType: requireString(body, "eventType", /^[a-z][a-z0-9_.]{2,95}$/, "envelope", { max: 96 }),
    correlationId: requireString(body, "correlationId", ID, "envelope", { optional: true }),
    idempotencyKey: requireString(body, "idempotencyKey", ID, "envelope", { optional: true }),
    occurredAt: requireString(body, "occurredAt", null, "envelope", { max: 40 }),
  };
  envelope.eventVersion = body.eventVersion;
  // HQ stores rejection and idempotency-key marker rows under these prefixes.
  if (RESERVED_EVENT_ID_PREFIXES.some((prefix) => envelope.eventId.startsWith(prefix))) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "envelope.eventId", reason: "RESERVED_EVENT_ID_PREFIX" });
  const type = EVENT_TYPES[envelope.eventType];
  if (!type) throw new ContractError("MAIL_INTEGRATION_UNSUPPORTED_EVENT", 422, { eventType: envelope.eventType });
  if (!type.versions.includes(envelope.eventVersion)) throw new ContractError("MAIL_INTEGRATION_UNSUPPORTED_VERSION", 422, { eventType: envelope.eventType, supported: type.versions });
  const at = new Date(envelope.occurredAt);
  if (Number.isNaN(at.getTime())) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "envelope.occurredAt" });
  envelope.occurredAtDate = at;
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "envelope.data" });
  const prohibited = prohibitedKeys(body.data);
  if (prohibited.length) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { fields: prohibited.slice(0, 20) });
  envelope.data = body.data;
  return envelope;
}

function parseDeliveryStatus(data) {
  strictKeys(data, new Set(["productMessageId", "provider", "providerMessageId", "sender", "recipient", "status", "category"]), "data");
  const sender = requireString(data, "sender", EMAIL, "data", { max: 320 }).toLowerCase();
  const recipient = requireString(data, "recipient", EMAIL, "data", { max: 320 }).toLowerCase();
  const status = requireString(data, "status", null, "data", { max: 32 });
  if (!DELIVERY_STATUSES.has(status)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "data.status" });
  const provider = requireString(data, "provider", null, "data", { max: 32 });
  if (!PROVIDERS.has(provider)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "data.provider" });
  return {
    productMessageId: requireString(data, "productMessageId", ID, "data"),
    provider,
    providerMessageId: requireString(data, "providerMessageId", /^[A-Za-z0-9_.:@<>-]{1,255}$/, "data", { optional: true, max: 255 }),
    sender,
    recipient,
    status,
    category: requireString(data, "category", /^[a-z0-9][a-z0-9_.-]{0,63}$/, "data", { max: 64 }),
  };
}

function parseMarketingTrigger(data) {
  strictKeys(data, new Set(["triggerType", "triggerVersion", "contactEmail", "attributes"]), "data");
  const attributes = data.attributes == null ? {} : data.attributes;
  if (typeof attributes !== "object" || Array.isArray(attributes)) throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "data.attributes" });
  return {
    triggerType: requireString(data, "triggerType", /^[a-z][a-z0-9_.]{2,95}$/, "data", { max: 96 }),
    triggerVersion: Number.isInteger(data.triggerVersion) ? data.triggerVersion : (() => { throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "data.triggerVersion" }); })(),
    contactEmail: requireString(data, "contactEmail", EMAIL, "data", { max: 320 }).toLowerCase(),
    attributes,
  };
}

// RESTRICTED_HEALTH alerts carry no free text at all: the summary must be one
// of these operational codes, so clinical text cannot slip through.
const RESTRICTED_ALERT_SUMMARIES = Object.freeze(["SYNC_FAILED", "QUEUE_BACKLOG", "PROVIDER_DOWN", "AUTH_FAILURE", "CONFIG_ERROR", "OTHER"]);

function parseOpsAlert(data, { restricted }) {
  strictKeys(data, new Set(["severity", "code", "summary", "component"]), "data");
  const severity = requireString(data, "severity", /^(info|warning|critical)$/, "data", { max: 16 });
  const summary = requireString(data, "summary", null, "data", { max: 200 });
  if (restricted && !RESTRICTED_ALERT_SUMMARIES.includes(summary)) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { field: "data.summary", reason: "FREE_TEXT_NOT_ALLOWED", allowed: RESTRICTED_ALERT_SUMMARIES });
  // Operational alerts carry no personal data (strictly enforced for health).
  if (PERSONAL_DATA_VALUE.test(summary) || (restricted && /\d{5,}/.test(summary))) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 422, { field: "data.summary", reason: "PERSONAL_DATA_NOT_ALLOWED" });
  return { severity, code: requireString(data, "code", /^[A-Z][A-Z0-9_]{2,63}$/, "data", { max: 64 }), summary: summary.replace(/[\u0000-\u001f<>]/g, " "), component: requireString(data, "component", /^[a-z0-9][a-z0-9-]{0,63}$/, "data", { max: 64 }) };
}

// Idempotency keys (contract v1): a producer may retry one logical event
// with a fresh eventId as long as it reuses idempotencyKey. Two deliveries
// with the same key are the same event when this fingerprint matches; it
// covers everything except eventId and occurredAt (which retries may
// regenerate). A different fingerprint under the same key is a 409 conflict.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function idempotencyFingerprint(envelope) {
  const material = { product: envelope.product, organization: envelope.organization, eventType: envelope.eventType, eventVersion: envelope.eventVersion, correlationId: envelope.correlationId || null, data: envelope.data };
  return crypto.createHash("sha256").update(stableStringify(material)).digest("hex");
}

module.exports = { idempotencyFingerprint, RESERVED_EVENT_ID_PREFIXES, parseEnvelope, parseDeliveryStatus, parseMarketingTrigger, parseOpsAlert, ContractError, RESTRICTED_ALERT_SUMMARIES, EVENT_TYPES, SUPPORTED_CONTRACT_VERSIONS, DELIVERY_STATUSES, prohibitedKeys };
