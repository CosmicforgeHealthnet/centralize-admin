"use strict";

// Section 29.2 — offline safety tests for the live-validation harness.
// These tests run entirely offline with fake transports: they prove the live
// commands fail closed, require explicit double confirmation, enforce the
// sandbox account allowlist, budget cap and currency allowlist, force paused
// resources, sanitize the ledger, always attempt cleanup, and are excluded
// from CI and default test commands.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  evaluateLiveTestGates,
  parseArgs,
  LiveTestSafetyError,
  REQUIRED_CONFIRMATION_VALUE,
  REQUIRED_WRITE_CONFIRMATION_VALUE,
} = require("../scripts/advertising-execution/live-validation-gates");
const { createLiveValidationHarness, sanitizeLedgerValue, STAGES } = require("../scripts/advertising-execution/live-validation-harness");

const SANDBOX_ACCOUNT = "sandbox-account-1";
const CONNECTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const GOOD_ENV = Object.freeze({
  MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMED: "true",
  MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMATION: REQUIRED_CONFIRMATION_VALUE,
  MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_ALLOWLIST: `${SANDBOX_ACCOUNT},sandbox-account-2`,
  MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_DENYLIST: "production-account-1",
  MARKETING_AD_EXECUTION_LIVE_TEST_MAX_BUDGET_MINOR: "100",
  MARKETING_AD_EXECUTION_LIVE_TEST_CURRENCY: "USD",
  MARKETING_AD_EXECUTION_LIVE_TEST_DESTINATION_ALLOWLIST: "test-destination.example",
});

const GOOD_ARGS = Object.freeze({
  connectionId: CONNECTION_ID,
  account: SANDBOX_ACCOUNT,
  budgetMinor: "0",
  currency: "USD",
  destinationUrl: "https://test-destination.example/landing",
  resourcePrefix: "CF-TEST-S29",
  cleanup: "pause",
  operator: "ops@cosmicforge.example",
  reason: "Section 29 live validation rehearsal ticket CF-1234",
});

// The real test process has the network guard installed; gate evaluation is
// exercised with an empty global scope so each individual gate is testable.
function gates(overrides = {}) {
  return evaluateLiveTestGates({
    args: { ...GOOD_ARGS, ...(overrides.args || {}) },
    env: { ...GOOD_ENV, ...(overrides.env || {}) },
    mode: overrides.mode || "validate",
    provider: overrides.provider || "GOOGLE_ADS",
    globalScope: overrides.globalScope || {},
  });
}

