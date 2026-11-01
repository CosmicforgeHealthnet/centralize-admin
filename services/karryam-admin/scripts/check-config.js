"use strict";

// Release preflight: validates the Karryam Admin configuration in the
// current environment exactly as the service would load it, without
// connecting to the database, the Bridge or HQ.
//
// Usage: [KARRYAM_ADMIN_EXPECT_ENVIRONMENT=staging] node scripts/check-config.js
// Prints one sanitized JSON line (describeConfig: never a key, URL or path)
// and exits 1 on any configuration error.

const { loadConfig, describeConfig } = require("../src/config");


// Staging-only preflight (Section 12.3/12.5.3): a staging configuration must
// never point at a production endpoint, and a runtime database identity is
// never the PostgreSQL superuser. PRODUCT_ADMIN_PRODUCTION_DENYLIST is the
// operator's comma-separated list of production hostnames/IPs; without it
// the result says so instead of claiming the check passed.
function stagingIsolation(env, hosts, dbUrls) {
  const list = String(env.PRODUCT_ADMIN_PRODUCTION_DENYLIST || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts.filter(Boolean).map((v) => String(v).toLowerCase())) {
    if (list.includes(h)) { const err = new Error("PRODUCTION_ENDPOINT_IN_STAGING"); err.reason = "PRODUCTION_ENDPOINT_IN_STAGING"; throw err; }
  }
  for (const u of dbUrls.filter(Boolean)) {
    let user = "";
    try { user = decodeURIComponent(new URL(u).username); } catch { /* validated by loadConfig */ }
    if (user === "postgres") { const err = new Error("DATABASE_SUPERUSER_IDENTITY"); err.reason = "DATABASE_SUPERUSER_IDENTITY"; throw err; }
  }
  return list.length ? "CHECKED" : "NOT_PROVIDED";
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };

function main(env = process.env) {
  const config = loadConfig(env);
  if (env.KARRYAM_ADMIN_EXPECT_ENVIRONMENT && (!config.enabled || config.environment !== env.KARRYAM_ADMIN_EXPECT_ENVIRONMENT)) {
    const err = new Error("KARRYAM_ADMIN_ENVIRONMENT_NOT_EXPECTED");
    err.reason = "KARRYAM_ADMIN_ENVIRONMENT_NOT_EXPECTED";
    throw err;
  }
  const out = { event: "config_valid", ...describeConfig(config) };
  if (config.enabled && config.environment === "staging") {
    out.production_denylist = stagingIsolation(env, [hostOf(config.databaseUrl), config.bridge.enabled ? config.bridge.hostname : null, config.bridge.enabled ? config.bridge.address : null], [config.databaseUrl]);
  }
  return out;
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(main()) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ event: "config_invalid", reason: /^[A-Z][A-Z0-9_]{2,63}$/.test(String(err.reason)) ? err.reason : "CONFIGURATION_INVALID" }) + "\n");
    process.exit(1);
  }
}

module.exports = { main };
