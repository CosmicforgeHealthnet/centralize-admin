"use strict";

// Fixed-window rate limiting shared by every API replica (spec 19.5, 20).
//
// Counters live in mail_rate_limit_buckets (migration 35, Admin PostgreSQL:
// the existing supported shared infrastructure; no new service). One atomic
// INSERT ... ON CONFLICT DO UPDATE per request, so switching replicas does not
// reset a caller's budget.
//
// Fail-safe: when the table is missing or the database call fails, the limiter
// falls back to a process-local window with the SAME limit (still bounded,
// never unlimited) and counts `rate_limit_fallback` so operators can see it.
// Callers that must fail closed (sensitive writes) pass `failClosed: true`
// and get a 503-style refusal instead.

function createSharedRateLimiter({ client, features, metrics = null, logger = null, clock = () => Date.now() }) {
  const local = new Map();
  let warned = false;
  let calls = 0;

  function localConsume(key, max, windowMs) {
    const now = clock();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const id = `${key}|${windowStart}`;
    const count = (local.get(id) || 0) + 1;
    local.set(id, count);
    if (local.size > 20000) for (const entry of local.keys()) if (Number(entry.split("|").pop()) < windowStart) local.delete(entry);
    return { allowed: count <= max, count, resetAt: windowStart + windowMs, shared: false };
  }

  async function consume(key, { max, windowMs = 60000, failClosed = false } = {}) {
    const cleanKey = String(key).slice(0, 200);
    if (!features || !(await features.isReady())) return { ...localConsume(cleanKey, max, windowMs), reason: "SCHEMA_NOT_READY" };
    const now = clock();
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs * 2);
    try {
      const rows = await client.$queryRaw`
        INSERT INTO "mail_rate_limit_buckets" ("key", "window_start", "count", "expires_at")
        VALUES (${cleanKey}, ${windowStart}, 1, ${expiresAt})
        ON CONFLICT ("key", "window_start") DO UPDATE SET "count" = "mail_rate_limit_buckets"."count" + 1
        RETURNING "count"`;
      calls += 1;
      if (calls % 500 === 0) {
        client.$executeRaw`DELETE FROM "mail_rate_limit_buckets" WHERE "expires_at" < ${new Date(now)}`.catch(() => {});
      }
      const count = Number(rows[0]?.count || 0);
      return { allowed: count <= max, count, resetAt: windowStart.getTime() + windowMs, shared: true };
    } catch (error) {
      metrics?.inc?.("rate_limit_fallback", { reason: "DB_ERROR" });
      if (!warned) {
        warned = true;
        logger?.warn?.(`[Mail] shared rate limiter unavailable (${error?.code || "error"}); using process-local limits`);
      }
      if (failClosed) return { allowed: false, count: null, resetAt: now + windowMs, shared: false, unavailable: true };
      return { ...localConsume(cleanKey, max, windowMs), reason: "DB_ERROR" };
    }
  }

  // Express middleware. `keyOf(req)` names the subject (user id / IP).
  function middleware({ name, max, windowMs = 60000, keyOf, onLimited, failClosed = false }) {
    return async (req, res, next) => {
      try {
        const result = await consume(`${name}:${keyOf(req)}`, { max, windowMs, failClosed });
        res.setHeader("RateLimit-Limit", String(max));
        res.setHeader("RateLimit-Remaining", String(Math.max(0, max - (result.count || 0))));
        res.setHeader("RateLimit-Reset", String(Math.max(0, Math.ceil((result.resetAt - clock()) / 1000))));
        if (!result.allowed) return onLimited(req, res, next, result);
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return { consume, middleware };
}

module.exports = { createSharedRateLimiter };
