"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyResendWebhook, signResendWebhook } = require("../webhooks/resend-webhook.verifier");
const { sanitizeEmailHtml } = require("../security/html-sanitizer");
const { normalizeAddress, parsePartyList } = require("../security/address.util");
const { assertHeaderSafe, normalizeSubject, parseReferences, normalizeMessageId } = require("../security/header-safety");
const { createMailEncryption } = require("../security/mail-encryption.service");
const { matchTotp, totpAt, decodeBase32 } = require("../../../shared/auth/mfa-core");
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
  // Mail step-up now uses the shared HQ verifier (src/shared/auth/mfa-core).
  assert.equal(matchTotp(secret, "287082", 59000), 1);
  assert.equal(matchTotp(secret, "000000", 59000), null);
  assert.equal(matchTotp(secret, "28708", 59000), null);
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

test("message status derivation handles PENDING recipients and never regresses event-derived states", () => {
  const rs = (...statuses) => statuses.map((status) => ({ status }));
  assert.equal(aggregateMessageStatus(rs("PENDING", "PENDING"), "QUEUED"), "QUEUED");
  assert.equal(aggregateMessageStatus(rs("INTERNAL_DELIVERED", "PENDING"), "QUEUED"), "QUEUED");
  assert.equal(aggregateMessageStatus(rs("PENDING", "PROVIDER_ACCEPTED"), "QUEUED"), "PROVIDER_ACCEPTED");
  assert.equal(aggregateMessageStatus(rs("PENDING", "DELIVERED"), "DELIVERED"), "PROVIDER_ACCEPTED");
  assert.equal(aggregateMessageStatus(rs("BOUNCED", "FAILED"), "BOUNCED"), "BOUNCED");
  assert.equal(aggregateMessageStatus(rs("BOUNCED", "PROVIDER_ACCEPTED"), "BOUNCED"), "BOUNCED");
  assert.equal(aggregateMessageStatus(rs("BOUNCED", "PENDING"), "BOUNCED"), "BOUNCED");
  assert.equal(aggregateMessageStatus(rs("DELIVERED", "DELAYED"), "DELIVERED"), "DELAYED");
  assert.equal(aggregateMessageStatus(rs("DELIVERED", "PROVIDER_ACCEPTED"), "DELAYED"), "PROVIDER_ACCEPTED");
  assert.equal(aggregateMessageStatus(rs("FAILED", "OUTCOME_UNKNOWN"), "QUEUED"), "OUTCOME_UNKNOWN");
  assert.equal(aggregateMessageStatus(rs("FAILED", "FAILED"), "QUEUED"), "FAILED");
  assert.equal(aggregateMessageStatus(rs("INTERNAL_DELIVERED"), "DELIVERED"), "DELIVERED");
  const { deriveMessageStatus } = require("../pipelines/delivery-event.processor");
  assert.equal(deriveMessageStatus, aggregateMessageStatus, "dispatch and delivery events share one derivation");
});

test("provider errors that may follow acceptance are treated as possibly accepted", () => {
  const { possiblyAccepted } = require("../pipelines/outbound.processor");
  const { MailProviderError } = require("../adapters/mail-provider.contract");
  assert.equal(possiblyAccepted(new MailProviderError("AMBIGUOUS", "PROVIDER_TIMEOUT", "x")), true);
  assert.equal(possiblyAccepted(new MailProviderError("RETRYABLE", "RESEND_HTTP_503", "x", { status: 503 })), true);
  assert.equal(possiblyAccepted(new MailProviderError("RETRYABLE", "RESEND_HTTP_500", "x")), true, "status parsed from code");
  assert.equal(possiblyAccepted(new MailProviderError("RETRYABLE", "RESEND_HTTP_409", "x", { status: 409 })), true, "concurrent same-key request");
  assert.equal(possiblyAccepted(new MailProviderError("RETRYABLE", "RESEND_HTTP_429", "x", { status: 429 })), false);
  assert.equal(possiblyAccepted(new MailProviderError("PERMANENT", "RESEND_HTTP_422", "x", { status: 422 })), false);
});

