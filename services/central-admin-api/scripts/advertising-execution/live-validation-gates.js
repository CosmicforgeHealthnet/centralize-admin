"use strict";

// Section 29.2 live-test safety gates.
//
// Every advertising-execution live command must pass through
// evaluateLiveTestGates BEFORE any provider transport is constructed. A single
// missing condition throws LiveTestSafetyError: the caller must exit non-zero,
// make zero provider calls and decrypt no credentials. These gates are pure
// (no I/O) so they are fully testable offline.

const path = require("node:path");
const { Prisma } = require("../../src/generated/admin-client");

const LIVE_PROVIDERS = Object.freeze(["GOOGLE_ADS", "META", "TIKTOK", "LINKEDIN", "X"]);
const LIVE_MODES = Object.freeze(["read", "validate"]);
const REQUIRED_CONFIRMATION_VALUE = "I_UNDERSTAND_THIS_CREATES_PAUSED_PROVIDER_OBJECTS";
const REQUIRED_WRITE_CONFIRMATION_VALUE = "YES_CREATE_PAUSED_OBJECTS";
const DEFAULT_OUTPUT_DIRECTORY = path.join("artifacts", "advertising-execution-live-validation");
const CLEANUP_MODES = Object.freeze(["pause", "archive", "delete-if-supported"]);
const NETWORK_GUARD_SYMBOL = Symbol.for("cosmicforge.testNetworkGuard");

class LiveTestSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveTestSafetyError";
    this.code = code;
    this.exitCode = 1;
  }
}

function fail(code, message) {
  throw new LiveTestSafetyError(code, message);
}

function csvAllowlist(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function boundedText(value, maximum) {
  const text = String(value || "").trim();
  return text && text.length <= maximum && !/[\r\n\0]/.test(text) ? text : null;
}

function parseArgs(argv = []) {
  const result = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) fail("INVALID_ARGUMENT", "Positional arguments are not supported");
    const separator = argument.indexOf("=");
    if (separator < 0) {
      result[argument.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = true;
      continue;
    }
    const key = argument.slice(2, separator).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    result[key] = argument.slice(separator + 1);
  }
  return result;
}

