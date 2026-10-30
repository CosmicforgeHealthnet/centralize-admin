"use strict";

// GAP 3 (spec 13.3): provider sending quota, reported truthfully.
//
// What Resend documents (2026-10) and nothing more:
// - response headers `x-resend-monthly-quota` (emails used this month) and
//   `x-resend-daily-quota` (used today; free plan only), plus
//   `ratelimit-limit|remaining|reset` and `retry-after`;
// - 429 errors `daily_quota_exceeded` (resets at midnight UTC) and
//   `monthly_quota_exceeded` (resets on the first of next month).
// There is no quota or billing API. Plan limits are what the operator
// configures (MAIL_PROVIDER_MONTHLY_LIMIT / MAIL_PROVIDER_DAILY_LIMIT, or the
// __<SLUG> variants for a brand's own account); without them the limit and
// "remaining" are UNKNOWN, never guessed.
//
// Observations are written to mail_provider_quota_observations (migration 37)
// by a non-blocking hook the adapters call after every response: at most one
// row per scope per minute (a quota error is always kept), and a failure to
// record never fails or delays a send.

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");
const { MailProviderError } = require("../adapters/mail-provider.contract");

const SAMPLE_MS = 60 * 1000;
const QUOTA_ERROR_NAMES = { daily_quota_exceeded: "DAILY", monthly_quota_exceeded: "MONTHLY" };

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : null;
}

function nonNegativeInt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number <= 2147483647 ? number : null;
}

// Pure: the documented quota / rate-limit headers of one response.
function parseQuotaHeaders(headers) {
  return {
    monthlyUsed: nonNegativeInt(readHeader(headers, "x-resend-monthly-quota")),
    dailyUsed: nonNegativeInt(readHeader(headers, "x-resend-daily-quota")),
    rateLimit: {
      limit: nonNegativeInt(readHeader(headers, "ratelimit-limit")),
      remaining: nonNegativeInt(readHeader(headers, "ratelimit-remaining")),
      resetSeconds: nonNegativeInt(readHeader(headers, "ratelimit-reset")),
    },
    retryAfterSeconds: nonNegativeInt(readHeader(headers, "retry-after")),
  };
}

// "DAILY" | "MONTHLY" | null for a provider error response.
function quotaErrorKind(status, errorName) {
  if (Number(status) !== 429) return null;
  return QUOTA_ERROR_NAMES[String(errorName || "").trim().toLowerCase()] || null;
}

