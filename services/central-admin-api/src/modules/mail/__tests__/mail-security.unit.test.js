"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyResendWebhook, signResendWebhook } = require("../webhooks/resend-webhook.verifier");
const { sanitizeEmailHtml } = require("../security/html-sanitizer");
const { normalizeAddress, parsePartyList } = require("../security/address.util");
const { assertHeaderSafe, normalizeSubject, parseReferences, normalizeMessageId } = require("../security/header-safety");
const { createMailEncryption } = require("../security/mail-encryption.service");
const { matchTotp, totpAt, decodeBase32 } = require("../authz/step-up.service");
const { renderTemplate } = require("../marketing/template-renderer");
const { parseCsv, neutralizeCell } = require("../marketing/csv");
const { policyCheck, evaluateAttachment, signatureScanner, unavailableScanner, EICAR } = require("../scanning/attachment-scanner");
const { createEncryptedStore, memoryBackend } = require("../storage/mail-storage");
const { loadMailConfig } = require("../mail.config");
const { createResendAdapter } = require("../adapters/resend.adapter");
const { MailProviderError } = require("../adapters/mail-provider.contract");
const { backoffSeconds } = require("../jobs/mail-job.repository");
const { aggregateMessageStatus } = require("../pipelines/delivery-event.processor");

const SECRET = `whsec_${crypto.randomBytes(24).toString("base64")}`;

