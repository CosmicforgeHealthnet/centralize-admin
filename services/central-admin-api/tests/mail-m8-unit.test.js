"use strict";

// M8 unit tests (no database, no network): service auth, contracts,
// prohibited content, and the transactional-mail non-regression tripwire.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseServiceSecrets, signatureFor, signServiceRequest, verifyServiceRequest } = require("../src/modules/mail/integrations/service-auth");
const { parseEnvelope, parseDeliveryStatus, parseMarketingTrigger, parseOpsAlert, ContractError } = require("../src/modules/mail/integrations/contracts");
const { loadMailConfig } = require("../src/modules/mail/mail.config");

const PATH = "/api/mail/v1/integrations/v1/events";
// Shared with docs/integrations/karryam-go-hqmail/hqmail_test.go and verified
// against Karryam Go's shared/go/serviceauth.SignRequest.
const VECTOR = "f2d6ea185346e6460abaf673214319f2b29e6a00f0c1e4593aaa3168c68e7f27";

function envelope(overrides = {}) {
  return { contractVersion: 1, product: "karryam", organization: "karryam", eventId: "evt-1", eventType: "mail.delivery_status", eventVersion: 1, occurredAt: "2026-10-25T00:00:00Z", data: { productMessageId: "m-1", provider: "resend", sender: "noreply@karryam.example", recipient: "Rider@Example.com", status: "DELIVERED", category: "booking_confirmation" }, ...overrides };
}

test("service signature matches the cross-language vector", () => {
  assert.equal(signatureFor("POST", PATH, "1761350400", Buffer.from('{"contractVersion":1}'), Buffer.from("vector-secret-0123456789")), VECTOR);
});

test("service auth verifies, rejects skew, unknown service and tampering", () => {
  const secrets = parseServiceSecrets("karryam-notification-service=s3cret-0123456789abcdef, other:x-secret-0123456789");
  assert.equal(secrets.size, 2);
  const body = JSON.stringify(envelope());
  const now = 1761350400000;
  const headers = Object.fromEntries(Object.entries(signServiceRequest({ method: "POST", requestUri: PATH, body, serviceName: "karryam-notification-service", secret: "s3cret-0123456789abcdef", now })).map(([k, v]) => [k.toLowerCase(), v]));
  const ok = verifyServiceRequest({ method: "POST", requestUri: PATH, headers, rawBody: Buffer.from(body), secrets, now });
  assert.deepEqual(ok, { ok: true, serviceName: "karryam-notification-service" });
  assert.equal(verifyServiceRequest({ method: "POST", requestUri: PATH, headers, rawBody: Buffer.from(body + " "), secrets, now }).code, "SERVICE_AUTH_INVALID");
  assert.equal(verifyServiceRequest({ method: "POST", requestUri: PATH + "?x=1", headers, rawBody: Buffer.from(body), secrets, now }).code, "SERVICE_AUTH_INVALID");
  assert.equal(verifyServiceRequest({ method: "POST", requestUri: PATH, headers, rawBody: Buffer.from(body), secrets, now: now + 301000 }).code, "SERVICE_AUTH_EXPIRED");
  assert.equal(verifyServiceRequest({ method: "POST", requestUri: PATH, headers: { ...headers, "x-service-name": "ghost" }, rawBody: Buffer.from(body), secrets, now }).code, "SERVICE_AUTH_INVALID");
  assert.equal(verifyServiceRequest({ method: "POST", requestUri: PATH, headers: {}, rawBody: Buffer.from(body), secrets, now }).code, "SERVICE_AUTH_REQUIRED");
});

