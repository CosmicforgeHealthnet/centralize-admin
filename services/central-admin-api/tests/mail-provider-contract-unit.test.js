"use strict";

// §17/§18: provider-neutral contract, Resend error/limit/domain mapping,
// route-specific body limits, webhook byte preservation through app.js,
// readiness and session assessment. Offline: every provider response is a
// deterministic fixture served by an injected fetch (no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createApp, redactLoggedUrl } = require("../src/app");
const { closeServer } = require("./helpers/server-close");
const { MailProviderError, PROVIDER_ERROR_CATEGORIES } = require("../src/modules/mail/adapters/mail-provider.contract");
const { classifyResendResponse, rateLimitFromHeaders } = require("../src/modules/mail/adapters/resend-errors");
const { createResendAdapter, createRequestPacer } = require("../src/modules/mail/adapters/resend.adapter");
const { withTransportContract, withMarketingContract, createMailProviderContract, CONTRACT_OPERATIONS } = require("../src/modules/mail/adapters/provider-contract");
const { createFakeAdapter } = require("../src/modules/mail/adapters/fake.adapter");
const { notConfiguredAdapter } = require("../src/modules/mail/adapters");
const { jsonShapeProblem, isRichBodyRoute, richLimitBytes } = require("../src/modules/mail/http/body-limits");
const { createDependencyReadiness } = require("../src/modules/mail/ops/dependency-readiness");
const { assessMailSession } = require("../src/modules/mail/security/session-assessment");
const { verifyResendWebhook, signResendWebhook } = require("../src/modules/mail/webhooks/resend-webhook.verifier");
const { errorHandler } = require("../src/shared/middlewares/error.middleware");

const config = { resend: { apiKey: "re_test_offline", baseUrl: "https://api.resend.test", timeoutMs: 2000, attachmentHostAllowlist: ["resend.app"] } };

function response(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => map.get(name.toLowerCase()) ?? null }, text: async () => (body == null ? "" : JSON.stringify(body)) };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls.length);
  };
  return { fetchImpl, calls };
}

const sendRequest = (overrides = {}) => ({ idempotencyKey: "outbound:1:0", from: { address: "staff@cf.test", name: "Staff" }, to: [{ address: "a@x.test" }], subject: "Hello", text: "Hi", ...overrides });

// ---------------------------------------------------------------- errors
test("§18 Resend error catalogue maps every documented status/name to a kind and category", () => {
  const cases = [
    [400, "invalid_idempotency_key", "", "PERMANENT", "VALIDATION_FAILED"],
    [400, "validation_error", "Invalid `to` field", "PERMANENT", "VALIDATION_FAILED"],
    [400, "validation_error", "API key is invalid", "PERMANENT", "AUTHENTICATION_FAILED"],
    [401, "missing_api_key", "", "PERMANENT", "AUTHENTICATION_FAILED"],
    [401, "restricted_api_key", "", "PERMANENT", "PERMISSION_DENIED"],
    [401, "validation_error", "API key is invalid", "PERMANENT", "AUTHENTICATION_FAILED"],
    [403, "email_above_quota", "", "PERMANENT", "QUOTA_EXCEEDED"],
    [403, "invalid_permission", "", "PERMANENT", "PERMISSION_DENIED"],
    [403, "restricted_api_key", "API key is not active", "PERMANENT", "PERMISSION_DENIED"],
    [403, "suspended_api_key", "", "PERMANENT", "AUTHENTICATION_FAILED"],
    [403, "validation_error", "You can only send testing emails to your own email address", "PERMANENT", "PERMISSION_DENIED"],
    [403, "validation_error", "The cf.test domain is not verified. Please, add and verify your domain", "PERMANENT", "DOMAIN_NOT_VERIFIED"],
    [403, "validation_error", "The domain is registered to another account", "PERMANENT", "PERMISSION_DENIED"],
    [403, "validation_error", "Included inbox limit reached", "PERMANENT", "QUOTA_EXCEEDED"],
    [403, "", "", "PERMANENT", "PERMISSION_DENIED"],
    [404, "not_found", "", "PERMANENT", "NOT_FOUND"],
    [405, "method_not_allowed", "", "PERMANENT", "NOT_SUPPORTED"],
    [409, "concurrent_idempotent_requests", "", "RETRYABLE", "CONFLICT"],
    [409, "invalid_idempotent_request", "", "IDEMPOTENCY_CONFLICT", "OUTCOME_UNKNOWN"],
    [409, "resource_locked", "", "RETRYABLE", "CONFLICT"],
    [422, "invalid_attachment", "", "PERMANENT", "VALIDATION_FAILED"],
    [422, "invalid_parameter", "", "PERMANENT", "VALIDATION_FAILED"],
    [422, "missing_required_field", "", "PERMANENT", "VALIDATION_FAILED"],
    [422, "validation_error", "Invalid email address in `to`", "PERMANENT", "INVALID_RECIPIENT"],
    [429, "daily_quota_exceeded", "", "RETRYABLE", "QUOTA_EXCEEDED"],
    [429, "monthly_quota_exceeded", "", "RETRYABLE", "QUOTA_EXCEEDED"],
    [429, "rate_limit_exceeded", "", "RETRYABLE", "RATE_LIMITED"],
    [500, "application_error", "", "RETRYABLE", "PROVIDER_UNAVAILABLE"],
    [503, "service_unavailable", "", "RETRYABLE", "PROVIDER_UNAVAILABLE"],
  ];
  for (const [status, name, message, kind, category] of cases) {
    const result = classifyResendResponse(status, name, message);
    assert.deepEqual(result, { kind, category }, `${status} ${name} ${message}`);
    assert.ok(PROVIDER_ERROR_CATEGORIES.includes(result.category));
  }
});

