"use strict";

// Release preflight: validates the Product Integration Core configuration in
// the current environment exactly as the service would load it, without
// connecting to the database or any Product Admin.
//
// Usage: [PIC_EXPECT_ENVIRONMENT=staging] node scripts/check-config.js
// Prints one sanitized JSON line (never a key, URL or path) and exits 1 on
// any configuration error.

const { loadConfig } = require("../src/config");

function main(env = process.env) {
  const config = loadConfig(env);
  if (env.PIC_EXPECT_ENVIRONMENT && (!config.enabled || config.environment !== env.PIC_EXPECT_ENVIRONMENT)) {
    const err = new Error("PIC_ENVIRONMENT_NOT_EXPECTED");
    err.reason = "PIC_ENVIRONMENT_NOT_EXPECTED";
    throw err;
  }
  if (!config.enabled) return { event: "config_valid", enabled: false, listen: config.listen.kind };
  return {
    event: "config_valid",
    enabled: true,
    environment: config.environment,
    listen: config.listen.kind,
    sync_enabled: config.sync.enabled,
    endpoints: config.endpoints.size,
    trusted_signers: Object.keys(config.trustStore).length,
    trust_store_fingerprint: config.trustStore.fingerprint,
    hq_delegation_keys: Object.keys(config.hqDelegationKeys).length,
    insecure_loopback: config.allowInsecureLoopback,
  };
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
