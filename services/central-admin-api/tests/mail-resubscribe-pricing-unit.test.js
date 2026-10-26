"use strict";

// Final gaps 2/3, offline: provider quota header parsing, quota 429
// classification + reset times, observation sampling, missing / partial
// provider metrics, adapter re-subscription flag, pricing arithmetic.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMailConfig } = require("../src/modules/mail/mail.config");
const { createResendAdapter } = require("../src/modules/mail/adapters/resend.adapter");
const { createResendMarketingAdapter } = require("../src/modules/mail/adapters/marketing/resend-marketing.adapter");
const { createFakeMarketingAdapter } = require("../src/modules/mail/adapters/marketing/fake-marketing.adapter");
const { unconfiguredMarketingAdapter, assertMarketingAdapter } = require("../src/modules/mail/adapters/marketing/marketing-provider.contract");
const {
  createProviderQuotaService, parseQuotaHeaders, quotaErrorKind, quotaResetAt, quotaExhaustedError, isQuotaExhausted, quotaDeferSeconds,
} = require("../src/modules/mail/ops/provider-quota.service");
const { decimalToMicros, microsToDecimal } = require("../src/modules/mail/ops/pricing.service");

const baseConfig = (env = {}) => loadMailConfig({ MAIL_ENABLED: "true", MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_unit", ...env });

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => (body === undefined ? "" : JSON.stringify(body)) };
}

function fetchSequence(responses, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
}

test("quota headers: documented names parsed, missing or malformed values are null (never guessed)", () => {
  const parsed = parseQuotaHeaders(new Headers({ "x-resend-monthly-quota": "1234", "x-resend-daily-quota": "56", "ratelimit-limit": "10", "ratelimit-remaining": "9", "ratelimit-reset": "1", "retry-after": "2" }));
  assert.deepEqual(parsed, { monthlyUsed: 1234, dailyUsed: 56, rateLimit: { limit: 10, remaining: 9, resetSeconds: 1 }, retryAfterSeconds: 2 });
  const plain = parseQuotaHeaders({ "X-Resend-Monthly-Quota": "7" });
  assert.equal(plain.monthlyUsed, 7, "plain header objects are case-insensitive");
  assert.equal(plain.dailyUsed, null, "daily quota header is free-plan only: absent -> null");
  const bad = parseQuotaHeaders(new Headers({ "x-resend-monthly-quota": "-5", "x-resend-daily-quota": "1e3", "ratelimit-limit": "abc" }));
  assert.equal(bad.monthlyUsed, null);
  assert.equal(bad.dailyUsed, null);
  assert.equal(bad.rateLimit.limit, null);
  assert.deepEqual(parseQuotaHeaders(null).rateLimit, { limit: null, remaining: null, resetSeconds: null });
});