// Next documented reset: midnight UTC, or 00:00 UTC on the 1st of next month.
function quotaResetAt(kind, now = new Date()) {
  const date = new Date(now);
  if (kind === "MONTHLY") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

// A quota refusal is definitive (nothing was sent) and is NOT a short retry.
// `kind` stays RETRYABLE so every existing caller keeps treating it as a safe,
// non-ambiguous refusal; `errorKind` / `quota` tell quota-aware callers to
// defer until the reset instead of retrying.
function quotaExhaustedError(kind, { now = new Date(), message = null, status = 429 } = {}) {
  const resetAt = quotaResetAt(kind, now);
  const seconds = Math.max(1, Math.ceil((resetAt.getTime() - new Date(now).getTime()) / 1000));
  const error = new MailProviderError("RETRYABLE", kind === "MONTHLY" ? "RESEND_MONTHLY_QUOTA_EXCEEDED" : "RESEND_DAILY_QUOTA_EXCEEDED", message || `Provider ${kind.toLowerCase()} sending quota exhausted`, { status, retryAfterSeconds: seconds, category: "QUOTA_EXCEEDED", providerErrorName: kind === "MONTHLY" ? "monthly_quota_exceeded" : "daily_quota_exceeded", provider: "resend" });
  error.errorKind = "QUOTA_EXHAUSTED";
  error.quota = { kind, resetAt, deferSeconds: seconds };
  return error;
}

function isQuotaExhausted(error) {
  return error?.errorKind === "QUOTA_EXHAUSTED" && Boolean(error.quota?.resetAt);
}

// Seconds a job should wait for a quota reset (the worker defers at most a day
// at a time; a monthly exhaustion simply defers again).
function quotaDeferSeconds(error, now = new Date()) {
  if (!isQuotaExhausted(error)) return null;
  const seconds = Math.ceil((new Date(error.quota.resetAt).getTime() - new Date(now).getTime()) / 1000);
  return Math.min(Math.max(seconds, 1), 86400);
}

function slugEnv(slug) {
  return String(slug || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function positiveLimit(value) {
  const parsed = nonNegativeInt(value);
  return parsed && parsed > 0 ? parsed : null;
}

function createProviderQuotaService({ client, config, env = process.env, features = null, clock = () => new Date(), logger = null, sampleMs = SAMPLE_MS } = {}) {
  const lastWrite = new Map(); // scope -> { at, source }
  const exhausted = new Map(); // scope -> { kind, until }
  const latestRate = new Map(); // scope -> { ...rateLimit, observedAt }
  const pending = new Set();
  const ready = async () => {
    if (!features) return false;
    try {
      return await features.isReady();
    } catch {
      return false;
    }
  };

  // Configured plan limits for a scope (account = transactional key; a brand
  // scope may have its own __<SLUG> limits; otherwise unknown).
  function configuredLimits(scope) {
    if (scope === "account") return { daily: config?.providerLimits?.daily ?? null, monthly: config?.providerLimits?.monthly ?? null };
    const match = /^brand:(.+)$/.exec(scope);
    if (match) return { daily: positiveLimit(env[`MAIL_PROVIDER_DAILY_LIMIT__${slugEnv(match[1])}`]), monthly: positiveLimit(env[`MAIL_PROVIDER_MONTHLY_LIMIT__${slugEnv(match[1])}`]) };
    // Re-audit: the shared marketing account (RESEND_MARKETING_API_KEY with
    // MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT) has its own plan limits.
    if (scope === "marketing-shared") return { daily: positiveLimit(env.MAIL_PROVIDER_DAILY_LIMIT__MARKETING_SHARED), monthly: positiveLimit(env.MAIL_PROVIDER_MONTHLY_LIMIT__MARKETING_SHARED) };
    return { daily: null, monthly: null };
  }

  async function write(scope, provider, observation) {
    if (!(await ready())) return;
    const limits = configuredLimits(scope);
    await client.mailProviderQuotaObservation.create({
      data: {
        provider: String(provider).slice(0, 32),
        scope: String(scope).slice(0, 64),
        observedAt: observation.observedAt,
        dailyUsed: observation.dailyUsed,
        monthlyUsed: observation.monthlyUsed,
        dailyLimit: limits.daily,
        monthlyLimit: limits.monthly,
        source: observation.source,
        exhaustedKind: observation.exhaustedKind || null,
        exhaustedUntil: observation.exhaustedUntil || null,
      },
    });
  }

  // Non-blocking; never throws. Returns the (tracked) promise for tests.
  function record(scope, provider, { headers = null, status = null, errorName = null } = {}) {
    let parsed;
    try {
      parsed = parseQuotaHeaders(headers);
    } catch {
      return Promise.resolve();
    }
    const now = clock();
    const kind = quotaErrorKind(status, errorName);
    if (parsed.rateLimit.limit !== null || parsed.rateLimit.remaining !== null) latestRate.set(scope, { ...parsed.rateLimit, observedAt: now });
    if (kind) exhausted.set(scope, { kind, until: quotaResetAt(kind, now) });
    if (parsed.monthlyUsed === null && parsed.dailyUsed === null && !kind) return Promise.resolve();
    const source = kind ? "QUOTA_ERROR" : "RESPONSE_HEADER";
    const last = lastWrite.get(scope);
    const sampled = last && now.getTime() - last.at < sampleMs && !(source === "QUOTA_ERROR" && last.source !== "QUOTA_ERROR");
    if (sampled) return Promise.resolve();
    lastWrite.set(scope, { at: now.getTime(), source });
    const promise = write(scope, provider, {
      observedAt: now,
      dailyUsed: parsed.dailyUsed,
      monthlyUsed: parsed.monthlyUsed,
      source,
      exhaustedKind: kind,
      exhaustedUntil: kind ? quotaResetAt(kind, now) : null,
    }).catch((error) => {
      logger?.warn?.(`[Mail] provider quota observation not recorded (${error?.code || "error"})`);
    });
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  // Hook handed to an adapter (adapter.setQuotaObserver(observer(scope))).
  function observer(scope, provider = "resend") {
    return (info) => {
      record(scope, provider, info);
    };
  }

  // Known exhaustion for a scope (this process first, then the database).
  async function exhaustedUntil(scope) {
    const now = clock();
    const local = exhausted.get(scope);
    if (local && local.until > now) return local;
    if (!scope || !(await ready())) return null;
    try {
      const row = await client.mailProviderQuotaObservation.findFirst({ where: { scope, source: "QUOTA_ERROR", exhaustedUntil: { gt: now } }, orderBy: { observedAt: "desc" } });
      return row ? { kind: row.exhaustedKind, until: row.exhaustedUntil } : null;
    } catch {
      return null;
    }
  }

  // Records the configured plan limits once per process and scope (source
  // CONFIGURED_LIMIT) so the observation history shows what limit applied.
  const limitsRecorded = new Set();
  async function recordConfiguredLimits(scope, provider = "resend") {
    const limits = configuredLimits(scope);
    if ((limits.daily === null && limits.monthly === null) || limitsRecorded.has(scope)) return;
    limitsRecorded.add(scope);
    if (!(await ready())) return;
    await client.mailProviderQuotaObservation.create({ data: { provider, scope, observedAt: clock(), source: "CONFIGURED_LIMIT", dailyLimit: limits.daily, monthlyLimit: limits.monthly } }).catch(() => limitsRecorded.delete(scope));
  }

  // Current quota picture for one scope. Used figures come only from provider
  // headers / quota errors; limits only from configuration; remaining only
  // when both are known.
  async function snapshot(scope, provider = "resend") {
    const now = clock();
    const limits = configuredLimits(scope);
    const [latest, error] = await Promise.all([
      client.mailProviderQuotaObservation.findFirst({ where: { scope, provider, source: { in: ["RESPONSE_HEADER", "QUOTA_ERROR"] } }, orderBy: { observedAt: "desc" } }),
      client.mailProviderQuotaObservation.findFirst({ where: { scope, provider, source: "QUOTA_ERROR" }, orderBy: { observedAt: "desc" } }),
    ]);
    const local = exhausted.get(scope);
    const until = [error?.exhaustedUntil, local?.until].filter((value) => value && value > now).sort((a, b) => b - a)[0] || null;
    const exhaustedKind = until ? (local?.until?.getTime() === until.getTime() ? local.kind : error?.exhaustedKind) : null;
    const dailyUsed = latest?.dailyUsed ?? null;
    const monthlyUsed = latest?.monthlyUsed ?? null;
    // A daily figure from yesterday is not today's usage.
    const dailyFresh = latest && latest.observedAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    const monthlyFresh = latest && latest.observedAt.toISOString().slice(0, 7) === now.toISOString().slice(0, 7);
    const remaining = {
      daily: limits.daily !== null && dailyUsed !== null && dailyFresh ? Math.max(0, limits.daily - dailyUsed) : null,
      monthly: limits.monthly !== null && monthlyUsed !== null && monthlyFresh ? Math.max(0, limits.monthly - monthlyUsed) : null,
    };
    const rate = latestRate.get(scope) || null;
    return {
      scope,
      provider,
      status: latest ? "OBSERVED" : "UNKNOWN",
      dailyUsed: dailyFresh ? dailyUsed : null,
      monthlyUsed: monthlyFresh ? monthlyUsed : null,
      dailyLimit: limits.daily,
      monthlyLimit: limits.monthly,
      limitSource: limits.daily !== null || limits.monthly !== null ? "CONFIGURED_LIMIT" : "UNKNOWN",
      remaining,
      remainingStatus: remaining.daily !== null || remaining.monthly !== null ? "KNOWN" : "UNKNOWN",
      observedAt: latest ? latest.observedAt.toISOString() : null,
      source: latest?.source || null,
      exhausted: Boolean(until),
      exhaustedKind: exhaustedKind || null,
      exhaustedUntil: until ? until.toISOString() : null,
      rateLimit: rate ? { limit: rate.limit, remaining: rate.remaining, resetSeconds: rate.resetSeconds, observedAt: rate.observedAt.toISOString() } : null,
      notes: [
        "Used figures come from Resend response headers (x-resend-daily-quota is sent on the free plan only).",
        limits.daily === null && limits.monthly === null ? "No plan limit is configured: remaining quota is unknown." : "Limits are the configured account plan, not read from the provider.",
      ],
    };
  }

  function notReady() {
    return mailError("MAIL_FEATURE_NOT_READY", { feature: "provider_quota" });
  }

  // GET /admin/provider-quota (mail admins): the account scope plus every
  // brand scope that has its own provider key or recorded observations.
  async function adminQuota(user) {
    await policy.requireMailAdmin(client, user, "VIEW");
    if (!(await ready())) throw notReady();
    // Lazy: adapters/marketing requires this module.
    const { resolveBrandApiKey, quotaScopeFor } = require("../adapters/marketing");
    const organizations = await client.mailOrganization.findMany({ select: { slug: true }, take: 500 });
    // Brand scopes and (re-audit) the shared marketing account scope.
    const brandScopes = [...new Set(organizations.map((org) => quotaScopeFor(org.slug, resolveBrandApiKey(org.slug, { env, config }).source)).filter(Boolean))];
    const observed = await client.mailProviderQuotaObservation.findMany({ distinct: ["provider", "scope"], select: { provider: true, scope: true }, take: 200 });
    const provider = config?.provider === "fake" ? "fake" : "resend";
    const scopes = new Map([[`${provider}:account`, { provider, scope: "account" }]]);
    for (const scope of brandScopes) scopes.set(`${provider}:${scope}`, { provider, scope });
    for (const row of observed) scopes.set(`${row.provider}:${row.scope}`, row);
    await Promise.all([...scopes.values()].map((entry) => recordConfiguredLimits(entry.scope, entry.provider)));
    const items = [];
    for (const entry of scopes.values()) items.push(await snapshot(entry.scope, entry.provider));
    return {
      generatedAt: clock().toISOString(),
      items,
      billing: { status: "UNAVAILABLE", reason: "Resend has no billing or spend API; costs shown elsewhere are estimates from approved pricing rows." },
    };
  }

  return {
    record,
    observer,
    snapshot,
    adminQuota,
    exhaustedUntil,
    configuredLimits,
    recordConfiguredLimits,
    flush: () => Promise.all([...pending]),
    ready,
  };
}

module.exports = {
  createProviderQuotaService,
  parseQuotaHeaders,
  quotaErrorKind,
  quotaResetAt,
  quotaExhaustedError,
  isQuotaExhausted,
  quotaDeferSeconds,
};