test("§18 MailProviderError: default categories, retryability and a safe description", () => {
  assert.equal(new MailProviderError("AMBIGUOUS", "X", "m").category, "OUTCOME_UNKNOWN");
  assert.equal(new MailProviderError("AMBIGUOUS", "X", "m").retryable, false, "an unknown outcome is never retried blindly");
  assert.equal(new MailProviderError("RETRYABLE", "X", "m").retryable, true);
  assert.equal(new MailProviderError("NOT_CONFIGURED", "X", "m").category, "NOT_CONFIGURED");
  assert.equal(new MailProviderError("PERMANENT", "X", "m", { category: "BOGUS" }).category, "VALIDATION_FAILED", "unknown categories are not accepted");
  const described = new MailProviderError("PERMANENT", "RESEND_HTTP_403", "contains staff@cf.test", { status: 403, category: "DOMAIN_NOT_VERIFIED", providerErrorName: "validation_error", operation: "sendMessage" }).describe();
  assert.deepEqual(Object.keys(described).sort(), ["category", "code", "kind", "operation", "provider", "providerErrorName", "rateLimit", "retryAfterSeconds", "retryable", "status"].sort());
  assert.equal(JSON.stringify(described).includes("staff@cf.test"), false, "descriptions never carry the provider message");
});

test("§18 rate-limit headers are read exactly as documented (never invented)", () => {
  assert.deepEqual(rateLimitFromHeaders({ get: (name) => ({ "ratelimit-limit": "10", "ratelimit-remaining": "0", "ratelimit-reset": "1", "retry-after": "2" })[name] ?? null }), { limit: 10, remaining: 0, resetSeconds: 1, retryAfterSeconds: 2 });
  assert.equal(rateLimitFromHeaders({ get: () => null }), null);
});

// ---------------------------------------------------------------- transport
test("§18 Resend send: 429 carries category, retry-after and rate-limit metadata; 403 unverified domain is DOMAIN_NOT_VERIFIED", async () => {
  const limited = createResendAdapter({ config, fetchImpl: async () => response(429, { name: "rate_limit_exceeded", message: "Too many requests" }, { "ratelimit-limit": "10", "ratelimit-remaining": "0", "ratelimit-reset": "1", "retry-after": "1" }) });
  await assert.rejects(limited.sendMessage(sendRequest()), (error) => error.kind === "RETRYABLE" && error.category === "RATE_LIMITED" && error.retryAfterSeconds === 1 && error.rateLimit.remaining === 0 && error.operation === "sendMessage");
  const unverified = createResendAdapter({ config, fetchImpl: async () => response(403, { name: "validation_error", message: "The cf.test domain is not verified" }) });
  await assert.rejects(unverified.sendMessage(sendRequest()), (error) => error.kind === "PERMANENT" && error.category === "DOMAIN_NOT_VERIFIED");
  const quota = createResendAdapter({ config, fetchImpl: async () => response(429, { name: "daily_quota_exceeded", message: "quota" }) });
  await assert.rejects(quota.sendMessage(sendRequest()), (error) => error.category === "QUOTA_EXCEEDED" && error.errorKind === "QUOTA_EXHAUSTED");
  const timeout = createResendAdapter({ config, fetchImpl: async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  } });
  await assert.rejects(timeout.sendMessage(sendRequest()), (error) => error.kind === "AMBIGUOUS" && error.category === "OUTCOME_UNKNOWN" && error.code === "PROVIDER_TIMEOUT");
  await assert.rejects(timeout.validateDomain("dom_1"), (error) => error.kind === "RETRYABLE" && error.category === "TIMEOUT", "a read timeout is retryable");
});