function signed(body, { id = "msg_test_1", timestamp = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const rawBody = Buffer.from(body);
  return { rawBody, headers: { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signResendWebhook({ id, timestamp, rawBody, secret }) } };
}

test("webhook verifier accepts valid signatures and rejects tampering, replay window and bad secrets", () => {
  const body = JSON.stringify({ type: "email.received", created_at: "2026-10-24T00:00:00Z", data: { email_id: "abc", to: ["a@b.co"] } });
  const valid = signed(body);
  const ok = verifyResendWebhook({ ...valid, secret: SECRET });
  assert.equal(ok.ok, true);
  assert.equal(ok.accepted, true);
  assert.equal(ok.eventId, "msg_test_1");

  const tampered = { ...valid, rawBody: Buffer.from(body.replace("abc", "abd")) };
  assert.equal(verifyResendWebhook({ ...tampered, secret: SECRET }).reason, "SIGNATURE_MISMATCH");
  // Whitespace changes the bytes: a re-serialised JSON body must not verify.
  const reserialised = { ...valid, rawBody: Buffer.from(JSON.stringify(JSON.parse(body), null, 2)) };
  assert.equal(verifyResendWebhook({ ...reserialised, secret: SECRET }).ok, false);

  const old = signed(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(verifyResendWebhook({ ...old, secret: SECRET }).reason, "TIMESTAMP_OUT_OF_TOLERANCE");
  assert.equal(verifyResendWebhook({ ...valid, secret: "" }).reason, "SECRET_NOT_CONFIGURED");
  assert.equal(verifyResendWebhook({ ...valid, secret: `whsec_${crypto.randomBytes(24).toString("base64")}` }).reason, "SIGNATURE_MISMATCH");
  assert.equal(verifyResendWebhook({ ...valid, headers: { ...valid.headers, "svix-signature": "" }, secret: SECRET }).reason, "MISSING_HEADERS");
  const big = signed(JSON.stringify({ type: "email.sent", data: { pad: "x".repeat(2000) } }));
  assert.equal(verifyResendWebhook({ ...big, secret: SECRET, maxBodyBytes: 1024 }).reason, "BODY_TOO_LARGE");
  const unknown = signed(JSON.stringify({ type: "contact.created", data: {} }));
  assert.equal(verifyResendWebhook({ ...unknown, secret: SECRET }).accepted, false);
  const schema = signed(JSON.stringify({ type: "email.sent" }));
  assert.equal(verifyResendWebhook({ ...schema, secret: SECRET }).reason, "INVALID_SCHEMA");
});

test("email HTML sanitizer removes active content and blocks remote tracking images", () => {
  const hostile = `<div onclick="steal()">Hi<script>alert(1)</script><img src="https://tracker.example/p.gif"><img src="cid:logo"><a href="javascript:alert(1)">x</a><a href="https://ok.example">ok</a><iframe src="https://x"></iframe><form action="https://x"><input name=p></form><svg onload=alert(1)></svg><p style="background:url(https://t.example)">s</p><style>body{}</style><meta http-equiv="refresh" content="0;url=https://x"></div>`;
  const blocked = sanitizeEmailHtml(hostile);
  for (const forbidden of ["<script", "onclick", "javascript:", "<iframe", "<form", "<svg", "url(", "<style", "<meta", "tracker.example"]) assert.ok(!blocked.html.includes(forbidden), forbidden);
  assert.equal(blocked.remoteImagesBlocked, 1);
  assert.match(blocked.html, /rel="noopener noreferrer nofollow"/);
  const allowed = sanitizeEmailHtml('<img src="https://cdn.example/a.png">', { allowRemoteImages: true });
  assert.match(allowed.html, /https:\/\/cdn\.example\/a\.png/);
  const httpImage = sanitizeEmailHtml('<img src="http://cdn.example/a.png">', { allowRemoteImages: true });
  assert.ok(!httpImage.html.includes("http://cdn.example"));
});

test("addresses, subjects and headers are normalized and injection-safe", () => {
  assert.equal(normalizeAddress("  Ada.Lovelace@Example.COM "), "ada.lovelace@example.com");
  for (const bad of ["a@b", "a b@c.com", "a@c.com\r\nBcc: x@y.com", "\"q\"@c.com", "a@[127.0.0.1]", "@c.com", "a@-c.com"]) assert.equal(normalizeAddress(bad), null, bad);
  const { parties, invalid } = parsePartyList(['"Ada" <ada@example.com>', "ada@example.com", "bad", { address: "Bob@Example.com", name: "Bob\r\nX" }]);
  assert.deepEqual(parties.map((party) => party.address), ["ada@example.com", "bob@example.com"]);
  assert.equal(parties[1].name, "BobX");
  assert.deepEqual(invalid, ["bad"]);
  assert.throws(() => assertHeaderSafe("Hello\r\nBcc: victim@example.com"), /Unsafe header/);
  assert.equal(normalizeSubject("Re: RE: Fwd: Quarterly report"), "quarterly report");
  assert.deepEqual(parseReferences("<a@x> <b@y> junk <a@x>"), ["<a@x>", "<b@y>"]);
  assert.equal(normalizeMessageId("id@host"), "<id@host>");
  assert.equal(normalizeMessageId("<bad id@host>"), null);
});

test("mail encryption is AEAD with purpose binding and key rotation", () => {
  const k1 = crypto.randomBytes(32).toString("base64");
  const k2 = crypto.randomBytes(32).toString("base64");
  const v1 = createMailEncryption({ keys: `v1:${k1}`, activeKey: "v1" });
  const envelope = v1.encrypt("secret body", "mail-body:key1");
  const rotated = createMailEncryption({ keys: `v1:${k1},v2:${k2}`, activeKey: "v2" });
  assert.equal(rotated.decrypt(envelope, "mail-body:key1").toString(), "secret body");
  assert.throws(() => rotated.decrypt(envelope, "mail-body:key2"));
  const tampered = Buffer.from(envelope);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => rotated.decrypt(tampered, "mail-body:key1"));
  const none = createMailEncryption({ keys: "" });
  assert.equal(none.available, false);
  assert.throws(() => none.encrypt("x", "p"), /not configured/);
});

test("storage encrypts at rest, verifies checksums and fails closed", async () => {
  const backend = memoryBackend();
  const store = createEncryptedStore({ encryption: createMailEncryption({ keys: `v1:${crypto.randomBytes(32).toString("base64")}` }), backend });
  const stored = await store.put("body", Buffer.from("hello private mail"), { purpose: "mail-body" });
  const raw = backend.objects.get(stored.key);
  assert.ok(!raw.includes(Buffer.from("hello private mail")), "ciphertext must not contain plaintext");
  assert.equal((await store.get(stored.key, { purpose: "mail-body", sha256: stored.sha256 })).toString(), "hello private mail");
  await assert.rejects(store.get(stored.key, { purpose: "mail-body", sha256: "0".repeat(64) }), /integrity/);
  const unavailable = createEncryptedStore({ encryption: createMailEncryption({ keys: "" }), backend });
  assert.equal(unavailable.available, false);
  await assert.rejects(unavailable.put("body", Buffer.from("x"), { purpose: "p" }), (error) => error.code === "MAIL_STORAGE_UNAVAILABLE");
});

test("TOTP step-up matches RFC 6238 vectors and rejects malformed codes", () => {
  // RFC 6238 SHA-1 secret "12345678901234567890" at T=59s -> 94287082 (8 digits) => 287082 (6 digits)
  const secret = Buffer.from("12345678901234567890");
  assert.equal(totpAt(secret, Math.floor(59 / 30)), "287082");
  assert.equal(matchTotp(secret, "287082", { now: 59000 }), 1);
  assert.equal(matchTotp(secret, "000000", { now: 59000 }), null);
  assert.equal(matchTotp(secret, "28708", { now: 59000 }), null);
  assert.equal(decodeBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString(), "12345678901234567890");
  assert.equal(decodeBase32("not base32!"), null);
});

test("attachment policy quarantines executables, EICAR and unscanned files", async () => {
  assert.equal(policyCheck({ filename: "invoice.pdf.exe", contentType: "application/pdf", buffer: Buffer.from("x"), maxBytes: 100 }).allowed, false);
  assert.equal(policyCheck({ filename: "doc.pdf", contentType: "application/pdf", buffer: Buffer.from("MZ\x90\x00"), maxBytes: 100 }).reason, "EXECUTABLE_CONTENT");
  const infected = await evaluateAttachment(signatureScanner(), { filename: "a.txt", contentType: "text/plain", buffer: Buffer.from(EICAR), maxBytes: 1000 });
  assert.equal(infected.scanStatus, "INFECTED");
  assert.equal(infected.quarantined, true);
  const clean = await evaluateAttachment(signatureScanner(), { filename: "a.txt", contentType: "text/plain", buffer: Buffer.from("hello"), maxBytes: 1000 });
  assert.equal(clean.quarantined, false);
  const unscanned = await evaluateAttachment(unavailableScanner(), { filename: "a.txt", contentType: "text/plain", buffer: Buffer.from("hello"), maxBytes: 1000 });
  assert.equal(unscanned.scanStatus, "SCANNER_UNAVAILABLE");
  assert.equal(unscanned.quarantined, true, "no scanner means quarantine (fail closed)");
});

test("template renderer escapes content, enforces https and variable allowlist", () => {
  const rendered = renderTemplate({ subject: "Hi {{first_name}}", blocks: [{ type: "heading", text: "<script>x</script>" }, { type: "button", label: "Book", url: "https://health.example/book" }, { type: "image", src: "https://cdn.example/i.png", alt: "" }] }, { data: { first_name: "<b>Ada</b>" } });
  assert.ok(!rendered.html.includes("<script>"));
  assert.ok(!rendered.html.includes("<b>Ada</b>"));
  assert.match(rendered.html, /Unsubscribe/);
  assert.ok(rendered.accessibility.some((check) => check.id === "image-alt"));
  assert.throws(() => renderTemplate({ subject: "x", blocks: [{ type: "text", text: "{{password}}" }] }), (error) => error.code === "MAIL_TEMPLATE_INVALID_VARIABLE");
  assert.throws(() => renderTemplate({ subject: "x", blocks: [{ type: "button", label: "x", url: "javascript:alert(1)" }] }), (error) => error.code === "MAIL_VALIDATION_FAILED");
  assert.throws(() => renderTemplate({ subject: "x", blocks: [{ type: "unknown" }] }));
});

test("CSV parser handles quoting and neutralises formula injection", () => {
  const rows = parseCsv('email,first_name\n"a@b.co","Ada, Countess"\r\nb@c.co,"=HYPERLINK(""x"")"\n');
  assert.deepEqual(rows[1], ["a@b.co", "Ada, Countess"]);
  assert.equal(rows[2][1], '=HYPERLINK("x")');
  assert.equal(neutralizeCell("=1+1"), "'=1+1");
  assert.equal(neutralizeCell("@SUM(A1)"), "'@SUM(A1)");
  assert.throws(() => parseCsv('a,"b'), /UNTERMINATED/);
  assert.throws(() => parseCsv("x\n".repeat(20), { maxRows: 5 }), /TOO_MANY_ROWS/);
});

test("config defaults keep every live capability off", () => {
  const config = loadMailConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.sendingEnabled, false);
  assert.equal(config.receivingEnabled, false);
  assert.equal(config.marketingEnabled, false);
  assert.equal(config.workerEnabled, false);
  assert.equal(config.storage.provider, "unavailable");
  assert.equal(config.scanning.provider, "unavailable");
  // Sub-flags cannot enable anything while MAIL_ENABLED is off.
  assert.equal(loadMailConfig({ MAIL_SENDING_ENABLED: "true" }).sendingEnabled, false);
});

