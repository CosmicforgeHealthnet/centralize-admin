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
  assert.equal(parseOpsAlert({ severity: "info", code: "QUEUE_LAG", summary: "outbox lag above 5m", component: "outbox" }, { restricted: true }).code, "QUEUE_LAG");
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
    "src/shared/utils/email.util.js": "9d5069a1b0197433663a5f7e98b8f0379150d7459997e3ee006b9d6f5deb0b68",
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
