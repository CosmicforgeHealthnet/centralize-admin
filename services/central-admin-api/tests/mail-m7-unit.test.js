"use strict";

// M7 unit tests (no database, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig, publicStatus } = require("../src/modules/mail/mail.config");
const { createResendMarketingAdapter } = require("../src/modules/mail/adapters/marketing/resend-marketing.adapter");
const { createMarketingProviderResolver, describeBrandProvider } = require("../src/modules/mail/adapters/marketing");
const { assertMarketingAdapter, normalizeBroadcastStatus } = require("../src/modules/mail/adapters/marketing/marketing-provider.contract");
const { createFakeMarketingAdapter } = require("../src/modules/mail/adapters/marketing/fake-marketing.adapter");
const { validateDefinition, validateTriggerConfig, evaluateCondition, DefinitionError } = require("../src/modules/mail/marketing/automation/definition");
const { minimizePayload, approvedEvent } = require("../src/modules/mail/marketing/automation/event-registry");
const { zonedLocalToUtc, nextOccurrence } = require("../src/modules/mail/marketing/scheduling");
const { signUnsubscribeToken, verifyUnsubscribeToken } = require("../src/modules/mail/marketing/unsubscribe-token");
const { toProviderContent } = require("../src/modules/mail/marketing/broadcast.processor");
const { classifySendError } = require("../src/modules/mail/marketing/marketing-sender");
const { MailProviderError } = require("../src/modules/mail/adapters/mail-provider.contract");
const { renderTemplate } = require("../src/modules/mail/marketing/template-renderer");

const UUID = "0b5e8a3c-6c1f-4c9e-9a51-0d6c1a2b3c4d";

test("M7 capabilities default OFF and each needs its own flag", () => {
  const off = loadMailConfig({});
  assert.equal(off.broadcastDispatchEnabled, false);
  assert.equal(off.automationEnabled, false);
  assert.equal(off.confirmationEmailsEnabled, false);
  assert.deepEqual(off.workerQueues, ["OUTBOUND", "INBOUND", "EVENTS"], "MARKETING queue is opt-in");
  const marketingOnly = loadMailConfig({ MAIL_ENABLED: "true", MAIL_MARKETING_ENABLED: "true" });
  assert.equal(marketingOnly.broadcastDispatchEnabled, false, "M6 marketing does not imply dispatch");
  assert.equal(loadMailConfig({ MAIL_BROADCAST_DISPATCH_ENABLED: "true" }).broadcastDispatchEnabled, false, "needs Mail + Marketing too");
  const on = loadMailConfig({ MAIL_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", MAIL_BROADCAST_DISPATCH_ENABLED: "true", MAIL_BROADCAST_MAX_RECIPIENTS: "999999999", MAIL_PROVIDER_IDEMPOTENCY_WINDOW_HOURS: "48" });
  assert.equal(on.broadcastDispatchEnabled, true);
  assert.equal(on.broadcast.maxRecipients, 100000, "hard ceiling");
  assert.equal(on.reconciliation.idempotencyWindowHours, 23, "never beyond the provider window");
  const status = publicStatus(on);
  assert.equal(JSON.stringify(status).includes("UNSUBSCRIBE_SECRET"), false);
  assert.equal(status.unsubscribeConfigured, false);
});

function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const next = responses.shift() || { status: 200, body: {} };
    if (next.throw) throw next.throw;
    return { ok: next.status < 400, status: next.status, headers: { get: (name) => (next.headers || {})[name.toLowerCase()] ?? null }, text: async () => JSON.stringify(next.body ?? {}) };
  };
  return { calls, fetchImpl };
}