test("Resend adapter classifies timeouts as ambiguous and never leaks provider shapes", async () => {
  const config = loadMailConfig({ MAIL_ENABLED: "true", RESEND_API_KEY: "re_test_offline", RESEND_TIMEOUT_MS: "1000" });
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: "email_123" }) };
  };
  const adapter = createResendAdapter({ config, fetchImpl: okFetch });
  const result = await adapter.sendMessage({ idempotencyKey: "send:1", from: { address: "a@b.co", name: "A" }, to: [{ address: "c@d.co" }], cc: [], bcc: [], subject: "s", html: "<p>x</p>", text: "x", headers: { "Message-ID": "<1@b.co>" }, attachments: [] });
  assert.deepEqual(result, { providerMessageId: "email_123" });
  assert.equal(calls[0].init.headers["Idempotency-Key"], "send:1");
  assert.equal(calls[0].init.redirect, "error");
  const failing = createResendAdapter({ config, fetchImpl: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
  await assert.rejects(failing.sendMessage({ idempotencyKey: "k", from: { address: "a@b.co" }, to: [{ address: "c@d.co" }], subject: "s" }), (error) => error instanceof MailProviderError && error.kind === "AMBIGUOUS");
  const throttled = createResendAdapter({ config, fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => "7" }, text: async () => "{}" }) });
  await assert.rejects(throttled.sendMessage({ idempotencyKey: "k", from: { address: "a@b.co" }, to: [{ address: "c@d.co" }], subject: "s" }), (error) => error.kind === "RETRYABLE" && error.retryAfterSeconds === 7);
  const invalid = createResendAdapter({ config, fetchImpl: async () => ({ ok: false, status: 422, headers: { get: () => null }, text: async () => '{"message":"bad from"}' }) });
  await assert.rejects(invalid.sendMessage({ idempotencyKey: "k", from: { address: "a@b.co" }, to: [{ address: "c@d.co" }], subject: "s" }), (error) => error.kind === "PERMANENT");
  // Attachment downloads only from allowlisted https hosts (SSRF guard).
  const inbound = createResendAdapter({ config, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ id: "1", filename: "a.txt", download_url: "https://169.254.169.254/latest" }] }) }) });
  const [attachment] = await inbound.fetchInboundAttachments("email_1");
  await assert.rejects(attachment.download(), (error) => error.code === "ATTACHMENT_URL_NOT_ALLOWED");
  const unconfigured = createResendAdapter({ config: loadMailConfig({}), fetchImpl: okFetch });
  await assert.rejects(unconfigured.sendMessage({}), (error) => error.kind === "NOT_CONFIGURED");
});

