"use strict";

// Cached probe: are the HQ session/MFA tables present?
//
// The API can be deployed before the manual 20261025 migration is applied.
// Until every table below exists, callers must behave exactly like the
// pre-release code (admin_refresh_tokens only, no sessions, no MFA).
// `true` is cached for the life of the process; `false` is re-checked at most
// every `recheckMs` so applying the migration takes effect without a restart.

const AUTH_TABLES = Object.freeze([
  "admin_sessions",
  "admin_session_refresh_tokens",
  "admin_mfa_enrollments",
  "admin_mfa_recovery_codes",
  "admin_mfa_challenges",
  "admin_auth_events",
]);

function createSchemaReadiness({ client, logger = null, recheckMs = 30_000, now = () => Date.now() } = {}) {
  let ready = false;
  let checkedAt = null;
  let inFlight = null;
  let warned = false;

  async function probe() {
    try {
      const rows = await client.$queryRawUnsafe(
        `SELECT ${AUTH_TABLES.map((name, i) => `to_regclass('public.${name}') IS NOT NULL AS t${i}`).join(", ")}`,
      );
      const row = rows?.[0] || {};
      return AUTH_TABLES.every((_, i) => row[`t${i}`] === true);
    } catch {
      return false;
    }
  }

  async function isReady() {
    if (ready) return true;
    if (checkedAt !== null && now() - checkedAt < recheckMs) return false;
    inFlight ??= probe().then((result) => {
      ready = result;
      checkedAt = now();
      inFlight = null;
      if (!result && !warned) {
        warned = true;
        logger?.warn?.("[Auth] Session/MFA tables are not present (migration 20261025_add_admin_sessions_mfa.sql not applied). Running the pre-release legacy login; sessions and MFA are unavailable.");
      }
      if (result) logger?.info?.("[Auth] Session/MFA schema detected.");
      return result;
    });
    return inFlight;
  }

  return Object.freeze({
    isReady,
    // Tests only.
    reset() {
      ready = false;
      checkedAt = null;
      inFlight = null;
      warned = false;
    },
  });
}

module.exports = { createSchemaReadiness, AUTH_TABLES };