test("Resend marketing adapter uses the documented endpoints and never re-subscribes contacts", async () => {
  const config = loadMailConfig({ MAIL_ENABLED: "true", MAIL_MARKETING_ENABLED: "true", RESEND_API_BASE_URL: "https://api.resend.test" });
  const { calls, fetchImpl } = recordingFetch([
    { status: 404, body: { name: "not_found" } },
    { status: 200, body: { object: "contact", id: "c_1" } },
    { status: 200, body: { object: "segment", id: "s_1", name: "cf-dispatch-x" } },
    { status: 200, body: {} },
    { status: 200, body: { object: "broadcast", id: "b_1" } },
    { status: 200, body: { id: "b_1" } },
    { status: 200, body: { id: "b_1", status: "queued" } },
    { status: 200, body: {} },
    { status: 200, body: { data: [{ id: "s_0", name: "other" }, { id: "s_1", name: "cf-dispatch-x" }], has_more: false } },
  ]);
  const adapter = assertMarketingAdapter(createResendMarketingAdapter({ apiKey: "re_test", config, fetchImpl, sleep: async () => {} }));
  assert.equal(await adapter.getContact("a@b.example"), null, "404 -> no contact");
  assert.deepEqual(await adapter.createContact({ email: "a@b.example", firstName: "A", segmentIds: ["s_1"] }), { id: "c_1" });
  await adapter.createSegment("cf-dispatch-x");
  await adapter.addContactToSegment("c_1", "s_1");
  await adapter.createBroadcast({ name: "cf-dispatch-x", segmentId: "s_1", from: { address: "news@cf.example", name: "CF" }, subject: "S", html: "<p>h</p>", text: "h" });
  await adapter.sendBroadcast("b_1");
  assert.equal((await adapter.getBroadcast("b_1")).status, "QUEUED");
  await adapter.cancelBroadcast("b_1");
  assert.deepEqual(await adapter.findSegmentByName("cf-dispatch-x"), { id: "s_1" });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace("https://api.resend.test", "")}`), [
    "GET /contacts/a%40b.example",
    "POST /contacts",
    "POST /segments",
    "POST /contacts/c_1/segments/s_1",
    "POST /broadcasts",
    "POST /broadcasts/b_1/send",
    "GET /broadcasts/b_1",
    "POST /broadcasts/b_1/cancel",
    "GET /segments?limit=100",
  ]);
  assert.equal("unsubscribed" in calls[1].body, false, "contact creation never sets unsubscribed");
  assert.deepEqual(calls[1].body.segments, [{ id: "s_1" }]);
  assert.equal(calls[4].body.send, false, "broadcasts are created as drafts");
  assert.equal(calls[4].body.segment_id, "s_1");
  assert.equal(calls[4].body.from, '"CF" <news@cf.example>');
  assert.equal(calls[0].headers.Authorization, "Bearer re_test");
});

test("Resend marketing adapter classifies failures (write timeouts are ambiguous)", async () => {
  const config = loadMailConfig({ RESEND_API_BASE_URL: "https://api.resend.test" });
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const { fetchImpl } = recordingFetch([{ throw: abort }, { throw: abort }, { status: 429, body: { name: "rate_limit_exceeded" }, headers: { "retry-after": "2" } }, { status: 422, body: { name: "validation_error" } }]);
  const adapter = createResendMarketingAdapter({ apiKey: "re_test", config, fetchImpl, sleep: async () => {} });
  await assert.rejects(adapter.sendBroadcast("b"), (error) => error.kind === "AMBIGUOUS");
  await assert.rejects(adapter.getBroadcast("b"), (error) => error.kind === "RETRYABLE");
  await assert.rejects(adapter.createSegment("x"), (error) => error.kind === "RETRYABLE" && error.retryAfterSeconds === 2);
  await assert.rejects(adapter.createBroadcast({ name: "x", segmentId: "s", from: { address: "a@b.example" }, subject: "s", html: "h", text: "t" }), (error) => error.kind === "PERMANENT");
  assert.equal(normalizeBroadcastStatus("sent"), "SENT");
  assert.equal(normalizeBroadcastStatus("canceled"), "CANCELED");
  assert.equal(normalizeBroadcastStatus("weird"), "UNKNOWN");
});

test("brands get their own provider account; shared accounts need an explicit decision", async () => {
  const config = loadMailConfig({ MAIL_ENABLED: "true", MAIL_MARKETING_ENABLED: "true" });
  const env = { RESEND_MARKETING_API_KEY__KARRYAM: "re_k", RESEND_MARKETING_API_KEY: "re_shared" };
  const resolve = createMarketingProviderResolver({ config, env });
  assert.equal(resolve({ slug: "karryam" }).name, "resend");
  const cf = resolve({ slug: "cosmicforge" });
  assert.equal(cf.name, "unconfigured", "no implicit shared key");
  await assert.rejects(cf.createSegment("x"), (error) => error.kind === "NOT_CONFIGURED");
  const shared = createMarketingProviderResolver({ config: loadMailConfig({ MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT: "true" }), env });
  assert.equal(shared({ slug: "cosmicforge" }).name, "resend");
  const described = describeBrandProvider("karryam", { env, config });
  assert.equal(described.configured, true);
  assert.equal(JSON.stringify(described).includes("re_k"), false, "never exposes key material");
});

test("automation definitions: bounded acyclic graphs with validated references", () => {
  const send = (id, next = null) => ({ id, type: "send_email", templateVersionId: UUID, senderAddressId: UUID, next });
  const ok = validateDefinition({ topic: "newsletter", entryStepId: "a", steps: [send("a", "b"), { id: "b", type: "delay", minutes: 60, next: "c" }, { id: "c", type: "condition", condition: { field: "attributes.plan", op: "in", value: ["gold", "silver"] }, then: "d", else: null }, send("d")] });
  assert.equal(ok.steps.length, 4);
  const reasons = (input) => {
    try {
      validateDefinition(input);
      return [];
    } catch (error) {
      assert.ok(error instanceof DefinitionError);
      return error.errors.map((entry) => entry.reason || entry.field);
    }
  };
  assert.ok(reasons({ topic: "newsletter", steps: [send("a", "b"), { id: "b", type: "delay", minutes: 5, next: "a" }] }).includes("CYCLE"));
  assert.ok(reasons({ topic: "newsletter", steps: [send("a"), send("orphan")] }).includes("UNREACHABLE"));
  assert.ok(reasons({ topic: "newsletter", steps: [{ id: "a", type: "delay", minutes: 0 }] }).length);
  assert.ok(reasons({ topic: "newsletter", steps: [{ id: "a", type: "webhook", url: "http://169.254.169.254" }] }).includes("UNSUPPORTED"));
  assert.ok(reasons({ topic: "newsletter", steps: [{ id: "a", type: "condition", condition: { field: "event.__proto__x", op: "eval", value: "1" } }] }).length);
  assert.ok(reasons({ topic: "newsletter", steps: [{ id: "a", type: "exit" }] }).includes("SEND_STEP_REQUIRED"));
  assert.throws(() => validateTriggerConfig("PRODUCT_EVENT", { eventType: "healthnet.patient.admitted" }, ok), DefinitionError);
  assert.throws(() => validateTriggerConfig("CONSENT_GRANTED", { topic: "other" }, ok), DefinitionError);
  assert.equal(validateTriggerConfig("SCHEDULE", { frequency: "weekly", weekday: 1, localTime: "09:00", timeZone: "Africa/Lagos", audienceId: UUID }, ok).weekday, 1);
  assert.equal(evaluateCondition({ field: "event.city", op: "equals", value: "lagos" }, { contact: {}, eventPayload: { city: "Lagos" } }), true);
  assert.equal(evaluateCondition({ field: "engagement.previous_send_delivered", op: "equals", value: "true" }, { contact: {}, engagement: { previous_send_delivered: false } }), false);
});

test("product events are allowlisted, versioned and minimised", () => {
  assert.equal(approvedEvent("karryam.booking.completed", 1).product, "karryam");
  assert.equal(approvedEvent("karryam.booking.completed", 2), null);
  assert.equal(approvedEvent("healthnet.consultation.completed", 1), null);
  const minimized = minimizePayload("karryam.booking.completed", 1, { service: "ride<script>", bookingCount: 3, card: "4111", diagnosis: "x", city: 5 });
  assert.deepEqual(minimized.payload, { service: "ridescript", bookingCount: 3 });
  assert.deepEqual(minimized.dropped.sort(), ["card", "city", "diagnosis"]);
});

test("scheduling handles time zones and DST without silent shifts", () => {
  assert.equal(zonedLocalToUtc("2026-07-01T09:00", "Africa/Lagos").utc.toISOString(), "2026-07-01T08:00:00.000Z");
  assert.throws(() => zonedLocalToUtc("2026-03-08T02:30", "America/New_York"), (error) => error.code === "SCHEDULE_TIME_NONEXISTENT");
  const ambiguous = zonedLocalToUtc("2026-11-01T01:30", "America/New_York");
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.utc.toISOString(), "2026-11-01T05:30:00.000Z", "first occurrence");
  assert.throws(() => zonedLocalToUtc("2026-07-01T09:00", "Mars/Olympus"), (error) => error.code === "SCHEDULE_TIME_INVALID");
  assert.equal(nextOccurrence({ frequency: "daily", localTime: "02:30", timeZone: "America/New_York" }, Date.parse("2026-03-08T00:00:00Z")).toISOString(), "2026-03-09T06:30:00.000Z", "gap day skipped");
  assert.equal(nextOccurrence({ frequency: "monthly", dayOfMonth: 1, localTime: "08:00", timeZone: "UTC" }, Date.parse("2026-10-25T00:00:00Z")).toISOString(), "2026-11-01T08:00:00.000Z");
});

test("unsubscribe tokens are signed, brand-bound, rotate, and carry no email", () => {
  const secret = "a".repeat(40);
  const token = signUnsubscribeToken({ organizationId: UUID, contactId: UUID, topic: "newsletter" }, secret);
  assert.equal(token.includes("@"), false);
  assert.deepEqual(verifyUnsubscribeToken(token, [secret]), { organizationId: UUID, contactId: UUID, topic: "newsletter" });
  assert.equal(verifyUnsubscribeToken(token, ["b".repeat(40)]), null);
  assert.deepEqual(verifyUnsubscribeToken(token, ["b".repeat(40), secret]), { organizationId: UUID, contactId: UUID, topic: "newsletter" }, "previous secret accepted during rotation");
  const [body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, o: "other", c: UUID, t: "*" })).toString("base64url");
  assert.equal(verifyUnsubscribeToken(`${forged}.${signature}`, [secret]), null);
  assert.equal(verifyUnsubscribeToken(`${body}.`, [secret]), null);
  assert.throws(() => signUnsubscribeToken({ organizationId: UUID, contactId: UUID }, "short"), (error) => error.code === "MAIL_UNSUBSCRIBE_NOT_CONFIGURED");
});

test("approved content maps to provider merge tags and keeps the mandatory footer", () => {
  const rendered = renderTemplate({ subject: "Hi {{first_name}}", blocks: [{ type: "text", text: "Hello {{first_name}} from {{brand_name}}" }], brand: { name: "Brand", postalAddress: "1 Road <b>, Lagos" } });
  assert.match(rendered.html, /<br>1 Road\s+b\s+, Lagos</, "postal address in the footer, markup stripped");
  const html = toProviderContent(rendered.html, "A&B", { html: true });
  assert.match(html, /\{\{\{contact\.first_name\}\}\}/);
  assert.match(html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
  assert.match(html, /A&amp;B/);
  assert.equal(/\{\{\s*(first_name|unsubscribe_url|brand_name)\s*\}\}/.test(html), false);
  assert.equal(toProviderContent("Hi {{first_name}}", "A&B", { html: false }), "Hi {{{contact.first_name}}}");
});

test("single marketing sends follow the idempotency window rules", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  const recent = new Date("2026-10-25T11:00:00Z");
  const old = new Date("2026-10-24T10:00:00Z");
  const err = (kind) => new MailProviderError(kind, "X", "x");
  assert.equal(classifySendError(err("AMBIGUOUS"), { firstAttemptAt: recent, now, windowHours: 23 }).outcome, "RETRY");
  assert.equal(classifySendError(err("AMBIGUOUS"), { firstAttemptAt: old, now, windowHours: 23 }).outcome, "UNKNOWN");
  assert.equal(classifySendError(err("IDEMPOTENCY_CONFLICT"), { firstAttemptAt: recent, now, windowHours: 23 }).outcome, "UNKNOWN");
  assert.equal(classifySendError(err("PERMANENT"), { firstAttemptAt: recent, now, windowHours: 23 }).outcome, "FAILED");
  assert.equal(classifySendError(err("NOT_CONFIGURED"), { firstAttemptAt: recent, now, windowHours: 23 }).outcome, "DEFER");
});

test("fake marketing provider models the documented broadcast lifecycle", async () => {
  const fake = createFakeMarketingAdapter();
  assertMarketingAdapter(fake);
  const segment = await fake.createSegment("s");
  const contact = await fake.createContact({ email: "x@y.example", segmentIds: [segment.id] });
  await assert.rejects(fake.createContact({ email: "X@y.example" }), (error) => error.kind === "PERMANENT", "contacts are unique by email");
  const broadcast = await fake.createBroadcast({ name: "b", segmentId: segment.id });
  await fake.sendBroadcast(broadcast.id);
  await assert.rejects(fake.sendBroadcast(broadcast.id), (error) => error.kind === "PERMANENT", "a queued broadcast cannot be sent twice");
  await fake.cancelBroadcast(broadcast.id);
  assert.equal((await fake.getBroadcast(broadcast.id)).status, "CANCELED");
  fake.providerUnsubscribe("x@y.example");
  assert.equal((await fake.getContact("x@y.example")).unsubscribed, true);
  assert.equal(contact.id.startsWith("fake_contact_"), true);
});

test("every Mail route is described in the OpenAPI document", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { PATHS } = require("../src/modules/mail/openapi/mail.openapi");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "mail", "http", "mail.routes.js"), "utf8");
  const documented = new Set(PATHS.map(([method, route]) => `${method} ${route}`));
  const toOpenApi = (route) => route.replace(/:(\w+)/g, "{$1}");
  const missing = [];
  for (const match of source.matchAll(/\b(router|m)\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    const [, owner, method, route] = match;
    const full = toOpenApi(owner === "m" ? `/marketing${route}` : route);
    if (full === "/openapi.json") continue;
    if (!documented.has(`${method} ${full}`)) missing.push(`${method} ${full}`);
  }
  assert.deepEqual(missing, []);
});

// ---- audit fixes (D9b, D8, D17) -------------------------------------------
test("D9b: brand senders exclude addresses on PERSONAL mailboxes and fail closed when the mailbox is not loaded", () => {
  const { brandSenderProblem, isBrandSender } = require("../src/modules/mail/marketing/marketing-sender");
  const base = { organizationId: UUID, status: "ACTIVE" };
  assert.equal(brandSenderProblem({ ...base, kind: "SHARED", mailboxId: "m", mailbox: { type: "SHARED" } }, UUID), null);
  assert.equal(brandSenderProblem({ ...base, kind: "SYSTEM", mailboxId: null }, UUID), null, "system identities have no mailbox");
  assert.equal(brandSenderProblem({ ...base, kind: "ALIAS", mailboxId: "m", mailbox: { type: "SHARED" } }, UUID), null);
  assert.equal(brandSenderProblem({ ...base, kind: "ALIAS", mailboxId: "m", mailbox: { type: "PERSONAL" } }, UUID), "PERSONAL_MAILBOX_SENDER", "a person's alias");
  assert.equal(brandSenderProblem({ ...base, kind: "ALIAS", mailboxId: "m" }, UUID), "PERSONAL_MAILBOX_SENDER", "mailbox not loaded: refused");
  assert.equal(brandSenderProblem({ ...base, kind: "PRIMARY", mailboxId: null }, UUID), "PERSONAL_SENDER");
  assert.equal(brandSenderProblem({ ...base, kind: "SHARED", status: "SUSPENDED" }, UUID), "SENDER_INACTIVE");
  assert.equal(isBrandSender({ ...base, kind: "SHARED", organizationId: "other" }, UUID), false, "another brand");
});

test("D8: automation send steps accept an optional Reply-To address", () => {
  const step = { id: "a", type: "send_email", templateVersionId: UUID, senderAddressId: UUID };
  assert.equal(validateDefinition({ topic: "news", steps: [{ ...step, replyTo: "Team@Brand.example" }] }).steps[0].replyTo, "team@brand.example");
  assert.equal("replyTo" in validateDefinition({ topic: "news", steps: [step] }).steps[0], false, "absent stays absent (definition hash unchanged)");
  assert.throws(() => validateDefinition({ topic: "news", steps: [{ ...step, replyTo: "not an address" }] }), DefinitionError);
});

test("D17: MARKETING jobs get a lease heartbeat; a lost lease is flagged to the handler; other queues are unchanged", async () => {
  const { createMailWorker } = require("../src/modules/mail/jobs/mail-worker");
  const beats = [];
  let held = true;
  const done = [];
  const pending = [{ id: "m1", kind: "SLOW", queue: "MARKETING", leaseOwner: "w:1" }, { id: "o1", kind: "SLOW", queue: "EVENTS", leaseOwner: "w:2" }];
  const jobs = {
    recoverExpiredLeases: async () => [],
    claim: async () => pending.splice(0),
    heartbeat: async (job) => { beats.push(job.id); return held; },
    complete: async (job) => { done.push(job.id); return true; },
    fail: async () => ({ status: "RETRY_SCHEDULED" }),
    defer: async () => ({ status: "RETRY_SCHEDULED" }),
  };
  const seen = {};
  const handlers = {
    SLOW: async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      held = false;
      await new Promise((resolve) => setTimeout(resolve, 40));
      seen[job.id] = job.lease.lost;
      return {};
    },
  };
  const worker = createMailWorker({ jobs, handlers, config: { worker: { concurrency: 2, leaseSeconds: 120, pollIntervalMs: 1000 } }, queues: ["MARKETING", "EVENTS"], heartbeatIntervalMs: 15 });
  await worker.drain({ maxTicks: 2 });
  assert.ok(beats.filter((id) => id === "m1").length >= 2, "marketing lease extended while running");
  assert.equal(beats.includes("o1"), false, "events behaviour unchanged (OUTBOUND/INBOUND are heartbeated since §17 fencing)");
  assert.equal(seen.m1, true, "lost lease is visible to the handler");
  assert.equal(seen.o1, false);
  const count = beats.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(beats.length, count, "heartbeat stops when the job ends");
  assert.deepEqual(done.sort(), ["m1", "o1"]);
});