test("backoff is bounded with jitter and delivery status never claims more than evidence", () => {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const value = backoffSeconds(attempt, { random: () => 1 });
    assert.ok(value <= 3600 && value >= 1);
  }
  assert.equal(aggregateMessageStatus([{ status: "PROVIDER_ACCEPTED" }], "PROVIDER_ACCEPTED"), "PROVIDER_ACCEPTED");
  assert.equal(aggregateMessageStatus([{ status: "DELIVERED" }, { status: "PROVIDER_ACCEPTED" }], "PROVIDER_ACCEPTED"), "PROVIDER_ACCEPTED");
  assert.equal(aggregateMessageStatus([{ status: "DELIVERED" }, { status: "INTERNAL_DELIVERED" }], "PROVIDER_ACCEPTED"), "DELIVERED");
  assert.equal(aggregateMessageStatus([{ status: "DELIVERED" }, { status: "BOUNCED" }], "DELIVERED"), "BOUNCED");
});

test("delivery plan sends only external (PENDING) recipients and never exposes BCC", () => {
  const { buildDeliveryPlan } = require("../pipelines/outbound.processor");
  const r = (id, type, status = "PENDING") => ({ id, type, status, address: `${id}@x.example` });
  assert.deepEqual(buildDeliveryPlan([r("in", "TO", "INTERNAL_DELIVERED"), r("ext", "TO")]), [{ to: ["ext"], cc: [], bcc: [] }]);
  assert.deepEqual(buildDeliveryPlan([r("ext", "TO"), r("in", "CC", "INTERNAL_DELIVERED")]), [{ to: ["ext"], cc: [], bcc: [] }]);
  assert.deepEqual(buildDeliveryPlan([r("ext", "TO"), r("in", "BCC", "INTERNAL_DELIVERED"), r("eb", "BCC")]), [{ to: ["ext"], cc: [], bcc: ["eb"] }]);
  assert.deepEqual(buildDeliveryPlan([r("in", "TO", "INTERNAL_DELIVERED"), r("ec", "CC")]), [{ to: ["ec"], cc: [], bcc: [], promotedCc: true }]);
  assert.deepEqual(buildDeliveryPlan([r("b1", "BCC"), r("b2", "BCC")]), [{ to: ["b1"], cc: [], bcc: [], individualBcc: true }, { to: ["b2"], cc: [], bcc: [], individualBcc: true }]);
  assert.deepEqual(buildDeliveryPlan([r("in", "TO", "INTERNAL_DELIVERED")]), []);
});