test("§18 Resend send: documented limits are enforced before any network call", async () => {
  const { fetchImpl, calls } = recordingFetch(async () => response(200, { id: "em_1" }));
  const adapter = createResendAdapter({ config, fetchImpl });
  const many = Array.from({ length: 51 }, (_, index) => ({ address: `r${index}@x.test` }));
  await assert.rejects(adapter.sendMessage(sendRequest({ to: many })), (error) => error.code === "TOO_MANY_RECIPIENTS" && error.category === "VALIDATION_FAILED" && error.kind === "PERMANENT");
  await assert.rejects(adapter.sendMessage(sendRequest({ idempotencyKey: "" })), { code: "IDEMPOTENCY_KEY_INVALID" });
  await assert.rejects(adapter.sendMessage(sendRequest({ idempotencyKey: "k".repeat(257) })), { code: "IDEMPOTENCY_KEY_INVALID" });
  await assert.rejects(adapter.sendMessage(sendRequest({ headers: { "X-Test": "a\r\nBcc: evil@x.test" } })), { code: "HEADER_INVALID" });
  // 30 MB raw = 40 MB + a little once Base64 encoded (documented limit is post-encoding).
  const big = Buffer.alloc(30 * 1024 * 1024 + 3);
  await assert.rejects(adapter.sendMessage(sendRequest({ attachments: [{ filename: "a.bin", contentType: "application/octet-stream", content: big }] })), { code: "ATTACHMENTS_TOO_LARGE" });
  assert.equal(calls.length, 0, "nothing was submitted to the provider");

  const ok = await adapter.sendMessage(sendRequest({ cc: [{ address: "c@x.test" }], bcc: [{ address: "b@x.test" }], replyTo: "reply@cf.test", headers: { "Message-ID": "<m1@cf.test>", "In-Reply-To": "<m0@cf.test>", References: "<m0@cf.test>" } }));
  assert.equal(ok.providerMessageId, "em_1");
  const sent = calls[0];
  assert.equal(sent.url, "https://api.resend.test/emails");
  assert.equal(sent.headers["Idempotency-Key"], "outbound:1:0");
  assert.equal(sent.headers["User-Agent"], "cosmicforge-mail/1", "Resend rejects requests without a User-Agent");
  assert.deepEqual(sent.body.bcc, ["b@x.test"]);
  assert.equal(sent.body.headers["Message-ID"], "<m1@cf.test>");
  assert.equal(JSON.stringify(sent.body.headers).includes("b@x.test"), false, "Bcc never appears in a header");
});

test("§18 received attachments: all pages are listed; an expired signed link (403) is retryable, a missing object stays permanent", async () => {
  const { fetchImpl, calls } = recordingFetch(async (url) => {
    if (url.endsWith("/attachments")) return response(200, { object: "list", has_more: true, data: [{ id: "a1", filename: "one.pdf", size: 3, content_type: "application/pdf", download_url: "https://cdn.resend.app/a1", expires_at: "2026-10-26T12:00:00Z" }] });
    if (url.includes("/attachments?limit=100&after=a1")) return response(200, { object: "list", has_more: false, data: [{ id: "a2", filename: "two.png", size: 3, content_type: "image/png", content_disposition: "inline", content_id: "<img1>", download_url: "https://cdn.resend.app/a2" }] });
    if (url === "https://cdn.resend.app/a1") return { ...response(403, null), redirected: false, body: null };
    if (url === "https://cdn.resend.app/a2") return { ...response(404, null), redirected: false, body: null };
    throw new Error(`unexpected ${url}`);
  });
  const adapter = createResendAdapter({ config, fetchImpl });
  const list = await adapter.fetchInboundAttachments("em_in_1");
  assert.deepEqual(list.map((item) => item.providerAttachmentId), ["a1", "a2"]);
  assert.equal(list[1].inline, true);
  assert.equal(list[1].contentId, "img1");
  assert.ok(list[0].expiresAt instanceof Date);
  await assert.rejects(list[0].download(), (error) => error.kind === "RETRYABLE" && error.code === "ATTACHMENT_URL_EXPIRED");
  await assert.rejects(list[1].download(), (error) => error.kind === "PERMANENT" && error.code === "ATTACHMENT_HTTP_404");
  assert.equal(calls.filter((call) => call.url.includes("/emails/receiving/")).length, 2);
});