test("quota 429s: daily/monthly_quota_exceeded are QUOTA_EXHAUSTED until the documented reset; rate_limit_exceeded stays a short retry", async () => {
  assert.equal(quotaErrorKind(429, "daily_quota_exceeded"), "DAILY");
  assert.equal(quotaErrorKind(429, "monthly_quota_exceeded"), "MONTHLY");
  assert.equal(quotaErrorKind(429, "rate_limit_exceeded"), null);
  assert.equal(quotaErrorKind(500, "daily_quota_exceeded"), null);

  const now = Date.parse("2026-10-26T13:00:00.000Z");
  const adapter = createResendAdapter({ config: baseConfig(), clock: () => now, fetchImpl: fetchSequence([
    response(429, { name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." }, { "retry-after": "60" }),
    response(429, { name: "monthly_quota_exceeded", message: "monthly" }),
    response(429, { name: "rate_limit_exceeded", message: "slow down" }, { "retry-after": "1" }),
  ]) });
  const request = { idempotencyKey: "k1", from: { address: "a@cosmicforge.example", name: null }, to: [{ address: "b@reader.example", name: null }], cc: [], bcc: [], subject: "s", text: "t", headers: {}, attachments: [] };
  const daily = await adapter.sendMessage(request).catch((error) => error);
  assert.equal(daily.errorKind, "QUOTA_EXHAUSTED");
  assert.equal(daily.kind, "RETRYABLE", "callers that do not know the quota kind still see a definitive, non-ambiguous refusal");
  assert.equal(daily.code, "RESEND_DAILY_QUOTA_EXCEEDED");
  assert.equal(daily.quota.kind, "DAILY");
  assert.equal(daily.quota.resetAt.toISOString(), "2026-10-27T00:00:00.000Z", "resets at the next UTC midnight");
  assert.equal(daily.retryAfterSeconds, 11 * 3600, "not the 60 s retry-after: wait until the reset");
  const monthly = await adapter.sendMessage(request).catch((error) => error);
  assert.equal(monthly.quota.kind, "MONTHLY");
  assert.equal(monthly.quota.resetAt.toISOString(), "2026-11-01T00:00:00.000Z");
  const rate = await adapter.sendMessage(request).catch((error) => error);
  assert.equal(isQuotaExhausted(rate), false);
  assert.equal(rate.kind, "RETRYABLE");
  assert.equal(rate.retryAfterSeconds, 1);
});

test("UTC reset boundaries: one ms before midnight, exactly midnight, month and year roll-over; defers are capped at one day", () => {
  assert.equal(quotaResetAt("DAILY", new Date("2026-10-26T23:59:59.999Z")).toISOString(), "2026-10-27T00:00:00.000Z");
  assert.equal(quotaResetAt("DAILY", new Date("2026-10-27T00:00:00.000Z")).toISOString(), "2026-10-28T00:00:00.000Z", "a quota hit exactly at midnight belongs to the new day");
  assert.equal(quotaResetAt("DAILY", new Date("2026-12-31T22:00:00.000Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(quotaResetAt("MONTHLY", new Date("2026-12-15T10:00:00.000Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(quotaResetAt("MONTHLY", new Date("2026-02-28T23:59:59.999Z")).toISOString(), "2026-03-01T00:00:00.000Z");
  const now = new Date("2026-10-03T00:00:00.000Z");
  const monthly = quotaExhaustedError("MONTHLY", { now });
  assert.equal(quotaDeferSeconds(monthly, now), 86400, "a monthly exhaustion defers one day at a time");
  const daily = quotaExhaustedError("DAILY", { now: new Date("2026-10-03T23:00:00.000Z") });
  assert.equal(quotaDeferSeconds(daily, new Date("2026-10-03T23:00:00.000Z")), 3600);
  assert.equal(quotaDeferSeconds(new Error("x"), now), null);
});

test("quota observer: called with every response, never delays or fails a send even when it throws", async () => {
  const seen = [];
  const adapter = createResendAdapter({ config: baseConfig(), fetchImpl: fetchSequence([response(200, { id: "em_1" }, { "x-resend-monthly-quota": "41" }), response(200, { id: "em_2" })]) });
  adapter.setQuotaObserver((info) => {
    seen.push(parseQuotaHeaders(info.headers).monthlyUsed);
    throw new Error("recording failed");
  });
  const request = { idempotencyKey: "k2", from: { address: "a@cosmicforge.example", name: null }, to: [{ address: "b@reader.example", name: null }], cc: [], bcc: [], subject: "s", text: "t", headers: {}, attachments: [] };
  assert.equal((await adapter.sendMessage(request)).providerMessageId, "em_1");
  assert.equal((await adapter.sendMessage({ ...request, idempotencyKey: "k3" })).providerMessageId, "em_2");
  assert.deepEqual(seen, [41, null]);
  assert.equal(adapter.quotaScope, "account");
});

test("marketing adapter: quota capture on the brand key, PATCH unsubscribed=false only with the flag ON", async () => {
  const calls = [];
  const seen = [];
  const off = createResendMarketingAdapter({ apiKey: "re_brand", config: baseConfig(), quotaScope: "brand:cosmicforge", quotaObserver: (info) => seen.push(info.status), sleep: async () => {}, fetchImpl: fetchSequence([response(200, { id: "c1", email: "x@reader.example", unsubscribed: true }, { "x-resend-monthly-quota": "3" })], calls) });
  assert.equal(off.quotaScope, "brand:cosmicforge");
  assert.equal(off.resubscribeSupported, false);
  const remote = await off.getContact("x@reader.example");
  assert.equal(remote.unsubscribed, true);
  assert.deepEqual(seen, [200]);
  const refused = await off.resubscribeContact("c1").catch((error) => error);
  assert.equal(refused.code, "PROVIDER_RESUBSCRIBE_NOT_ENABLED");
  assert.equal(refused.kind, "PERMANENT");
  assert.equal(calls.length, 1, "flag OFF: the undocumented PATCH is never sent");

  const onCalls = [];
  const on = createResendMarketingAdapter({ apiKey: "re_brand", config: baseConfig({ MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED: "true" }), sleep: async () => {}, fetchImpl: fetchSequence([response(200, { object: "contact", id: "c1" }), response(429, { name: "monthly_quota_exceeded" })], onCalls) });
  assert.equal(on.resubscribeSupported, true);
  await on.resubscribeContact("c1");
  assert.equal(onCalls[0].init.method, "PATCH");
  assert.match(onCalls[0].url, /\/contacts\/c1$/);
  assert.deepEqual(JSON.parse(onCalls[0].init.body), { unsubscribed: false });
  const quota = await on.getContact("y@reader.example").catch((error) => error);
  assert.equal(quota.errorKind, "QUOTA_EXHAUSTED");
  assert.equal(quota.quota.kind, "MONTHLY");
});

test("contract: re-subscription is optional for test doubles; unconfigured and fake adapters implement it", async () => {
  const unconfigured = unconfiguredMarketingAdapter("none");
  assert.equal((await unconfigured.resubscribeContact("x").catch((error) => error)).kind, "NOT_CONFIGURED");
  const fake = createFakeMarketingAdapter();
  assertMarketingAdapter(fake);
  const { id } = await fake.createContact({ email: "z@reader.example" });
  fake.providerUnsubscribe("z@reader.example");
  await fake.resubscribeContact(id);
  assert.equal((await fake.getContact("z@reader.example")).unsubscribed, false);
  fake.failNext("getContact", "QUOTA_EXHAUSTED", "DAILY", { now: new Date("2026-10-26T10:00:00Z") });
  const error = await fake.getContact("z@reader.example").catch((caught) => caught);
  assert.equal(error.quota.resetAt.toISOString(), "2026-10-27T00:00:00.000Z");
});

function memoryClient({ failWrites = false } = {}) {
  const rows = [];
  return {
    rows,
    mailProviderQuotaObservation: {
      async create({ data }) {
        if (failWrites) throw Object.assign(new Error("db down"), { code: "P1001" });
        rows.push({ id: String(rows.length + 1), ...data });
        return rows[rows.length - 1];
      },
      async findFirst({ where, orderBy }) {
        const sources = where.source?.in || (where.source ? [where.source] : null);
        const match = rows.filter((row) => row.scope === where.scope && (!where.provider || row.provider === where.provider) && (!sources || sources.includes(row.source)) && (!where.exhaustedUntil || (row.exhaustedUntil && row.exhaustedUntil > where.exhaustedUntil.gt)));
        match.sort((a, b) => (orderBy?.observedAt === "desc" ? b.observedAt - a.observedAt : a.observedAt - b.observedAt));
        return match[0] || null;
      },
    },
  };
}

test("observation sampling: at most one row per scope per minute, a quota error is always kept, failures never surface", async () => {
  let now = new Date("2026-10-26T10:00:00Z");
  const client = memoryClient();
  const quota = createProviderQuotaService({ client, config: baseConfig(), features: { isReady: async () => true }, clock: () => now });
  const hook = quota.observer("account");
  hook({ headers: new Headers({ "x-resend-monthly-quota": "10" }), status: 200 });
  hook({ headers: new Headers({ "x-resend-monthly-quota": "11" }), status: 200 });
  await quota.flush();
  assert.equal(client.rows.length, 1, "second response in the same minute is sampled out");
  hook({ headers: new Headers({ "x-resend-monthly-quota": "12" }), status: 429, errorName: "daily_quota_exceeded" });
  await quota.flush();
  assert.equal(client.rows.length, 2, "a quota error is recorded even inside the sampling window");
  assert.equal(client.rows[1].source, "QUOTA_ERROR");
  assert.equal(client.rows[1].exhaustedKind, "DAILY");
  assert.equal(client.rows[1].exhaustedUntil.toISOString(), "2026-10-27T00:00:00.000Z");
  hook({ headers: new Headers({}), status: 200 });
  await quota.flush();
  assert.equal(client.rows.length, 2, "responses without quota headers record nothing");
  now = new Date(now.getTime() + 61000);
  hook({ headers: new Headers({ "x-resend-monthly-quota": "13" }), status: 200 });
  await quota.flush();
  assert.equal(client.rows.length, 3, "a new minute records again");
  assert.deepEqual(await quota.exhaustedUntil("account"), { kind: "DAILY", until: new Date("2026-10-27T00:00:00.000Z") });

  const broken = createProviderQuotaService({ client: memoryClient({ failWrites: true }), config: baseConfig(), features: { isReady: async () => true }, clock: () => now, logger: { warn() {} } });
  broken.observer("account")({ headers: new Headers({ "x-resend-monthly-quota": "1" }), status: 200 });
  await broken.flush();
  const before37 = createProviderQuotaService({ client: memoryClient(), config: baseConfig(), features: { isReady: async () => false }, clock: () => now });
  before37.observer("account")({ headers: new Headers({ "x-resend-monthly-quota": "1" }), status: 200 });
  await before37.flush();
});

test("missing and partial provider metrics: UNKNOWN unless observed; remaining only when used AND limit are known; stale daily figures dropped", async () => {
  const now = new Date("2026-10-26T10:00:00Z");
  const client = memoryClient();
  const none = createProviderQuotaService({ client, config: baseConfig(), features: { isReady: async () => true }, clock: () => now });
  const empty = await none.snapshot("account");
  assert.equal(empty.status, "UNKNOWN");
  assert.equal(empty.monthlyUsed, null);
  assert.equal(empty.monthlyLimit, null);
  assert.equal(empty.remainingStatus, "UNKNOWN");
  assert.equal(empty.exhausted, false);

  client.rows.push({ provider: "resend", scope: "account", observedAt: new Date("2026-10-25T23:00:00Z"), dailyUsed: 90, monthlyUsed: 400, source: "RESPONSE_HEADER" });
  const partial = await none.snapshot("account");
  assert.equal(partial.status, "OBSERVED");
  assert.equal(partial.monthlyUsed, 400);
  assert.equal(partial.dailyUsed, null, "yesterday's daily figure is not today's usage");
  assert.equal(partial.remaining.monthly, null, "no configured limit -> remaining unknown");

  const limited = createProviderQuotaService({ client, config: baseConfig({ MAIL_PROVIDER_MONTHLY_LIMIT: "50000", MAIL_PROVIDER_DAILY_LIMIT: "100" }), features: { isReady: async () => true }, clock: () => now });
  const known = await limited.snapshot("account");
  assert.equal(known.monthlyLimit, 50000);
  assert.equal(known.remaining.monthly, 49600);
  assert.equal(known.remaining.daily, null, "daily used unknown today -> daily remaining unknown");
  assert.equal(known.limitSource, "CONFIGURED_LIMIT");
  assert.deepEqual(limited.configuredLimits("brand:karryam"), { daily: null, monthly: null }, "account limits never apply to a brand's own account");
  assert.equal(baseConfig({ MAIL_PROVIDER_MONTHLY_LIMIT: "-3" }).providerLimits.monthly, null);
  assert.equal(baseConfig({ MAIL_PROVIDER_MONTHLY_LIMIT: "abc" }).providerLimits.monthly, null);
  assert.equal(baseConfig({}).providerResubscribeEnabled, false, "re-subscription stays OFF by default");
});

test("pricing arithmetic: micros, decimals, no float drift", () => {
  assert.equal(decimalToMicros("0.0009"), 900n);
  assert.equal(decimalToMicros("1"), 1000000n);
  assert.equal(decimalToMicros("-1"), null);
  assert.equal(decimalToMicros("0.0000001"), null, "more than 6 decimals is refused");
  assert.equal(decimalToMicros("1e-3"), null);
  assert.equal(microsToDecimal(900n * 3n), "0.002700");
  assert.equal(microsToDecimal(123456789n), "123.456789");
});

// Re-audit: Resend's unsubscribe is account-global, so a re-subscription is
// only possible when the brand has its own provider account (brand key).
test("re-subscription: refused (SHARED_PROVIDER_ACCOUNT) unless the brand uses its own provider key", async () => {
  const { createResubscriptionService } = require("../src/modules/mail/marketing/resubscription.service");
  const confirmedAt = new Date("2026-10-26T10:00:00.000Z");
  const run = async (env) => {
    const created = [];
    const client = {
      marketingConsent: { findUnique: async () => ({ id: "c1", contactId: "k1", organizationId: "o1", topic: "newsletter", status: "GRANTED", doubleOptIn: true, confirmedAt, consentedAt: confirmedAt, source: "WEB_FORM", policyVersion: "v1", sourceEvidence: null }) },
      marketingContact: { findUnique: async () => ({ id: "k1", organizationId: "o1", email: "a@reader.example", status: "UNSUBSCRIBED" }) },
      marketingContactProviderState: { findUnique: async () => ({ contactId: "k1", state: "UNSUBSCRIBED", reason: "USER_UNSUBSCRIBE", observedAt: new Date("2026-10-01T00:00:00.000Z") }) },
      marketingProviderResubscription: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: "r1", ...data }; } },
      marketingSuppression: { findMany: async () => [] },
      mailOrganization: { findUnique: async () => ({ id: "o1", slug: "cosmicforge" }) },
    };
    const config = baseConfig({ MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT: "true", ...env });
    const service = createResubscriptionService({ client, config, env, features: { isReady: async () => true }, audit: { record: async () => null }, stepUp: null, marketingProviders: () => ({}) });
    await service.onDoubleOptInConfirmed({ consentId: "c1" });
    return created[0];
  };
  const shared = await run({ RESEND_MARKETING_API_KEY: "re_shared_unit" });
  assert.equal(shared.status, "REFUSED");
  assert.match(shared.lastError, /SHARED_PROVIDER_ACCOUNT/);
  const own = await run({ RESEND_MARKETING_API_KEY: "re_shared_unit", RESEND_MARKETING_API_KEY__COSMICFORGE: "re_brand_unit" });
  assert.equal(own.status, "PENDING_APPROVAL");
});
