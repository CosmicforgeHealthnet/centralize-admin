#!/usr/bin/env node
"use strict";

// Section 29.2 live-validation CLI for Advertising Execution.
//
// This command is intentionally excluded from `npm test`, CI, focused suites,
// pre-commit hooks and migration verification. It fails closed: unless every
// safety gate in live-validation-gates.js passes AND a real provider transport
// has been explicitly configured, it exits non-zero having made zero provider
// calls and decrypted zero credentials.
//
// Usage (never run automatically):
//   npm run live:read:google-ads -- --connection-id=… --account=… …
//   npm run live:validate:google-ads -- --connection-id=… --account=… \
//     --confirm-write=YES_CREATE_PAUSED_OBJECTS …

const { parseArgs, evaluateLiveTestGates, LiveTestSafetyError } = require("./live-validation-gates");
const { createLiveValidationHarness } = require("./live-validation-harness");

function resolveMode(argv) {
  const flag = argv.find((argument) => argument.startsWith("--mode="));
  const mode = flag ? flag.slice("--mode=".length) : "validate";
  return { mode, rest: argv.filter((argument) => !argument.startsWith("--mode=")) };
}

// Provider transports are NOT bundled with this repository on purpose: live
// account access is still blocked (see docs/advertising-execution-provider-
// access-blockers.md). Once sandbox access exists, a reviewed transport module
// can be registered here. Until then every invocation stops at this gate,
// after argument validation but before touching credentials or the network.
function loadConfiguredTransport(provider) {
  const moduleReference = String(process.env[`MARKETING_AD_EXECUTION_LIVE_TEST_${provider}_TRANSPORT_MODULE`] || "").trim();
  if (!moduleReference) {
    throw new LiveTestSafetyError(
      "LIVE_TRANSPORT_NOT_CONFIGURED",
      `No reviewed live transport is configured for ${provider}. ` +
      `Set MARKETING_AD_EXECUTION_LIVE_TEST_${provider}_TRANSPORT_MODULE to a reviewed transport module before running live validation.`,
    );
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const factory = require(moduleReference);
  if (typeof factory.createLiveTransport !== "function" || typeof factory.loadConnection !== "function") {
    throw new LiveTestSafetyError("LIVE_TRANSPORT_INVALID", "The configured transport module does not export createLiveTransport/loadConnection");
  }
  return factory;
}

async function main() {
  const { mode, rest } = resolveMode(process.argv.slice(2));
  const args = parseArgs(rest);
  const config = evaluateLiveTestGates({ args, env: process.env, mode });
  const factory = loadConfiguredTransport(config.provider);
  const transport = await factory.createLiveTransport({ config });
  const harness = createLiveValidationHarness({
    config,
    dependencies: {
      transport,
      loadConnection: factory.loadConnection,
      // Human write checkpoint: the transport module may add an interactive
      // prompt; the default is the explicit --confirm-write value alone.
      confirmWritePhase: factory.confirmWritePhase,
    },
  });
  const { exitCode, ledger } = await harness.run();
  if (ledger.manualFollowUpRequired) {
    console.error("[live-validation] MANUAL FOLLOW-UP REQUIRED for created resources:");
    for (const resource of ledger.createdResources) {
      console.error(`  ${resource.resourceType} ${resource.nativeResourceId} final=${resource.finalStatus}`);
    }
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  if (error instanceof LiveTestSafetyError) {
    console.error(`[live-validation] BLOCKED code=${error.code}`);
    console.error(`[live-validation] ${error.message}`);
    console.error("[live-validation] Zero provider calls were made and no credentials were decrypted.");
  } else {
    console.error(`[live-validation] FAILED ${String(error?.message || error).slice(0, 500)}`);
  }
  process.exitCode = 1;
});