test("contract v1 envelope is strict and versioned", () => {
  const parsed = parseEnvelope(envelope());
  assert.equal(parsed.eventType, "mail.delivery_status");
  const delivery = parseDeliveryStatus(parsed.data);
  assert.equal(delivery.recipient, "rider@example.com");
  const code = (fn) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof ContractError); return error.code; } };
  assert.equal(code(() => parseEnvelope(envelope({ contractVersion: 2 }))), "MAIL_INTEGRATION_UNSUPPORTED_VERSION");
  assert.equal(code(() => parseEnvelope(envelope({ eventVersion: 2 }))), "MAIL_INTEGRATION_UNSUPPORTED_VERSION");
  assert.equal(code(() => parseEnvelope(envelope({ eventType: "mail.send_email" }))), "MAIL_INTEGRATION_UNSUPPORTED_EVENT");
  assert.equal(code(() => parseEnvelope({ ...envelope(), extra: 1 })), "MAIL_INTEGRATION_UNKNOWN_FIELDS");
  assert.equal(code(() => parseEnvelope(envelope({ occurredAt: "yesterday" }))), "MAIL_VALIDATION_FAILED");
  assert.equal(code(() => parseDeliveryStatus({ ...envelope().data, status: "OPENED" })), "MAIL_VALIDATION_FAILED");
  assert.equal(code(() => parseMarketingTrigger({ triggerType: "karryam.trip_completed", triggerVersion: "1", contactEmail: "a@b.co" })), "MAIL_VALIDATION_FAILED");
});

test("message content, credentials and clinical data are rejected anywhere in data", () => {
  for (const key of ["html", "text", "body", "subject", "attachments", "patientId", "diagnosis", "medication", "password", "apiKey", "cardNumber", "dateOfBirth", "lab_result"]) {
    const data = { ...envelope().data, meta: { nested: { [key]: "x" } } };
    assert.throws(() => parseEnvelope(envelope({ data })), (error) => error.code === "MAIL_INTEGRATION_FORBIDDEN_CONTENT", key);
  }
  assert.throws(() => parseOpsAlert({ severity: "warning", code: "QUEUE_LAG", summary: "lag for jane@example.com", component: "outbox" }, { restricted: false }), /FORBIDDEN_CONTENT/);
  assert.throws(() => parseOpsAlert({ severity: "warning", code: "QUEUE_LAG", summary: "record 1234567 slow", component: "outbox" }, { restricted: true }), /FORBIDDEN_CONTENT/);
  // Restricted (health) alerts: the summary is a catalogue code, never free text.
  assert.throws(() => parseOpsAlert({ severity: "info", code: "QUEUE_LAG", summary: "outbox lag above 5m", component: "outbox" }, { restricted: true }), /FORBIDDEN_CONTENT/);
  assert.throws(() => parseOpsAlert({ severity: "info", code: "QUEUE_LAG", summary: "Patient flu symptoms rising", component: "outbox" }, { restricted: true }), /FORBIDDEN_CONTENT/);
  assert.equal(parseOpsAlert({ severity: "info", code: "QUEUE_LAG", summary: "QUEUE_BACKLOG", component: "outbox" }, { restricted: true }).summary, "QUEUE_BACKLOG");
  assert.equal(parseOpsAlert({ severity: "info", code: "QUEUE_LAG", summary: "outbox lag above 5m", component: "outbox" }, { restricted: false }).summary, "outbox lag above 5m", "standard integrations keep free text");
});

test("integrations default OFF", () => {
  const config = loadMailConfig({});
  assert.equal(config.integrations.enabled, false);
});

test("legacy transactional senders are unchanged and Mail never imports them", () => {
  // Tripwire: M1-M10 must not alter existing transactional mail. If these
  // files change intentionally, update the hashes in the same reviewed PR.
  const pinned = {
    "src/shared/config/mailer.js": "12b0c1eaaa4618a2aa795e74d3bac216403d87d87b9ee9258fa2a2d4691c09d0",
    // Changed intentionally by the P0 fix: no temporary passwords in email
    // (spec section 3); still the legacy transport, not imported by Mail.
    "src/shared/utils/email.util.js": "7fd1faaee1043877b2be3d8f95955a835112a1f64eab12c26f4dba0ab5229783",
  };
  const root = path.join(__dirname, "..");
  for (const [file, hash] of Object.entries(pinned)) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex"), hash, `${file} changed`);
  }
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
  for (const file of walk(path.join(root, "src/modules/mail"))) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /require\(["'][^"']*(nodemailer|shared\/config\/mailer|utils\/email\.util)["']\)/, file);
  }
});