test("Resend 409 invalid_idempotent_request is an unknown outcome, concurrent 409 is retryable", async () => {
  const config = loadMailConfig({ MAIL_ENABLED: "true", RESEND_API_KEY: "re_test_offline" });
  const reply = (name) => async () => ({ ok: false, status: 409, headers: { get: () => null }, text: async () => JSON.stringify({ name, message: name }) });
  const request = { idempotencyKey: "k", from: { address: "a@b.co" }, to: [{ address: "c@d.co" }], subject: "s" };
  await assert.rejects(createResendAdapter({ config, fetchImpl: reply("invalid_idempotent_request") }).sendMessage(request), (error) => error.kind === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(createResendAdapter({ config, fetchImpl: reply("concurrent_idempotent_requests") }).sendMessage(request), (error) => error.kind === "RETRYABLE");
  assert.equal(loadMailConfig({ MAIL_PROVIDER_IDEMPOTENCY_WINDOW_HOURS: "48" }).reconciliation.idempotencyWindowHours, 23, "window can never exceed the provider's 24h key retention");
  assert.equal(loadMailConfig({ MAIL_MAX_RECIPIENTS: "500" }).limits.maxRecipients, 50);
});

test("sanitizer escapes attribute values so quotes cannot inject event handlers", () => {
  const payloads = [
    `<td width='x" onmouseover="alert(1)'>a</td>`,
    `<a title='a" onclick="x()' href="https://ok.example">t</a>`,
    `<p class='a"><script>x</script>'>z</p>`,
    `<img alt='" onerror="x' src="cid:1">`,
    `<table bgcolor='"><svg onload=alert(1)>'><tr><td>x</td></tr></table>`,
  ];
  for (const payload of payloads) {
    const { html } = sanitizeEmailHtml(payload);
    assert.ok(!/\son[a-z]+\s*=\s*"/i.test(html), html);
    assert.ok(!/<script|<svg/i.test(html), html);
  }
});

test("external send gate denies every unsafe configuration and allows only the fully-configured case", () => {
  const { externalSendBlockReason, SEND_BLOCK_REASONS: R } = require("../authz/sending-gate");
  const ok = loadMailConfig({ MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example" });
  const domain = { domain: "cosmicforge.example", status: "VERIFIED", sendingStatus: "VERIFIED" };
  const gate = (overrides = {}) => externalSendBlockReason({ config: ok, providerReady: () => true, domain, ...overrides });
  assert.equal(gate(), null);
  assert.equal(gate({ config: loadMailConfig({ MAIL_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example" }) }), R.SENDING_DISABLED);
  assert.equal(gate({ config: loadMailConfig({ MAIL_SENDING_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example" }) }), R.SENDING_DISABLED);
  assert.equal(gate({ providerReady: () => false }), R.PROVIDER_NOT_CONFIGURED);
  assert.equal(gate({ config: loadMailConfig({ MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true" }) }), R.ALLOWLIST_EMPTY);
  assert.equal(gate({ config: loadMailConfig({ MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: " , " }) }), R.ALLOWLIST_EMPTY);
  assert.equal(gate({ domain: { ...domain, domain: "unrelated.example" } }), R.NOT_ALLOWLISTED);
  assert.equal(gate({ domain: { ...domain, domain: "sub.cosmicforge.example" } }), R.NOT_ALLOWLISTED, "no implicit subdomain match");
  assert.equal(gate({ domain: null }), R.NOT_ALLOWLISTED);
  assert.equal(gate({ domain: { ...domain, status: "SUSPENDED" } }), R.SENDING_SUSPENDED);
  assert.equal(gate({ domain: { ...domain, sendingStatus: "DISABLED" } }), R.SENDING_SUSPENDED);
  assert.equal(gate({ domain: { ...domain, status: "PENDING_VERIFICATION" } }), R.NOT_VERIFIED);
  assert.equal(gate({ domain: { ...domain, sendingStatus: "PENDING" } }), R.NOT_VERIFIED);
});

test("body search indexing cannot be enabled by configuration", () => {
  const config = loadMailConfig({ MAIL_SEARCH_INDEX_BODIES: "true" });
  assert.equal(config.search.bodies, false);
  assert.equal(config.search.bodyIndexingRequestRefused, true);
  assert.equal(loadMailConfig({}).search.bodyIndexingRequestRefused, false);
});