test("staff content policy blocks script-like link schemes and misleading link text", () => {
  const { assertContentPolicy } = require("../services/compose.service");
  const code = (html) => {
    try {
      assertContentPolicy(html);
      return null;
    } catch (error) {
      return error.errors?.[0]?.reason;
    }
  };
  assert.equal(code('<a href="javascript:alert(1)">x</a>'), "UNSAFE_LINK");
  assert.equal(code('<a href="data:text/html,hi">x</a>'), "UNSAFE_LINK");
  assert.equal(code('<a href="VBScript:x">x</a>'), "UNSAFE_LINK");
  assert.equal(code('<a href="https://evil.example/login">https://bank.example</a>'), "UNSAFE_LINK");
  assert.equal(code('<a href="https://www.bank.example/login">bank.example</a>'), null, "same site is fine");
  assert.equal(code('<a href="https://partner.example/doc">the report</a> <a href="mailto:a@b.example">mail</a>'), null);
  assert.equal(code("plain text only"), null);
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
  const domain = { domain: "cosmicforge.example", status: "VERIFIED", sendingStatus: "VERIFIED", organization: { id: "org-1", slug: "cosmicforge" } };
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

// ---- hardening regressions (d1, a4, c1): self-contained ----
test("d1: style values are checked after decoding entities/escapes; tracking CSS and fixed positioning are removed", () => {
  const { sanitizeEmailHtml: clean, safeStyle } = require("../security/html-sanitizer");
  const bypasses = [
    'style="background:u&#114;l(https://t.example/p.gif)"',
    'style="background:u&#x72;l(https://t.example/p.gif)"',
    'style="background-image:image-set(&quot;https://t.example/p.gif&quot; 1x)"',
    "style=\"background-image:-webkit-image-set('https://t.example/p.gif' 1x)\"",
    'style="background:\\75 rl(https://t.example/p.gif)"',
    'style="background:\\000075rl(https://t.example/p.gif)"',
    'style="background:u/**/rl(https://t.example/p.gif)"',
    'style="background:&amp;#117;rl(https://t.example/p.gif)"',
    'style="background:image(https://t.example/p.gif)"',
    'style="background:cross-fade(url(a),url(b),50%)"',
    'style="background:element(#x)"',
    'style="width:expression(alert(1))"',
    'style="x:1;@import \'https://t.example/a.css\'"',
    'style="position:fixed;top:0;left:0"',
    'style="position : sticky"',
    'style="POSITION:FIXED"',
  ];
  for (const attr of bypasses) {
    const { html } = clean(`<div ${attr}>x</div>`);
    assert.equal(html, "<div>x</div>", `not removed: ${attr}`);
    assert.doesNotMatch(html, /t\.example|style=/);
  }
  assert.equal(clean('<p style="color:red;font-size:12px;position:relative">ok</p>').html, '<p style="color:red;font-size:12px;position:relative">ok</p>');
  assert.equal(clean('<p style="font-family:&quot;Arial&quot;, sans-serif">ok</p>').html, '<p style="font-family:&quot;Arial&quot;, sans-serif">ok</p>');
  assert.equal(safeStyle("color:&#114;ed"), "color:red", "the checked (decoded) value is what is emitted");
});

test("d1: links whose text names another host, or punycode hosts, are flagged", () => {
  const { sanitizeEmailHtml: clean } = require("../security/html-sanitizer");
  assert.match(clean('<a href="https://evil.example/login">https://bank.example/login</a>').html, /data-suspicious="host-mismatch"/);
  assert.match(clean('<a href="https://xn--bnk-7ma.example/">bank</a>').html, /data-suspicious="punycode"/);
  assert.doesNotMatch(clean('<a href="https://www.bank.example/x">bank.example</a>').html, /data-suspicious/);
  assert.doesNotMatch(clean('<a href="https://mail.bank.example/x">bank.example</a>').html, /data-suspicious/);
  assert.doesNotMatch(clean('<a href="https://evil.example">Click here</a>').html, /data-suspicious/);
});

test("a4: policy refusals are quarantined SCAN_FAILED (POLICY_*), never INFECTED", async () => {
  const scanner = require("../scanning/attachment-scanner");
  const big = await scanner.evaluateAttachment(scanner.signatureScanner(), { filename: "report.pdf", contentType: "application/pdf", buffer: Buffer.alloc(2048), maxBytes: 1024 });
  assert.deepEqual([big.scanStatus, big.scanDetail, big.quarantined], ["SCAN_FAILED", "POLICY_SIZE_LIMIT", true]);
  const exe = await scanner.evaluateAttachment(scanner.signatureScanner(), { filename: "setup.exe", contentType: "application/octet-stream", buffer: Buffer.from("x"), maxBytes: 1024 });
  assert.deepEqual([exe.scanStatus, exe.scanDetail, exe.quarantined], ["SCAN_FAILED", "POLICY_BLOCKED_EXTENSION_EXE", true]);
  const pe = await scanner.evaluateAttachment(scanner.signatureScanner(), { filename: "doc.pdf", contentType: "application/pdf", buffer: Buffer.from("MZ\x90\x00"), maxBytes: 1024 });
  assert.equal(pe.scanStatus, "SCAN_FAILED");
  assert.equal(pe.scanDetail, "POLICY_EXECUTABLE_CONTENT");
  const virus = await scanner.evaluateAttachment(scanner.signatureScanner(), { filename: "a.txt", contentType: "text/plain", buffer: Buffer.from(scanner.EICAR), maxBytes: 1024 });
  assert.equal(virus.scanStatus, "INFECTED", "only a scanner detection is INFECTED");
  const hidden = await scanner.evaluateAttachment(scanner.signatureScanner(), { filename: "virus.com", contentType: "application/octet-stream", buffer: Buffer.from(scanner.EICAR), maxBytes: 1024 });
  assert.equal(hidden.scanStatus, "INFECTED", "malware behind a blocked name is still reported as malware");
});

test("c1: attachment downloads stream with a hard cap and refuse redirects", async () => {
  const { createResendAdapter: resend } = require("../adapters/resend.adapter");
  const config = { resend: { apiKey: "re_test", baseUrl: "https://api.resend.test", timeoutMs: 5000, attachmentHostAllowlist: ["files.resend.test"] } };
  let pulled = 0;
  let cancelled = false;
  let signal = null;
  let redirectMode = null;
  const listing = (url) => new Response(JSON.stringify({ data: [{ id: "a1", filename: "big.pdf", content_type: "application/pdf", download_url: url }] }), { status: 200 });
  const make = (respond) => resend({
    config,
    fetchImpl: async (url, init) => {
      if (url.startsWith("https://api.resend.test/")) return listing(url.includes("redir") ? "https://files.resend.test/redir" : "https://files.resend.test/a1");
      signal = init.signal;
      redirectMode = init.redirect;
      return respond(url);
    },
  });
  // Chunked response, no Content-Length, endless 256 KiB chunks.
  const chunked = make(() => new Response(new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(256 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 }));
  const [attachment] = await chunked.fetchInboundAttachments("em_1");
  await assert.rejects(attachment.download(1024 * 1024), (error) => error.code === "ATTACHMENT_TOO_LARGE" && error.kind === "PERMANENT");
  assert.ok(pulled <= 8, `stopped early (pulled ${pulled} chunks)`);
  assert.ok(cancelled && signal.aborted, "stream cancelled and request aborted");
  assert.equal(redirectMode, "error");

  // Within the cap: returned whole.
  const small = make(() => new Response(Buffer.from("hello"), { status: 200 }));
  assert.equal((await (await small.fetchInboundAttachments("em_2"))[0].download(1024)).toString(), "hello");
  // A declared oversize length is refused before reading.
  const declared = make(() => new Response("x", { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } }));
  await assert.rejects((await declared.fetchInboundAttachments("em_3"))[0].download(), (error) => error.code === "ATTACHMENT_TOO_LARGE");
  // A 3xx (fetch implementations that do not enforce redirect:"error") is refused.
  const redirect = make(() => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
  await assert.rejects((await redirect.fetchInboundAttachments("redir"))[0].download(), (error) => error.code === "ATTACHMENT_REDIRECT_REFUSED" && error.kind === "PERMANENT");
  const fakeRedirected = resend({ config, fetchImpl: async (url) => (url.startsWith("https://api.resend.test/") ? listing("https://files.resend.test/a1") : { ok: true, status: 200, redirected: true, headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(1) }) });
  await assert.rejects((await fakeRedirected.fetchInboundAttachments("em_4"))[0].download(), (error) => error.code === "ATTACHMENT_REDIRECT_REFUSED");
});
