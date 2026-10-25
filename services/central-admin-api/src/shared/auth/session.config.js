"use strict";

// HQ session configuration. Read from the environment on every call so tests
// and operators can switch modes without a restart-order dependency.
//
// AUTH_SESSION_MODE
//   legacy  (default) - unchanged contract: access JWT in the response body,
//                       Bearer header, refresh cookie. Sessions are still
//                       tracked server-side (revocation + reuse detection).
//   dual              - adds httpOnly access/refresh cookies + CSRF. The body
//                       token is still returned and Bearer is still accepted,
//                       so old frontend tabs keep working during rollout.
//   cookie            - cookies only. No token in any response body, Bearer is
//                       rejected for user sessions.

const MODES = Object.freeze(["legacy", "dual", "cookie"]);

function int(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function flag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

// `schemaReady: false` forces legacy (the session/MFA tables are missing).
function loadSessionConfig(env = process.env, { schemaReady = true } = {}) {
  const requested = String(env.AUTH_SESSION_MODE || "legacy").trim().toLowerCase();
  const configured = MODES.includes(requested) ? requested : "legacy";
  const mode = schemaReady ? configured : "legacy";
  const production = env.NODE_ENV === "production";
  const sameSiteRaw = String(env.AUTH_COOKIE_SAMESITE || (production ? "none" : "lax")).trim().toLowerCase();
  const sameSite = ["none", "lax", "strict"].includes(sameSiteRaw) ? sameSiteRaw : "lax";
  // SameSite=None is only honoured by browsers together with Secure.
  const secure = sameSite === "none" ? true : flag(env.AUTH_COOKIE_SECURE, production);
  const domain = String(env.AUTH_COOKIE_DOMAIN || "").trim() || null;
  // __Host- requires Secure, Path=/ and no Domain; __Secure- requires Secure.
  const hostPrefix = secure && !domain;
  const legacyAccessTtl = 8 * 60 * 60;
  return Object.freeze({
    mode,
    requestedMode: requested,
    schemaReady,
    sessionsEnabled: schemaReady,
    degradedFrom: !schemaReady && configured !== "legacy" ? configured : null,
    cookiesEnabled: mode !== "legacy",
    bodyTokenEnabled: mode !== "cookie",
    bearerAccepted: mode !== "cookie",
    accessTokenTtlSeconds: int(env.AUTH_ACCESS_TOKEN_TTL_SECONDS, mode === "legacy" ? legacyAccessTtl : 15 * 60, 60, legacyAccessTtl),
    idleTimeoutSeconds: int(env.AUTH_SESSION_IDLE_TIMEOUT_MINUTES, 12 * 60, 5, 7 * 24 * 60) * 60,
    absoluteTimeoutSeconds: int(env.AUTH_SESSION_ABSOLUTE_TIMEOUT_HOURS, 7 * 24, 1, 30 * 24) * 3600,
    refreshReuseGraceSeconds: int(env.AUTH_REFRESH_REUSE_GRACE_SECONDS, 10, 0, 60),
    maxSessionsPerUser: int(env.AUTH_MAX_SESSIONS_PER_USER, 10, 1, 100),
    lastSeenWriteIntervalSeconds: 60,
    cookie: Object.freeze({
      sameSite,
      secure,
      domain,
      accessName: hostPrefix ? "__Host-cf_at" : secure ? "__Secure-cf_at" : "cf_at",
      refreshName: secure ? "__Secure-cf_rt" : "cf_rt",
      mfaChallengeName: secure ? "__Secure-cf_mfa" : "cf_mfa",
      refreshPath: "/api/auth",
    }),
    // Legacy refresh cookie (kept so legacy/dual clients and rollback keep working).
    legacyRefreshCookie: "refreshToken",
  });
}

module.exports = { loadSessionConfig, SESSION_MODES: MODES };