test("§18 domains: status/records/capabilities mapping, create, verify trigger and lookup use documented endpoints", async () => {
  const domain = {
    id: "dom_1", name: "Mail.CF.test", status: "partially_verified", region: "eu-west-1", capabilities: { sending: "enabled", receiving: "enabled" },
    records: [
      { record: "SPF", type: "MX", name: "send", value: "feedback-smtp.eu-west-1.amazonses.com", status: "verified", ttl: "Auto", priority: 10 },
      { record: "SPF", type: "TXT", name: "send", value: "v=spf1 include:amazonses.com ~all", status: "verified", ttl: "Auto" },
      { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=...", status: "pending", ttl: "Auto" },
      { record: "Receiving", type: "MX", name: "@", value: "inbound-smtp.eu-west-1.amazonaws.com", status: "failed", ttl: "Auto", priority: 10 },
    ],
  };
  const { fetchImpl, calls } = recordingFetch(async (url, init) => {
    if (init.method === "POST" && url.endsWith("/domains")) return response(200, { ...domain, status: "not_started" });
    if (init.method === "POST" && url.endsWith("/verify")) return response(200, { object: "domain", id: "dom_1" });
    if (url.includes("/domains?limit=100")) return response(200, { has_more: false, data: [{ id: "dom_1", name: "mail.cf.test" }] });
    return response(200, domain);
  });
  const adapter = createResendAdapter({ config, fetchImpl });
  const state = await adapter.validateDomain("dom_1");
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.spfStatus, "VERIFIED");
  assert.equal(state.dkimStatus, "PENDING");
  assert.equal(state.sendingStatus, "PENDING");
  assert.equal(state.receivingStatus, "FAILED");
  assert.equal(state.dmarcStatus, "NOT_REPORTED", "DMARC is never claimed: Resend does not report it");
  assert.equal(state.name, "mail.cf.test");
  const created = await adapter.createDomain({ name: "mail.cf.test", region: "eu-west-1", receiving: true });
  assert.equal(created.status, "NOT_STARTED");
  assert.deepEqual(calls.at(-1).body, { name: "mail.cf.test", region: "eu-west-1", capabilities: { sending: "enabled", receiving: "enabled" } });
  await assert.rejects(adapter.createDomain({ name: "not a domain" }), { code: "DOMAIN_NAME_INVALID" });
  assert.deepEqual(await adapter.verifyDomain("dom_1"), { providerDomainId: "dom_1", status: "PENDING" });
  assert.equal(calls.at(-1).url, "https://api.resend.test/domains/dom_1/verify");
  assert.equal((await adapter.findDomainByName("MAIL.cf.test")).providerDomainId, "dom_1");
  const disabledReceiving = createResendAdapter({ config, fetchImpl: async () => response(200, { ...domain, capabilities: { sending: "enabled", receiving: "disabled" } }) });
  assert.equal((await disabledReceiving.validateDomain("dom_1")).receivingStatus, "DISABLED");
});

test("§18 health probe distinguishes unconfigured, misconfigured, degraded and unavailable providers", async () => {
  const probe = (status, name) => createResendAdapter({ config, fetchImpl: async () => response(status, status === 200 ? { data: [] } : { name }) }).healthProbe();
  assert.equal((await probe(200)).status, "OK");
  assert.equal((await probe(401, "validation_error")).status, "MISCONFIGURED");
  assert.equal((await probe(401, "restricted_api_key")).status, "MISCONFIGURED", "a sending-only key cannot read domains");
  assert.equal((await probe(429, "rate_limit_exceeded")).status, "DEGRADED");
  assert.equal((await probe(503, "service_unavailable")).status, "UNAVAILABLE");
  assert.equal((await createResendAdapter({ config: { resend: { ...config.resend, apiKey: "" } }, fetchImpl: async () => response(200, {}) }).healthProbe()).status, "NOT_CONFIGURED");
  const unconfigured = withTransportContract(notConfiguredAdapter("Mail provider credentials are not configured"));
  assert.equal((await unconfigured.healthProbe()).status, "NOT_CONFIGURED");
  await assert.rejects(unconfigured.sendMessage(sendRequest()), (error) => error.kind === "NOT_CONFIGURED" && error.category === "NOT_CONFIGURED");
});

