"use strict";

// Release preflight: validates the Karryam Admin configuration in the
// current environment exactly as the service would load it, without
// connecting to the database, the Bridge or HQ.
//
// Usage: [KARRYAM_ADMIN_EXPECT_ENVIRONMENT=staging] node scripts/check-config.js
// Prints one sanitized JSON line (describeConfig: never a key, URL or path)
// and exits 1 on any configuration error.

const { loadConfig, describeConfig } = require("../src/config");

function main(env = process.env) {
  const config = loadConfig(env);
  if (env.KARRYAM_ADMIN_EXPECT_ENVIRONMENT && (!config.enabled || config.environment !== env.KARRYAM_ADMIN_EXPECT_ENVIRONMENT)) {
    const err = new Error("KARRYAM_ADMIN_ENVIRONMENT_NOT_EXPECTED");
    err.reason = "KARRYAM_ADMIN_ENVIRONMENT_NOT_EXPECTED";
    throw err;
  }
  return { event: "config_valid", ...describeConfig(config) };
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