// ---- Karryam Go compat shape + contract idempotency (spec section 15) ----
const karryamCompat = require("../src/modules/mail/integrations/karryam-compat");
const { idempotencyFingerprint } = require("../src/modules/mail/integrations/contracts");

const KG_INTEGRATION = { id: "11111111-2222-4333-8444-555555555555", product: "karryam", serviceName: "karryam-notification-service" };
const KG_ORG = { id: "99999999-2222-4333-8444-555555555555", slug: "karryam" };
// Field order and omitempty exactly as Go's encoding/json marshals
// KarryGo shared/go/notifications.Request (see tests/fixtures/karryam).
const kgRequest = (overrides = {}) => ({
  idempotency_key: "driver-hauling-service:booking.completed:b-1", source_service: "driver-hauling-service", event_type: "booking.completed",
  recipient: { type: "customer", id: "c-1", email: "Rider@Example.com" }, template_key: "booking.completed", data: { booking_id: "b-1" }, template_data: { booking_id: "b-1" }, ...overrides,
});
const compatCode = (body) => { try { karryamCompat.normalizeKarryamRequest(body, { integration: KG_INTEGRATION, organization: KG_ORG }); return null; } catch (error) { return { code: error.code, status: error.status, ...error.details }; } };

test("karryam compat: UUIDv5 derivation is RFC 4122 and namespaced per integration", () => {
  assert.equal(karryamCompat.uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2", "RFC 4122 v5 vector");
  const a = karryamCompat.deriveKarryamEventId(KG_INTEGRATION.id, "k");
  assert.equal(a, karryamCompat.deriveKarryamEventId(KG_INTEGRATION.id, "k"), "stable");
  assert.notEqual(a, karryamCompat.deriveKarryamEventId("22222222-2222-4333-8444-555555555555", "k"), "namespaced by integration");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("karryam compat: gated to the Karryam integration AND the env allowlist (default off)", () => {
  assert.equal(karryamCompat.isLegacyKarryamShape(kgRequest()), true);
  assert.equal(karryamCompat.isLegacyKarryamShape({ contractVersion: 1, idempotency_key: "x" }), false, "an envelope is never the legacy shape");
  assert.deepEqual(karryamCompat.compatDecision(KG_INTEGRATION, {}), { allowed: false, reason: "COMPAT_FLAG_OFF" });
  assert.deepEqual(karryamCompat.compatDecision(KG_INTEGRATION, { MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES: "karryam-notification-service" }), { allowed: true });
  assert.deepEqual(karryamCompat.compatDecision({ ...KG_INTEGRATION, product: "healthnet", serviceName: "x" }, { MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES: "x" }), { allowed: false, reason: "NOT_KARRYAM_INTEGRATION" });
  const error = karryamCompat.notEnabledError("COMPAT_FLAG_OFF");
  assert.equal(error.code, "MAIL_INTEGRATION_LEGACY_SHAPE_NOT_ENABLED");
  assert.equal(error.status, 422);
  assert.equal(error.details.flag, "MAIL_INTEGRATION_KARRYAM_COMPAT_SERVICES");
});

test("karryam compat: booking.completed maps to karryam.booking.completed@1 with org from the integration", () => {
  const { envelope: mapped } = karryamCompat.normalizeKarryamRequest(kgRequest({ data: { booking_id: "b-1", city: "Lagos" } }), { integration: KG_INTEGRATION, organization: KG_ORG, now: new Date("2026-10-26T00:00:00Z") });
  assert.deepEqual(mapped, {
    contractVersion: 1, product: "karryam", organization: "karryam", eventId: karryamCompat.deriveKarryamEventId(KG_INTEGRATION.id, "driver-hauling-service:booking.completed:b-1"),
    eventType: "marketing.trigger", eventVersion: 1, occurredAt: "2026-10-26T00:00:00.000Z",
    data: { triggerType: "karryam.booking.completed", triggerVersion: 1, contactEmail: "rider@example.com", attributes: { service: "hauling", city: "Lagos" } },
  });
  assert.doesNotThrow(() => parseEnvelope(mapped), "the mapped envelope is a valid contract-v1 envelope");
  assert.equal(JSON.stringify(mapped).includes("b-1\""), false, "booking_id is dropped");
});

test("karryam compat: content, PHI, phones, recipient lists, unknown fields and sender claims fail closed", () => {
  assert.equal(compatCode(kgRequest({ title: "Your trip" })).reason, "MESSAGE_CONTENT_NOT_ALLOWED");
  assert.equal(compatCode(kgRequest({ body: "hello" })).code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
  assert.equal(compatCode(kgRequest({ data: { diagnosis: "x" } })).code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
  assert.equal(compatCode(kgRequest({ template_data: { otp: "123456" } })).code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
  assert.equal(compatCode(kgRequest({ recipient: { type: "customer", id: "c", email: "a@b.co", phone: "+2348011111001" } })).reason, "RAW_CONTACT_DATA_NOT_ALLOWED");
  assert.equal(compatCode(kgRequest({ recipients: ["a@b.co"] })).reason, "RECIPIENT_LIST_NOT_ALLOWED");
  assert.equal(compatCode(kgRequest({ organization: "cosmicforge" })).code, "MAIL_INTEGRATION_UNKNOWN_FIELDS", "organization never comes from the payload");
  assert.equal(compatCode(kgRequest({ recipient: { type: "customer", id: "c", email: "a@b.co", name: "x" } })).code, "MAIL_INTEGRATION_UNKNOWN_FIELDS");
  assert.equal(compatCode(kgRequest({ event_type: "customer.auth.otp" })).reason, "OTP_NEVER_SENT_TO_HQ");
  const unsupported = compatCode(kgRequest({ event_type: "booking.accepted" }));
  assert.equal(unsupported.code, "MAIL_INTEGRATION_UNSUPPORTED_EVENT");
  assert.deepEqual(unsupported.supported, ["booking.completed"]);
  assert.equal(compatCode(kgRequest({ source_service: "customer-service" })).reason, "SOURCE_SERVICE_NOT_MAPPED");
  assert.equal(compatCode(kgRequest({ recipient: { type: "customer", id: "c" } })).reason, "KARRYAM_RECIPIENT_EMAIL_REQUIRED");
  assert.equal(compatCode(kgRequest({ recipient: { type: "provider", id: "p", email: "a@b.co" } })).reason, "CUSTOMER_RECIPIENT_REQUIRED");
  for (const key of ["from", "sender", "reply_to", "from_email"]) {
    const spoof = compatCode({ ...kgRequest(), [key]: "ceo@cosmicforge.example" });
    assert.equal(spoof.code, "MAIL_SENDER_NOT_AUTHORIZED", key);
    assert.equal(spoof.status, 403);
    assert.equal(spoof.claimedSender, "ceo@cosmicforge.example");
  }
  assert.equal(compatCode(kgRequest({ data: { sender: "hr@cosmicforge.example" } })).code, "MAIL_SENDER_NOT_AUTHORIZED", "nested sender claims too");
});

test("contract v1: reserved eventId prefixes and idempotency fingerprint", () => {
  assert.throws(() => parseEnvelope(envelope({ eventId: "idem:abc" })), (error) => error.details.reason === "RESERVED_EVENT_ID_PREFIX");
  assert.throws(() => parseEnvelope(envelope({ eventId: "rejected:abc" })), (error) => error.details.reason === "RESERVED_EVENT_ID_PREFIX");
  const a = parseEnvelope(envelope({ idempotencyKey: "k-1" }));
  const b = parseEnvelope(envelope({ idempotencyKey: "k-1", eventId: "evt-2", occurredAt: "2026-10-25T00:00:05Z" }));
  const c = parseEnvelope(envelope({ idempotencyKey: "k-1", eventId: "evt-3", data: { ...envelope().data, status: "BOUNCED" } }));
  assert.equal(idempotencyFingerprint(a), idempotencyFingerprint(b), "eventId and occurredAt do not change the logical event");
  assert.notEqual(idempotencyFingerprint(a), idempotencyFingerprint(c));
  const reordered = parseEnvelope(envelope({ idempotencyKey: "k-1", data: Object.fromEntries(Object.entries(envelope().data).reverse()) }));
  assert.equal(idempotencyFingerprint(a), idempotencyFingerprint(reordered), "key order does not matter");
});