// Evaluates every Section 29.2 gate. Returns a frozen, sanitized configuration
// or throws LiveTestSafetyError on the first unmet condition.
function evaluateLiveTestGates({ args = {}, env = process.env, mode, provider, globalScope = globalThis } = {}) {
  // The offline test runner installs the network guard; live commands must
  // never run inside that process.
  if (globalScope[NETWORK_GUARD_SYMBOL]?.installed) {
    fail("LIVE_TEST_FORBIDDEN_UNDER_TEST_NETWORK_GUARD", "Live validation cannot run inside a guarded test process");
  }
  if (String(env.NODE_ENV || "").toLowerCase() === "test") {
    fail("LIVE_TEST_FORBIDDEN_IN_TEST_ENV", "Live validation cannot run under NODE_ENV=test");
  }
  if (String(env.CI || "").toLowerCase() === "true") {
    fail("LIVE_TEST_FORBIDDEN_IN_CI", "Live validation cannot run in CI");
  }

  // 1-2: explicit command with explicit provider selection.
  if (!LIVE_MODES.includes(mode)) fail("LIVE_MODE_REQUIRED", "An explicit live mode (read or validate) is required");
  const selectedProvider = String(provider || args.provider || "").trim().toUpperCase();
  if (!LIVE_PROVIDERS.includes(selectedProvider)) {
    fail("LIVE_PROVIDER_REQUIRED", `--provider must be one of ${LIVE_PROVIDERS.join(", ")}`);
  }

  // 5-6: explicit double confirmation from the environment.
  if (String(env.MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMED || "") !== "true") {
    fail("LIVE_CONFIRMATION_FLAG_REQUIRED", "MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMED=true is required");
  }
  if (String(env.MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMATION || "") !== REQUIRED_CONFIRMATION_VALUE) {
    fail("LIVE_CONFIRMATION_VALUE_REQUIRED", `MARKETING_AD_EXECUTION_LIVE_TEST_CONFIRMATION must equal ${REQUIRED_CONFIRMATION_VALUE}`);
  }

  // 7-8: execution stays disabled in the ambient application environment; the
  // live process builds an isolated environment instead of flipping the app's.
  if (String(env.MARKETING_AD_EXECUTION_WORKER_ENABLED || "false") === "true") {
    fail("LIVE_WORKER_ISOLATION_REQUIRED", "The application execution worker must remain disabled while live tests run");
  }

  // 3: explicit dedicated sandbox/test connection.
  const connectionId = boundedText(args.connectionId, 64);
  if (!connectionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) {
    fail("LIVE_SANDBOX_CONNECTION_REQUIRED", "--connection-id must reference the dedicated sandbox/test connection (UUID)");
  }

  // 4, 12: explicit account allowlist and membership.
  const accountAllowlist = csvAllowlist(env.MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_ALLOWLIST);
  if (!accountAllowlist.length) {
    fail("LIVE_ACCOUNT_ALLOWLIST_REQUIRED", "MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_ALLOWLIST must list the dedicated test accounts");
  }
  const accountExternalId = boundedText(args.account, 255);
  if (!accountExternalId || !accountAllowlist.includes(accountExternalId)) {
    fail("LIVE_ACCOUNT_NOT_ALLOWLISTED", "--account must exactly match an entry in the live-test account allowlist");
  }

  // 13: production denylist always wins over the allowlist.
  const accountDenylist = csvAllowlist(env.MARKETING_AD_EXECUTION_LIVE_TEST_ACCOUNT_DENYLIST);
  if (accountDenylist.includes(accountExternalId)) {
    fail("LIVE_ACCOUNT_DENYLISTED", "--account is denylisted as a production account");
  }

  // 14: hard budget cap parsed with Decimal, zero-spend preferred.
  const rawCap = String(env.MARKETING_AD_EXECUTION_LIVE_TEST_MAX_BUDGET_MINOR || "").trim();
  if (!/^\d+$/.test(rawCap)) {
    fail("LIVE_BUDGET_CAP_REQUIRED", "MARKETING_AD_EXECUTION_LIVE_TEST_MAX_BUDGET_MINOR must be a non-negative integer of minor units");
  }
  const maximumBudgetMinor = new Prisma.Decimal(rawCap);
  const rawBudget = String(args.budgetMinor ?? "0").trim();
  if (!/^\d+$/.test(rawBudget)) fail("LIVE_BUDGET_INVALID", "--budget-minor must be a non-negative integer of minor units");
  const requestedBudgetMinor = new Prisma.Decimal(rawBudget);
  if (requestedBudgetMinor.greaterThan(maximumBudgetMinor)) {
    fail("LIVE_BUDGET_ABOVE_CAP", "--budget-minor exceeds MARKETING_AD_EXECUTION_LIVE_TEST_MAX_BUDGET_MINOR");
  }

  // 15: currency allowlist.
  const currencyAllowlist = csvAllowlist(env.MARKETING_AD_EXECUTION_LIVE_TEST_CURRENCY).map((entry) => entry.toUpperCase());
  const currency = String(args.currency || "").trim().toUpperCase();
  if (!currencyAllowlist.length || !/^[A-Z]{3}$/.test(currency) || !currencyAllowlist.includes(currency)) {
    fail("LIVE_CURRENCY_NOT_ALLOWLISTED", "--currency must match MARKETING_AD_EXECUTION_LIVE_TEST_CURRENCY");
  }

  // Destination domain allowlist for any creative destination.
  const destinationAllowlist = csvAllowlist(env.MARKETING_AD_EXECUTION_LIVE_TEST_DESTINATION_ALLOWLIST).map((entry) => entry.toLowerCase());
  const destinationUrl = boundedText(args.destinationUrl, 2000);
  let destinationHost = null;
  if (mode === "validate") {
    if (!destinationAllowlist.length) fail("LIVE_DESTINATION_ALLOWLIST_REQUIRED", "MARKETING_AD_EXECUTION_LIVE_TEST_DESTINATION_ALLOWLIST is required for write validation");
    try {
      const parsed = new URL(destinationUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe");
      destinationHost = parsed.hostname.toLowerCase();
    } catch {
      fail("LIVE_DESTINATION_INVALID", "--destination-url must be a plain https URL");
    }
    if (!destinationAllowlist.includes(destinationHost)) {
      fail("LIVE_DESTINATION_NOT_ALLOWLISTED", "--destination-url host is not in the approved test destination allowlist");
    }
  }

  // 16: deterministic resource prefix proving test ownership.
  const resourcePrefix = boundedText(args.resourcePrefix, 30);
  if (!resourcePrefix || !/^[A-Z0-9][A-Z0-9-]{3,29}$/.test(resourcePrefix) || !resourcePrefix.includes("TEST")) {
    fail("LIVE_RESOURCE_PREFIX_REQUIRED", "--resource-prefix must be an upper-case identifier containing TEST");
  }

  // 17: explicit cleanup plan.
  const cleanupMode = String(args.cleanup || "").trim().toLowerCase();
  if (!CLEANUP_MODES.includes(cleanupMode)) {
    fail("LIVE_CLEANUP_PLAN_REQUIRED", `--cleanup must be one of ${CLEANUP_MODES.join(", ")}`);
  }

  // 18-19: operator identity and reason/ticket.
  const operator = boundedText(args.operator, 255);
  if (!operator) fail("LIVE_OPERATOR_REQUIRED", "--operator is required");
  const reason = boundedText(args.reason, 2000);
  if (!reason || reason.length < 10) fail("LIVE_REASON_REQUIRED", "--reason (>= 10 characters, e.g. a change ticket) is required");

  // 20: created-resource ledger directory inside the ignored artifacts root.
  const outputDirectory = path.resolve(String(args.outputDir || DEFAULT_OUTPUT_DIRECTORY));
  const artifactsRoot = path.resolve("artifacts") + path.sep;
  if (!(outputDirectory + path.sep).startsWith(artifactsRoot)) {
    fail("LIVE_OUTPUT_DIRECTORY_INVALID", "--output-dir must stay inside the ignored artifacts/ directory");
  }

  // 10: the paused write phase needs its own explicit human confirmation.
  const confirmWrite = String(args.confirmWrite || "") === REQUIRED_WRITE_CONFIRMATION_VALUE;
  if (mode === "validate" && args.confirmWrite && !confirmWrite) {
    fail("LIVE_WRITE_CONFIRMATION_INVALID", `--confirm-write must equal ${REQUIRED_WRITE_CONFIRMATION_VALUE}`);
  }

  return Object.freeze({
    mode,
    provider: selectedProvider,
    connectionId,
    accountExternalId,
    accountAllowlist,
    currency,
    maximumBudgetMinor: maximumBudgetMinor.toFixed(0),
    requestedBudgetMinor: requestedBudgetMinor.toFixed(0),
    destinationHost,
    destinationAllowlist,
    resourcePrefix,
    cleanupMode,
    operator,
    reason,
    ticket: boundedText(args.ticket, 255),
    outputDirectory,
    confirmWrite,
    // 7: the only place execution flags may be true is this isolated env, which
    // is handed to the live-only composition and never exported to the app.
    isolatedEnv: Object.freeze({
      MARKETING_AD_EXECUTION_ENABLED: "true",
      MARKETING_AD_EXECUTION_DRY_RUN: mode === "validate" && confirmWrite ? "false" : "true",
      MARKETING_AD_EXECUTION_WORKER_ENABLED: "false",
      [`MARKETING_AD_EXECUTION_${selectedProvider}_ENABLED`]: "true",
      [`MARKETING_AD_EXECUTION_${selectedProvider}_API_VERSION`]: String(env[`MARKETING_AD_EXECUTION_${selectedProvider}_API_VERSION`] || "").trim(),
    }),
  });
}

module.exports = {
  LIVE_PROVIDERS,
  LIVE_MODES,
  REQUIRED_CONFIRMATION_VALUE,
  REQUIRED_WRITE_CONFIRMATION_VALUE,
  DEFAULT_OUTPUT_DIRECTORY,
  CLEANUP_MODES,
  LiveTestSafetyError,
  parseArgs,
  evaluateLiveTestGates,
};