function rejectsGate(overrides, expectedCode) {
  assert.throws(() => gates(overrides), (error) => {
    assert.ok(error instanceof LiveTestSafetyError, `expected LiveTestSafetyError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, expectedCode);
    assert.equal(error.exitCode, 1);
    return true;
  });
}

function createFakeLiveTransport(overrides = {}) {
  const calls = { readAccount: 0, validateOnly: 0, createPausedResources: 0, readBackResource: 0, cleanupResource: 0 };
  const statuses = new Map();
  const transport = {
    calls,
    async readAccount() { calls.readAccount += 1; return { accessible: true, apiVersion: "v24", providerRequestId: "fake-read-req-1", capabilities: { edit: true }, ...(overrides.account || {}) }; },
    async validateOnly() { calls.validateOnly += 1; return { valid: true, warnings: [], providerRequestId: "fake-validate-req-1", ...(overrides.validation || {}) }; },
    async createPausedResources() {
      calls.createPausedResources += 1;
      const resources = overrides.resources || [
        { resourceType: "CAMPAIGN_BUDGET", nativeResourceId: "budget-1", status: "PAUSED", providerRequestId: "fake-create-req-1" },
        { resourceType: "CAMPAIGN", nativeResourceId: "campaign-1", parentNativeResourceId: "budget-1", status: "PAUSED", providerRequestId: "fake-create-req-2" },
      ];
      for (const resource of resources) statuses.set(resource.nativeResourceId, resource.status);
      return { resources };
    },
    async readBackResource({ nativeResourceId }) { calls.readBackResource += 1; return { status: statuses.get(nativeResourceId) || "UNKNOWN" }; },
    async cleanupResource({ nativeResourceId }) {
      calls.cleanupResource += 1;
      if (overrides.cleanupFails) throw new Error("provider cleanup unavailable");
      statuses.set(nativeResourceId, "PAUSED");
      return { action: "PAUSE" };
    },
  };
  return transport;
}

function runHarness({ config, transport, connection, files = new Map(), confirmWritePhase }) {
  const harness = createLiveValidationHarness({
    config,
    dependencies: {
      transport,
      loadConnection: async () => connection ?? { platform: "GOOGLE_ADS", accountId: SANDBOX_ACCOUNT, testAccount: true },
      confirmWritePhase,
      now: () => new Date("2026-07-23T10:00:00.000Z"),
      writeFile: (target, content) => files.set(target, content),
      mkdir: () => {},
    },
    logger: { log: () => {}, error: () => {} },
  });
  return { harness, files };
}

test("live gates fail closed on missing or wrong confirmation with zero provider calls", () => {
  // 1. Missing first confirmation flag.
  rejectsGate({ env: { MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMED: "" } }, "LIVE_CONFIRMATION_FLAG_REQUIRED");
  // 2. Wrong unique confirmation value.
  rejectsGate({ env: { MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMATION: "yes" } }, "LIVE_CONFIRMATION_VALUE_REQUIRED");
  rejectsGate({ env: { MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMATION: REQUIRED_CONFIRMATION_VALUE.toLowerCase() } }, "LIVE_CONFIRMATION_VALUE_REQUIRED");
  // Gate failures happen before any transport exists, so provider calls are structurally zero.
  assert.equal(REQUIRED_WRITE_CONFIRMATION_VALUE, "YES_CREATE_PAUSED_OBJECTS");
});

test("live gates require sandbox connection, account allowlist and deny production-like accounts", () => {
  // 3. Missing account allowlist.
  rejectsGate({ env: { MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_ALLOWLIST: "" } }, "LIVE_ACCOUNT_ALLOWLIST_REQUIRED");
  // 4. Production-like account denied: not allowlisted...
  rejectsGate({ args: { account: "production-account-2" } }, "LIVE_ACCOUNT_NOT_ALLOWLISTED");
  // ...and the denylist wins even when an account was allowlisted by mistake.
  rejectsGate({
    env: { MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_ALLOWLIST: "production-account-1" },
    args: { account: "production-account-1" },
  }, "LIVE_ACCOUNT_DENYLISTED");
  // 8. Non-test connection reference denied.
  rejectsGate({ args: { connectionId: "not-a-uuid" } }, "LIVE_SANDBOX_CONNECTION_REQUIRED");
});

test("live gates enforce Decimal budget cap, currency allowlist and destination allowlist", () => {
  // 5. Budget above cap denied before any provider call.
  rejectsGate({ args: { budgetMinor: "101" } }, "LIVE_BUDGET_ABOVE_CAP");
  rejectsGate({ args: { budgetMinor: "10.5" } }, "LIVE_BUDGET_INVALID");
  rejectsGate({ env: { MARKETING_AD_EXECUTION_LIVE_TEST_MAX_BUDGET_MINOR: "" } }, "LIVE_BUDGET_CAP_REQUIRED");
  // Exact-cap boundary passes; zero-spend is the preferred default.
  assert.equal(gates({ args: { budgetMinor: "100" } }).requestedBudgetMinor, "100");
  assert.equal(gates().requestedBudgetMinor, "0");
  // 6. Unsupported currency denied.
  rejectsGate({ args: { currency: "JPY" } }, "LIVE_CURRENCY_NOT_ALLOWLISTED");
  // 7. Destination domain denied.
  rejectsGate({ args: { destinationUrl: "https://evil.example/landing" } }, "LIVE_DESTINATION_NOT_ALLOWLISTED");
  rejectsGate({ args: { destinationUrl: "http://test-destination.example/x" } }, "LIVE_DESTINATION_INVALID");
});

test("live gates refuse guarded test processes, CI, worker overlap, and demand operator identity", () => {
  // Running inside the offline test runner (network guard installed) is refused.
  assert.throws(
    () => evaluateLiveTestGates({ args: { ...GOOD_ARGS }, env: { ...GOOD_ENV }, mode: "validate", provider: "GOOGLE_ADS" }),
    (error) => error.code === "LIVE_TEST_FORBIDDEN_UNDER_TEST_NETWORK_GUARD",
  );
  rejectsGate({ env: { NODE_ENV: "test" } }, "LIVE_TEST_FORBIDDEN_IN_TEST_ENV");
  rejectsGate({ env: { CI: "true" } }, "LIVE_TEST_FORBIDDEN_IN_CI");
  rejectsGate({ env: { MARKETING_AD_EXECUTION_WORKER_ENABLED: "true" } }, "LIVE_WORKER_ISOLATION_REQUIRED");
  rejectsGate({ args: { operator: "" } }, "LIVE_OPERATOR_REQUIRED");
  rejectsGate({ args: { reason: "short" } }, "LIVE_REASON_REQUIRED");
  rejectsGate({ args: { resourcePrefix: "abc" } }, "LIVE_RESOURCE_PREFIX_REQUIRED");
  rejectsGate({ args: { resourcePrefix: "CF-LIVE-PROD" } }, "LIVE_RESOURCE_PREFIX_REQUIRED");
  rejectsGate({ args: { cleanup: "none" } }, "LIVE_CLEANUP_PLAN_REQUIRED");
  rejectsGate({ args: { outputDir: path.join("docs", "live") } }, "LIVE_OUTPUT_DIRECTORY_INVALID");
  rejectsGate({ provider: "ALL" }, "LIVE_PROVIDER_REQUIRED");
  rejectsGate({ mode: "everything" }, "LIVE_MODE_REQUIRED");
});

test("gate-approved config isolates execution flags and never enables the worker", () => {
  const readConfig = gates({ mode: "read" });
  assert.equal(readConfig.isolatedEnv.MARKETING_AD_EXECUTION_DRY_RUN, "true");
  assert.equal(readConfig.isolatedEnv.MARKETING_AD_EXECUTION_WORKER_ENABLED, "false");
  const validateOnly = gates();
  assert.equal(validateOnly.confirmWrite, false);
  assert.equal(validateOnly.isolatedEnv.MARKETING_AD_EXECUTION_DRY_RUN, "true");
  const write = gates({ args: { confirmWrite: REQUIRED_WRITE_CONFIRMATION_VALUE } });
  assert.equal(write.confirmWrite, true);
  assert.equal(write.isolatedEnv.MARKETING_AD_EXECUTION_DRY_RUN, "false");
  assert.equal(write.isolatedEnv.MARKETING_AD_EXECUTION_WORKER_ENABLED, "false");
  // 10. A wrong write confirmation value is rejected outright.
  rejectsGate({ args: { confirmWrite: "yes" } }, "LIVE_WRITE_CONFIRMATION_INVALID");
});

test("harness runs dry-run first and stops before writes without the human confirmation", async () => {
  // 9-10. Validate-only stage always precedes writes; without --confirm-write
  // the write phase never happens.
  const transport = createFakeLiveTransport();
  const config = gates();
  const { harness } = runHarness({ config, transport });
  const { exitCode, ledger } = await harness.run();
  assert.equal(exitCode, 0);
  assert.equal(ledger.finalStatus, "VALIDATE_ONLY_COMPLETED");
  assert.equal(transport.calls.validateOnly, 1);
  assert.equal(transport.calls.createPausedResources, 0);
  assert.equal(ledger.confirmationState.writePhaseConfirmed, false);
  assert.deepEqual(STAGES.slice(0, 3), ["PREFLIGHT_SAFETY", "READ_ONLY_CAPABILITY", "VALIDATE_ONLY"]);
});

test("harness read mode is read-only and a failed validate-only blocks the write phase", async () => {
  const readTransport = createFakeLiveTransport();
  const { harness: readHarness } = runHarness({ config: gates({ mode: "read" }), transport: readTransport });
  const readResult = await readHarness.run();
  assert.equal(readResult.ledger.finalStatus, "READ_ONLY_COMPLETED");
  assert.equal(readTransport.calls.validateOnly, 0);
  assert.equal(readTransport.calls.createPausedResources, 0);

  const failingTransport = createFakeLiveTransport({ validation: { valid: false } });
  const config = gates({ args: { confirmWrite: REQUIRED_WRITE_CONFIRMATION_VALUE } });
  const { harness } = runHarness({ config, transport: failingTransport });
  const { exitCode, ledger } = await harness.run();
  assert.equal(exitCode, 1);
  assert.equal(ledger.errors[0].code, "LIVE_VALIDATE_ONLY_FAILED");
  assert.equal(failingTransport.calls.createPausedResources, 0);
});

test("harness refuses non-sandbox connections and unconfigured transports before any write", async () => {
  const transport = createFakeLiveTransport();
  const config = gates({ args: { confirmWrite: REQUIRED_WRITE_CONFIRMATION_VALUE } });
  const { harness } = runHarness({ config, transport, connection: { platform: "GOOGLE_ADS", accountId: SANDBOX_ACCOUNT, testAccount: false } });
  const { exitCode, ledger } = await harness.run();
  assert.equal(exitCode, 1);
  assert.equal(ledger.errors[0].code, "LIVE_CONNECTION_NOT_SANDBOX");
  assert.equal(transport.calls.readAccount, 0);

  // A missing transport method fails closed before any provider interaction.
  const { harness: broken } = runHarness({ config, transport: {} });
  const brokenResult = await broken.run();
  assert.equal(brokenResult.exitCode, 1);
  assert.equal(brokenResult.ledger.errors[0].code, "LIVE_TRANSPORT_NOT_CONFIGURED");
});

test("harness full lifecycle keeps resources paused, records the ledger and verifies cleanup", async () => {
  // 11-13, 17. Full offline lifecycle with the fake live transport.
  const transport = createFakeLiveTransport();
  const config = gates({ args: { confirmWrite: REQUIRED_WRITE_CONFIRMATION_VALUE } });
  const files = new Map();
  const { harness } = runHarness({ config, transport, files });
  const { exitCode, ledger } = await harness.run();
  assert.equal(exitCode, 0);
  assert.equal(ledger.finalStatus, "COMPLETED_AND_CLEANED");
  assert.equal(ledger.createdResources.length, 2);
  assert.ok(ledger.createdResources.every((resource) => resource.initialStatus === "PAUSED"));
  assert.ok(ledger.createdResources.every((resource) => resource.readBackStatus === "PAUSED"));
  assert.ok(ledger.createdResources.every((resource) => resource.cleanupResult === "VERIFIED_SAFE"));
  assert.equal(ledger.cleanup.attempted, true);
  assert.equal(transport.calls.cleanupResource, 2);
  // Cleanup is verified through read-back, never assumed.
  assert.equal(transport.calls.readBackResource, 2 + 2);
  // Ledger persisted into the ignored artifacts directory.
  assert.equal(files.size, 1);
  const [target, content] = [...files.entries()][0];
  assert.ok(target.replace(/\\/g, "/").includes("artifacts/advertising-execution-live-validation"));
  const persisted = JSON.parse(content);
  assert.equal(persisted.provider, "GOOGLE_ADS");
  assert.equal(persisted.approvedBudgetMinor, "100");
  assert.ok(persisted.providerRequestIds.length >= 3);
});

test("harness forces paused creation and treats an active resource as a failure with cleanup", async () => {
  // 11. Created resources are forced paused.
  const transport = createFakeLiveTransport({
    resources: [{ resourceType: "CAMPAIGN", nativeResourceId: "campaign-active", status: "ACTIVE", providerRequestId: "fake-create-req-9" }],
  });
  const config = gates({ args: { confirmWrite: REQUIRED_WRITE_CONFIRMATION_VALUE } });
  const { harness } = runHarness({ config, transport });
  const { exitCode, ledger } = await harness.run();
  assert.equal(exitCode, 1);
  assert.equal(ledger.errors[0].code, "LIVE_RESOURCE_NOT_PAUSED");
  // No resource entered the ledger as created, so nothing is silently active.
  assert.equal(ledger.createdResources.length, 0);
});

test("harness always attempts cleanup after failure and incomplete cleanup exits non-zero", async () => {
  // 13-15. Cleanup after failure, and incomplete cleanup is loud.
  const transport = createFakeLiveTransport({ cleanupFails: true });
  const config = gates({ args: { confirmWrite: REQUIRED_WRITE_CONFIRMATION_VALUE } });
  const files = new Map();
  const { harness } = runHarness({ config, transport, files });
  const { exitCode, ledger } = await harness.run();
  assert.equal(exitCode, 1);
  assert.equal(ledger.finalStatus, "CLEANUP_INCOMPLETE");
  assert.equal(ledger.manualFollowUpRequired, true);
  assert.ok(ledger.createdResources.every((resource) => resource.finalStatus === "MANUAL_FOLLOW_UP_REQUIRED"));
  // The ledger is not erased on failure.
  assert.equal(files.size, 1);
});

test("ledger sanitization removes secrets, tokens, signed URLs and bounded-depth content", () => {
  // 12. The ledger can never persist credentials.
  const sanitized = sanitizeLedgerValue({
    liveTestRunId: "live-1",
    accessToken: "secret-value",
    authorizationHeader: "Bearer secret",
    credentialEnvelope: { cipher: "aes" },
    signedUrl: "https://signed.example/?sig=abc",
    apiKey: "key",
    nested: { refreshToken: "secret", safe: "keep-me" },
    note: "plain",
  });
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("signed.example"), false);
  assert.equal(sanitized.nested.safe, "keep-me");
  assert.equal(sanitized.note, "plain");
});

test("live scripts are excluded from CI, npm test, focused suites and hooks", () => {
  // 16. No default or CI path can reach the live commands.
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const liveScriptNames = Object.keys(packageJson.scripts).filter((name) => name.startsWith("live:"));
  assert.ok(liveScriptNames.length >= 10, "expected per-provider live:read and live:validate commands");
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (name.startsWith("live:")) {
      assert.match(command, /scripts\/advertising-execution\/live-validate\.js/);
      assert.doesNotMatch(command, /--test\b/);
      continue;
    }
    assert.doesNotMatch(command, /live-validate\.js/, `script ${name} must not invoke the advertising live harness`);
    if (name === "test" || name.startsWith("test:") || name.startsWith("social:") || name.startsWith("db:") || name.startsWith("security:") || name.startsWith("config:")) {
      assert.doesNotMatch(command, /\blive:/, `script ${name} must not chain live commands`);
    }
  }
  const workflowDir = path.join(__dirname, "..", "..", "..", ".github", "workflows");
  for (const workflow of fs.readdirSync(workflowDir)) {
    const content = fs.readFileSync(path.join(workflowDir, workflow), "utf8");
    assert.doesNotMatch(content, /live-validate\.js|live:validate|live:read/, `${workflow} must not run live validation`);
  }
  // The one command allowed to reference the harness is the explicit live entry itself.
  const entry = fs.readFileSync(path.join(__dirname, "..", "scripts", "advertising-execution", "live-validate.js"), "utf8");
  assert.match(entry, /LIVE_TRANSPORT_NOT_CONFIGURED/);
  assert.match(entry, /evaluateLiveTestGates/);
});

test("live provider status remains NOT_LIVE_VALIDATED until an explicit successful live run", () => {
  // 29.2 completion standard: the matrix stays NOT_LIVE_VALIDATED.
  const matrix = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docs", "advertising-execution-live-validation-matrix.md"), "utf8");
  assert.match(matrix, /NOT_LIVE_VALIDATED/);
  assert.doesNotMatch(matrix, /\|\s*LIVE_VALIDATED/);
  for (const provider of ["Google Ads", "Meta", "TikTok", "LinkedIn", "X"]) {
    assert.ok(matrix.includes(provider), `matrix must keep a row for ${provider}`);
  }
});