test("§18 client-side pacing spaces requests below the documented default rate", async () => {
  let now = 0;
  const waits = [];
  const pace = createRequestPacer(8, { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  for (let index = 0; index < 4; index += 1) await pace();
  assert.deepEqual(waits, [125, 125, 125]);
  await createRequestPacer(0)();
});

// ---------------------------------------------------------------- contract
test("§18 contract: exposes the nine operations; validates before calling; normalizes results and unexpected errors", async () => {
  assert.deepEqual(CONTRACT_OPERATIONS, ["sendMessage", "fetchInboundMessage", "fetchInboundAttachments", "validateDomain", "queueBroadcast", "cancelBroadcast", "syncAudience", "retrieveDeliveryEvents", "healthProbe"]);
  const fake = createFakeAdapter();
  let quotaHook = null;
  fake.setQuotaObserver = (fn) => { quotaHook = fn; };
  const contract = createMailProviderContract({ transport: fake, marketingFor: () => null });
  for (const operation of CONTRACT_OPERATIONS) assert.equal(typeof contract[operation], "function", operation);

  const wrapped = withTransportContract(fake);
  assert.equal(wrapped.state, fake.state, "adapter state and helpers pass through");
  wrapped.setQuotaObserver(() => {});
  assert.equal(typeof quotaHook, "function");
  await assert.rejects(wrapped.sendMessage({ ...sendRequest(), to: [{ address: "not-an-address" }] }), (error) => error.category === "VALIDATION_FAILED" && error.code === "RECIPIENT_INVALID");
  await assert.rejects(wrapped.sendMessage({ ...sendRequest(), idempotencyKey: undefined }), { code: "IDEMPOTENCY_KEY_INVALID" });
  await assert.rejects(wrapped.fetchInboundMessage("../../etc"), { code: "PROVIDER_ID_INVALID" });
  assert.equal(fake.state.sent.length, 0, "invalid requests never reach the adapter");
  const first = await wrapped.sendMessage(sendRequest());
  const replay = await wrapped.sendMessage(sendRequest());
  assert.equal(first.providerMessageId, replay.providerMessageId, "same idempotency key, same provider id");
  // Regression: methods are resolved at call time, so a replaced adapter
  // method (fault injection, hot reconfiguration) is honoured by the wrapper.
  const original = fake.sendMessage;
  fake.sendMessage = async () => ({ providerMessageId: "replaced" });
  assert.equal((await wrapped.sendMessage(sendRequest({ idempotencyKey: "other" }))).providerMessageId, "replaced");
  fake.sendMessage = original;

  const broken = withTransportContract({ name: "broken", sendMessage: async () => { throw new TypeError("socket hang up"); }, fetchInboundMessage: async () => { throw new TypeError("boom"); }, sendWithoutId: null, healthProbe: async () => { throw new Error("x"); } });
  await assert.rejects(broken.sendMessage(sendRequest()), (error) => error.kind === "AMBIGUOUS" && error.category === "OUTCOME_UNKNOWN" && error.operation === "sendMessage");
  await assert.rejects(broken.fetchInboundMessage("em_1"), (error) => error.kind === "RETRYABLE" && error.category === "PROVIDER_UNAVAILABLE");
  assert.deepEqual({ ok: (await broken.healthProbe()).ok, status: (await broken.healthProbe()).status }, { ok: false, status: "UNAVAILABLE" });
  const noId = withTransportContract({ sendMessage: async () => ({}) });
  await assert.rejects(noId.sendMessage(sendRequest()), (error) => error.kind === "AMBIGUOUS" && error.code === "PROVIDER_NO_ID");
  const events = withTransportContract({ retrieveDeliveryEvents: async () => [{ type: "DELIVERED", occurredAt: "2026-10-26T10:00:00Z" }, { type: "WEIRD" }] });
  const normalized = await events.retrieveDeliveryEvents("em_1");
  assert.equal(normalized.length, 1);
  assert.ok(normalized[0].occurredAt instanceof Date);
});

function marketingStub(broadcast) {
  const calls = [];
  const contacts = new Map([["gone@x.test", { id: "c_gone", email: "gone@x.test", unsubscribed: true }], ["old@x.test", { id: "c_old", email: "old@x.test", unsubscribed: false }]]);
  return {
    calls,
    name: "stub",
    async getBroadcast(id) {
      calls.push(["getBroadcast", id]);
      return broadcast.status ? { id, status: broadcast.status } : null;
    },
    async sendBroadcast(id, options) {
      calls.push(["sendBroadcast", id, options]);
      broadcast.status = options?.scheduledAt ? "SCHEDULED" : "QUEUED";
      return { id };
    },
    async cancelBroadcast(id) {
      calls.push(["cancelBroadcast", id]);
      broadcast.status = broadcast.status === "SCHEDULED" ? "DRAFT" : "CANCELED";
    },
    async getContact(email) {
      return contacts.get(email) || null;
    },
    async createContact(input) {
      calls.push(["createContact", input.email, input.segmentIds]);
      return { id: "c_new" };
    },
    async addContactToSegment(contactId, segmentId) {
      calls.push(["addContactToSegment", contactId, segmentId]);
    },
    async removeContactFromSegment(contactId, segmentId) {
      calls.push(["removeContactFromSegment", contactId, segmentId]);
    },
    async healthProbe() {
      return { ok: true, latencyMs: 1, detail: "ok" };
    },
  };
}

test("§18 contract cancelBroadcast follows documented Resend semantics and never claims delivered mail was recalled", async () => {
  const outcome = async (status) => withMarketingContract(marketingStub({ status })).cancelBroadcast({ providerBroadcastId: "bc_1" });
  assert.deepEqual(await outcome("SCHEDULED"), { outcome: "RETURNED_TO_DRAFT", providerStatus: "DRAFT", sentBeforeCancel: "NONE" });
  assert.deepEqual(await outcome("QUEUED"), { outcome: "CANCELED", providerStatus: "CANCELED", sentBeforeCancel: "UNKNOWN" }, "a queued broadcast may already have sent some emails");
  assert.deepEqual(await outcome("SENT"), { outcome: "NOT_CANCELLABLE_ALREADY_SENT", providerStatus: "SENT", sentBeforeCancel: "ALL" });
  assert.equal((await outcome("CANCELED")).outcome, "ALREADY_CANCELED");
  assert.equal((await outcome("DRAFT")).outcome, "NOTHING_TO_CANCEL");
  assert.equal((await outcome(null)).outcome, "NOT_FOUND");
  const sent = marketingStub({ status: "SENT" });
  await withMarketingContract(sent).cancelBroadcast({ providerBroadcastId: "bc_1" });
  assert.equal(sent.calls.some(([name]) => name === "cancelBroadcast"), false, "no cancel call for a sent broadcast");
});

test("§18 contract queueBroadcast never sends a broadcast twice; syncAudience requires consent and never lifts a provider unsubscribe", async () => {
  const draft = marketingStub({ status: "DRAFT" });
  const contract = withMarketingContract(draft);
  assert.deepEqual(await contract.queueBroadcast({ providerBroadcastId: "bc_1" }), { providerBroadcastId: "bc_1", status: "QUEUED", alreadyQueued: false });
  assert.deepEqual(await contract.queueBroadcast({ providerBroadcastId: "bc_1" }), { providerBroadcastId: "bc_1", status: "QUEUED", alreadyQueued: true });
  assert.equal(draft.calls.filter(([name]) => name === "sendBroadcast").length, 1);

  const audience = marketingStub({ status: "DRAFT" });
  const sync = withMarketingContract(audience);
  await assert.rejects(sync.syncAudience({ segmentId: "seg_1", add: [{ email: "new@x.test" }] }), { code: "CONTACT_NOT_ELIGIBLE" });
  const result = await sync.syncAudience({ segmentId: "seg_1", add: [{ email: "new@x.test", consentVerified: true }, { email: "old@x.test", consentVerified: true }, { email: "gone@x.test", consentVerified: true }], remove: ["c_left"] });
  assert.deepEqual(result, { added: 1, created: 1, removed: 1, providerUnsubscribed: ["gone@x.test"] });
  assert.equal(audience.calls.some((call) => call.includes("gone@x.test") || call.includes("c_gone")), false, "an unsubscribed provider contact is never touched");
  const wrapper = createMailProviderContract({ transport: createFakeAdapter(), marketingFor: () => marketingStub({ status: "QUEUED" }) });
  assert.equal((await wrapper.cancelBroadcast({ organization: { slug: "brand" }, providerBroadcastId: "bc_9" })).outcome, "CANCELED");
  assert.equal((await wrapper.healthProbe({ organization: { slug: "brand" } })).ok, true);
});

// ---------------------------------------------------------------- HTTP (§17.1)
test("§17.1 route-specific Mail body limits and JSON shape checks", () => {
  assert.equal(isRichBodyRoute("POST", "/mailboxes/abc/drafts"), true);
  assert.equal(isRichBodyRoute("PATCH", "/drafts/abc"), true);
  assert.equal(isRichBodyRoute("POST", "/marketing/org/templates/t/versions"), true);
  assert.equal(isRichBodyRoute("POST", "/mailboxes/abc/labels"), false);
  assert.equal(isRichBodyRoute("POST", "/drafts/abc/send"), false);
  assert.equal(richLimitBytes(1024 * 1024), 2 * 1024 * 1024 + 64 * 1024);
  assert.equal(richLimitBytes(5 * 1024 * 1024), 10 * 1024 * 1024 + 64 * 1024);
  assert.equal(richLimitBytes(10), 256 * 1024);
  let deep = {};
  for (let index = 0; index < 40; index += 1) deep = { child: deep };
  assert.equal(jsonShapeProblem(deep), "TOO_DEEP");
  assert.equal(jsonShapeProblem({ ids: Array.from({ length: 5001 }, () => 1) }), "ARRAY_TOO_LONG");
  assert.equal(jsonShapeProblem({ to: [{ address: "a@x.test" }], html: "<p>x</p>" }), null);
});

function testApp(seen, { mailRouter } = {}) {
  const router = mailRouter || express.Router();
  if (!mailRouter) {
    router.post("/mailboxes/:id/labels", (req, res) => res.json({ success: true }));
    router.post("/mailboxes/:id/drafts", (req, res) => res.json({ success: true, size: JSON.stringify(req.body).length }));
    router.get("/threads", (req, res) => res.json({ success: true }));
  }
  return createApp({
    env: { ...process.env, NODE_ENV: "test" },
    passportInstance: { initialize: () => (req, res, next) => next() },
    googleStrategyRegistrar: () => ({ enabled: false }),
    cloudinaryConfigurator: () => ({ configured: false }),
    mailHttpFactory: () => ({
      application: { config: { limits: { bodyMaxBytes: 1024 * 1024 } } },
      router,
      webhookHandler: (req, res) => {
        const secret = `whsec_${Buffer.alloc(24, 7).toString("base64")}`;
        const result = verifyResendWebhook({ rawBody: req.rawBody, headers: req.headers, secret, now: Number(req.headers["x-test-now"]) });
        seen.webhook = { raw: req.rawBody.toString("utf8"), result };
        res.status(result.ok ? 200 : 401).json({ success: result.ok, reason: result.reason || null });
      },
    }),
  });
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await closeServer(server);
  }
}

test("§17.1 app.js: small Mail routes 64 KB, rich routes larger, hostile shapes 400, malformed JSON 400 (not 500), webhooks keep exact bytes", async () => {
  const seen = {};
  await withServer(testApp(seen), async (base) => {
    const post = (path, body, headers = {}) => fetch(`${base}/api/mail/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    assert.equal((await post("/mailboxes/m/labels", JSON.stringify({ name: "x".repeat(70 * 1024) }))).status, 413, "a label body cannot be 70 KB");
    assert.equal((await post("/mailboxes/m/drafts", JSON.stringify({ html: "x".repeat(900 * 1024) }))).status, 200, "a draft body can be large");
    const tooBig = await post("/mailboxes/m/drafts", JSON.stringify({ html: "x".repeat(3 * 1024 * 1024) }));
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).code, "MAIL_PAYLOAD_TOO_LARGE");
    let deep = "1";
    for (let index = 0; index < 40; index += 1) deep = `{"a":${deep}}`;
    const hostile = await post("/mailboxes/m/labels", deep);
    assert.equal(hostile.status, 400);
    assert.equal((await hostile.json()).errors[0].reason, "TOO_DEEP");
    const malformed = await post("/mailboxes/m/labels", '{"name":');
    assert.equal(malformed.status, 400, "malformed JSON is a client error");
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.code, "INVALID_JSON");
    assert.ok(malformedBody.correlationId);
    const other = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(other.status, 400, "non-Mail routes also stop turning malformed JSON into 500s");

    // Webhook: signature over the exact bytes, including whitespace, key
    // order and characters the global XSS filter would rewrite.
    const secret = `whsec_${Buffer.alloc(24, 7).toString("base64")}`;
    const raw = '{ "type":"email.received",\n  "data":{"email_id":"em_1","subject":"<script>x</script> & ü"},"created_at":"2026-10-26T10:00:00Z"}';
    const now = Date.parse("2026-10-26T10:00:05Z");
    const timestamp = String(Math.floor(now / 1000));
    const signature = signResendWebhook({ id: "msg_1", timestamp, rawBody: Buffer.from(raw), secret });
    const headers = { "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": signature, "x-test-now": String(now) };
    assert.equal((await post("/webhooks/resend", raw, headers)).status, 200);
    assert.equal(seen.webhook.raw, raw, "byte-for-byte");
    const reordered = JSON.stringify({ data: { subject: "<script>x</script> & ü", email_id: "em_1" }, type: "email.received", created_at: "2026-10-26T10:00:00Z" });
    assert.equal((await post("/webhooks/resend", reordered, headers)).status, 401, "the same JSON with different bytes is rejected");
    assert.equal(seen.webhook.result.reason, "SIGNATURE_MISMATCH");
    assert.equal((await post("/webhooks/resend", raw, { ...headers, "x-test-now": String(now + 10 * 60 * 1000) })).status, 401, "old timestamp");
    assert.equal(seen.webhook.result.reason, "TIMESTAMP_OUT_OF_TOLERANCE");
    assert.equal((await post("/webhooks/resend", raw, { ...headers, "x-test-now": String(now - 10 * 60 * 1000) })).status, 401, "future timestamp");
    assert.equal((await post("/webhooks/resend", raw, { "svix-id": "msg_1", "x-test-now": String(now) })).status, 401, "missing signature headers");
    assert.equal(seen.webhook.result.reason, "MISSING_HEADERS");
    assert.equal((await post("/webhooks/resend", JSON.stringify({ pad: "x".repeat(300 * 1024) }), headers)).status, 413, "oversized webhook bodies are refused before verification");
    const rotated = signResendWebhook({ id: "msg_2", timestamp, rawBody: Buffer.from(raw), secret: `whsec_${Buffer.alloc(24, 9).toString("base64")}` });
    const both = verifyResendWebhook({ rawBody: Buffer.from(raw), headers: { "svix-id": "msg_2", "svix-timestamp": timestamp, "svix-signature": rotated }, secret: [secret, `whsec_${Buffer.alloc(24, 9).toString("base64")}`], now });
    assert.equal(both.ok, true, "the previous secret is accepted during a rotation overlap");
  });
});

test("§17 access logs redact capability tokens and private query terms", () => {
  assert.equal(redactLoggedUrl("/api/mail/v1/public/unsubscribe/abc.def"), "/api/mail/v1/public/unsubscribe/[redacted]");
  assert.equal(redactLoggedUrl("/api/mail/v1/public/consent/confirm/tok"), "/api/mail/v1/public/consent/confirm/[redacted]");
  assert.equal(redactLoggedUrl("/api/mail/v1/mailboxes/m/search?q=salary&limit=5"), "/api/mail/v1/mailboxes/m/search?q=%5Bredacted%5D&limit=5");
  assert.equal(redactLoggedUrl("/api/health"), "/api/health");
});

test("§17 error responses: no constraint names for Mail, codes for 401/404/409, invalid ids are 400", () => {
  const run = (err, url = "/api/mail/v1/mailboxes") => {
    const res = { statusCode: 0, body: null, locals: { correlationId: "corr-1" }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
    errorHandler(err, { originalUrl: url }, res, () => {});
    return res;
  };
  const conflict = run({ code: "P2002", meta: { target: ["mailbox_id", "name"] } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "CONFLICT");
  assert.equal(JSON.stringify(conflict.body).includes("mailbox_id"), false);
  assert.equal(conflict.body.correlationId, "corr-1");
  assert.equal(run({ code: "P2002", meta: { target: ["email"] } }, "/api/admin-users").body.message, "email already exists", "other modules keep their message");
  assert.equal(run({ code: "P2023" }).statusCode, 400);
  assert.equal(run({ name: "PrismaClientValidationError" }).body.code, "VALIDATION_ERROR");
  assert.equal(run({ code: "P2025" }).body.code, "NOT_FOUND");
  const ApiError = require("../src/shared/utils/ApiError");
  assert.equal(run(new ApiError(401, "Invalid token")).body.code, "UNAUTHENTICATED");
});

// ---------------------------------------------------------------- readiness
function readinessFixture(overrides = {}) {
  const calls = { provider: 0 };
  const base = {
    config: { enabled: true, sendingEnabled: true, receivingEnabled: true, provider: "resend", resend: { apiKey: "re_x", webhookSecret: "whsec_x" } },
    schema: { check: async () => ({ ready: true }) },
    encryption: { available: true },
    storage: { health: async () => ({ ok: true }) },
    scanner: { available: true, health: async () => ({ ok: true }) },
    provider: { healthProbe: async () => { calls.provider += 1; return { ok: true, status: "OK" }; } },
    jobs: { stats: async () => [{ queue: "OUTBOUND", status: "PENDING", count: 2 }, { queue: "OUTBOUND", status: "DEAD_LETTER", count: 1 }] },
    infrastructureViolations: () => [],
    clock: () => 1000,
  };
  return { calls, readiness: createDependencyReadiness({ ...base, ...overrides, config: { ...base.config, ...(overrides.config || {}) } }) };
}

test("§20 readiness: disabled Mail is DISABLED (never 'ready') and makes no provider call", async () => {
  const { calls, readiness } = readinessFixture({ config: { enabled: false, resend: { apiKey: "", webhookSecret: "" } } });
  const state = await readiness.evaluate();
  assert.equal(state.ready, false);
  assert.equal(state.state, "DISABLED");
  assert.equal(state.dependencies.provider, "NOT_CONFIGURED");
  assert.equal(state.dependencies.webhooks, "NOT_CONFIGURED");
  assert.equal(calls.provider, 0);
});

test("§20 readiness: each dependency is reported; provider probe is cached; rate limiting is degraded, not down", async () => {
  const ok = readinessFixture();
  const state = await ok.readiness.evaluate();
  assert.equal(state.ready, true);
  assert.deepEqual(state.queue, { OUTBOUND: { pending: 2, deadLetter: 1 } });
  await ok.readiness.evaluate();
  assert.equal(ok.calls.provider, 1, "the public endpoint cannot be used to hammer the provider");
  const storageDown = await readinessFixture({ storage: { health: async () => ({ ok: false }) } }).readiness.evaluate();
  assert.equal(storageDown.ready, false);
  assert.equal(storageDown.dependencies.storage, "UNAVAILABLE");
  const scannerDown = await readinessFixture({ scanner: { available: true, health: async () => ({ ok: false }) } }).readiness.evaluate();
  assert.equal(scannerDown.ready, false, "receiving needs a healthy scanner");
  const misconfigured = await readinessFixture({ provider: { healthProbe: async () => ({ ok: false, status: "MISCONFIGURED" }) } }).readiness.evaluate();
  assert.equal(misconfigured.dependencies.provider, "MISCONFIGURED");
  assert.equal(misconfigured.ready, false);
  const limited = await readinessFixture({ provider: { healthProbe: async () => ({ ok: false, status: "DEGRADED" }) } }).readiness.evaluate();
  assert.equal(limited.ready, true);
  const marketingOnly = await readinessFixture({ config: { sendingEnabled: false, receivingEnabled: false }, provider: { healthProbe: async () => { throw new Error("must not be called"); } } }).readiness.evaluate();
  assert.equal(marketingOnly.dependencies.provider, "DISABLED");
  assert.equal(JSON.stringify(state).match(/re_x|whsec_x|mail_/), null, "no secrets or table names");
});

test("§17.1 session assessment: legacy JS-readable tokens are flagged; required hardening blocks", () => {
  assert.deepEqual(assessMailSession({ env: { AUTH_SESSION_MODE: "legacy" }, config: { session: { requireHardened: false } } }), { mode: "legacy", hardened: false, required: false, status: "WARNING", reason: "JS_READABLE_ACCESS_TOKEN" });
  assert.equal(assessMailSession({ env: { AUTH_SESSION_MODE: "legacy" }, config: { session: { requireHardened: true } } }).status, "BLOCKING");
  assert.equal(assessMailSession({ env: { AUTH_SESSION_MODE: "dual" }, config: { session: { requireHardened: true, allowDual: false } } }).status, "BLOCKING");
  assert.equal(assessMailSession({ env: { AUTH_SESSION_MODE: "dual" }, config: { session: { requireHardened: true, allowDual: true } } }).status, "OK");
  assert.equal(assessMailSession({ env: { AUTH_SESSION_MODE: "cookie" }, config: { session: { requireHardened: true } } }).status, "OK");
});
