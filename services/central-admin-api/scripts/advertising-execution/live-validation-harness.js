"use strict";

// Section 29.2 live-validation stage machine.
//
// Runs the provider-specific live stages in a fixed order and fails closed at
// every step. The harness itself never constructs a network client: the
// caller injects `transport` (and offline tests inject fakes), so importing or
// unit-testing this module can never reach a live provider. Cleanup always
// runs in a finally path and is verified by read-back before it is reported
// as complete.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { LiveTestSafetyError } = require("./live-validation-gates");

const STAGES = Object.freeze([
  "PREFLIGHT_SAFETY",
  "READ_ONLY_CAPABILITY",
  "VALIDATE_ONLY",
  "WRITE_CONFIRMATION",
  "PAUSED_CREATE",
  "READ_BACK_VERIFICATION",
  "LEDGER_WRITE",
  "CLEANUP",
  "CLEANUP_VERIFICATION",
  "FINAL_REPORT",
]);

const SECRET_KEY_PATTERN = /token|secret|password|authorization|credential|cookie|signature|signedurl|api[-_]?key/i;

function sanitizeLedgerValue(value, depth = 0) {
  if (depth > 8) return "[depth-bounded]";
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return typeof value === "string" ? value.slice(0, 2000) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeLedgerValue(entry, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
      .slice(0, 100)
      .map(([key, child]) => [key, sanitizeLedgerValue(child, depth + 1)]));
  }
  return null;
}

function requireTransportMethod(transport, method) {
  if (typeof transport?.[method] !== "function") {
    throw new LiveTestSafetyError("LIVE_TRANSPORT_NOT_CONFIGURED", `The live transport does not implement ${method}(); refusing to continue`);
  }
}

// dependencies:
//   transport            provider transport with readAccount, validateOnly,
//                        createPausedResources, readBackResource, cleanupResource
//   loadConnection       async (connectionId) => sanitized connection record
//   confirmWritePhase    async () => boolean — the human checkpoint before writes
//   now                  clock injection
//   writeFile / mkdir    filesystem injection for ledger tests
function createLiveValidationHarness({ config, dependencies, logger = console } = {}) {
  if (!config) throw new LiveTestSafetyError("LIVE_CONFIG_REQUIRED", "Gate-approved configuration is required");
  const {
    transport,
    loadConnection,
    confirmWritePhase,
    now = () => new Date(),
    writeFile = fs.writeFileSync,
    mkdir = (target) => fs.mkdirSync(target, { recursive: true }),
  } = dependencies || {};

  const runId = `live-${config.provider.toLowerCase()}-${now().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  const ledger = {
    liveTestRunId: runId,
    provider: config.provider,
    apiVersion: null,
    mode: config.mode,
    connectionReference: `connection:${config.connectionId.slice(0, 8)}…`,
    accountReference: config.accountExternalId,
    operator: config.operator,
    reason: config.reason,
    ticket: config.ticket || null,
    startedAt: null,
    completedAt: null,
    confirmationState: { environmentConfirmed: true, writePhaseConfirmed: false },
    approvedBudgetMinor: config.maximumBudgetMinor,
    requestedBudgetMinor: config.requestedBudgetMinor,
    currency: config.currency,
    resourcePrefix: config.resourcePrefix,
    stages: {},
    createdResources: [],
    providerRequestIds: [],
    errors: [],
    cleanup: { attempted: false, mode: config.cleanupMode, results: [] },
    manualFollowUpRequired: false,
    finalStatus: "NOT_STARTED",
  };

  function stage(name, status, detail = null) {
    ledger.stages[name] = { status, detail: detail ? sanitizeLedgerValue(detail) : null, at: now().toISOString() };
  }

  function persistLedger() {
    mkdir(config.outputDirectory);
    const target = path.join(config.outputDirectory, `${runId}.json`);
    writeFile(target, `${JSON.stringify(sanitizeLedgerValue(ledger), null, 2)}\n`, "utf8");
    return target;
  }

  async function run() {
    ledger.startedAt = now().toISOString();
    ledger.finalStatus = "IN_PROGRESS";
    // The finally block mutates this shared outcome so cleanup or ledger
    // failures always surface in the returned exit code.
    const outcome = { exitCode: 0, ledger, runId };
    try {
      // 1. Preflight safety: connection must really be the dedicated sandbox.
      requireTransportMethod(transport, "readAccount");
      if (typeof loadConnection !== "function") {
        throw new LiveTestSafetyError("LIVE_CONNECTION_RESOLVER_REQUIRED", "A connection resolver is required");
      }
      const connection = await loadConnection(config.connectionId);
      if (!connection || connection.platform !== config.provider) {
        throw new LiveTestSafetyError("LIVE_CONNECTION_MISMATCH", "The connection does not exist or does not match the provider");
      }
      if (String(connection.accountId) !== config.accountExternalId) {
        throw new LiveTestSafetyError("LIVE_CONNECTION_ACCOUNT_MISMATCH", "The connection account does not match --account");
      }
      if (connection.testAccount !== true && connection.sandbox !== true) {
        throw new LiveTestSafetyError("LIVE_CONNECTION_NOT_SANDBOX", "The connection is not marked as a dedicated test/sandbox connection");
      }
      stage("PREFLIGHT_SAFETY", "PASSED", { connectionReference: ledger.connectionReference });

      // 2. Read-only account capability.
      const account = await transport.readAccount({ accountExternalId: config.accountExternalId });
      ledger.apiVersion = account?.apiVersion || null;
      if (account?.providerRequestId) ledger.providerRequestIds.push(String(account.providerRequestId).slice(0, 255));
      if (!account?.accessible) {
        throw new LiveTestSafetyError("LIVE_ACCOUNT_NOT_ACCESSIBLE", "The dedicated test account is not accessible with the configured access");
      }
      stage("READ_ONLY_CAPABILITY", "PASSED", { apiVersion: ledger.apiVersion, capabilities: account.capabilities || null });
      if (config.mode === "read") {
        stage("FINAL_REPORT", "PASSED", { note: "Read-only run: no validate-only or write stages executed" });
        ledger.finalStatus = "READ_ONLY_COMPLETED";
        return outcome;
      }

      // 3. Validate-only / dry-run before any write.
      requireTransportMethod(transport, "validateOnly");
      const validation = await transport.validateOnly({
        accountExternalId: config.accountExternalId,
        resourcePrefix: config.resourcePrefix,
        currency: config.currency,
        budgetMinor: config.requestedBudgetMinor,
        destinationHost: config.destinationHost,
      });
      if (validation?.providerRequestId) ledger.providerRequestIds.push(String(validation.providerRequestId).slice(0, 255));
      if (validation?.valid !== true) {
        throw new LiveTestSafetyError("LIVE_VALIDATE_ONLY_FAILED", "Validate-only/dry-run stage failed; no write will be attempted");
      }
      stage("VALIDATE_ONLY", "PASSED", { warnings: validation.warnings || [] });

      // 4. Human confirmation checkpoint before the provider write phase.
      const humanConfirmed = config.confirmWrite === true && (typeof confirmWritePhase !== "function" || await confirmWritePhase() === true);
      ledger.confirmationState.writePhaseConfirmed = humanConfirmed;
      if (!humanConfirmed) {
        stage("WRITE_CONFIRMATION", "NOT_CONFIRMED", { note: "Write phase skipped: no explicit --confirm-write human confirmation" });
        stage("FINAL_REPORT", "PASSED", { note: "Validate-only run completed without provider writes" });
        ledger.finalStatus = "VALIDATE_ONLY_COMPLETED";
        return outcome;
      }
      stage("WRITE_CONFIRMATION", "CONFIRMED");

      // 5. Paused-resource creation.
      requireTransportMethod(transport, "createPausedResources");
      requireTransportMethod(transport, "readBackResource");
      requireTransportMethod(transport, "cleanupResource");
      const created = await transport.createPausedResources({
        accountExternalId: config.accountExternalId,
        resourcePrefix: config.resourcePrefix,
        currency: config.currency,
        budgetMinor: config.requestedBudgetMinor,
        destinationHost: config.destinationHost,
      });
      for (const resource of created?.resources || []) {
        if (String(resource.status || "").toUpperCase() !== "PAUSED") {
          throw new LiveTestSafetyError("LIVE_RESOURCE_NOT_PAUSED", `Created ${resource.resourceType} ${resource.nativeResourceId} is not paused`);
        }
        ledger.createdResources.push({
          resourceType: resource.resourceType,
          nativeResourceId: String(resource.nativeResourceId),
          parentNativeResourceId: resource.parentNativeResourceId || null,
          initialStatus: "PAUSED",
          readBackStatus: null,
          cleanupAction: null,
          cleanupResult: null,
          finalStatus: "CREATED_PAUSED",
        });
        if (resource.providerRequestId) ledger.providerRequestIds.push(String(resource.providerRequestId).slice(0, 255));
      }
      stage("PAUSED_CREATE", "PASSED", { createdCount: ledger.createdResources.length });

      // 6. Immediate read-back verification.
      for (const resource of ledger.createdResources) {
        const readBack = await transport.readBackResource({ nativeResourceId: resource.nativeResourceId, resourceType: resource.resourceType });
        resource.readBackStatus = String(readBack?.status || "UNKNOWN").toUpperCase();
        if (resource.readBackStatus !== "PAUSED") {
          throw new LiveTestSafetyError("LIVE_READ_BACK_NOT_PAUSED", `Read-back of ${resource.nativeResourceId} returned ${resource.readBackStatus}`);
        }
      }
      stage("READ_BACK_VERIFICATION", "PASSED", { verifiedCount: ledger.createdResources.length });
      ledger.finalStatus = "WRITE_VERIFIED";
      return outcome;
    } catch (error) {
      outcome.exitCode = error?.exitCode || 1;
      ledger.errors.push({ code: error?.code || "LIVE_TEST_FAILED", message: String(error?.message || error).slice(0, 500) });
      ledger.finalStatus = ledger.finalStatus === "IN_PROGRESS" ? "FAILED" : ledger.finalStatus;
      return outcome;
    } finally {
      // 7-9. Cleanup is always attempted for every created resource, verified
      // by read-back, and the ledger is durably written before exit.
      if (ledger.createdResources.length) {
        ledger.cleanup.attempted = true;
        for (const resource of ledger.createdResources) {
          try {
            const cleanup = await transport.cleanupResource({ nativeResourceId: resource.nativeResourceId, resourceType: resource.resourceType, mode: config.cleanupMode });
            resource.cleanupAction = cleanup?.action || config.cleanupMode.toUpperCase();
            const verified = await transport.readBackResource({ nativeResourceId: resource.nativeResourceId, resourceType: resource.resourceType });
            const verifiedStatus = String(verified?.status || "UNKNOWN").toUpperCase();
            const safe = ["PAUSED", "ARCHIVED", "REMOVED", "DELETED", "DISABLED"].includes(verifiedStatus);
            resource.cleanupResult = safe ? "VERIFIED_SAFE" : "UNVERIFIED";
            resource.finalStatus = safe ? verifiedStatus : "MANUAL_FOLLOW_UP_REQUIRED";
            if (!safe) ledger.manualFollowUpRequired = true;
            ledger.cleanup.results.push({ nativeResourceId: resource.nativeResourceId, action: resource.cleanupAction, result: resource.cleanupResult, verifiedStatus });
          } catch (cleanupError) {
            resource.cleanupResult = "FAILED";
            resource.finalStatus = "MANUAL_FOLLOW_UP_REQUIRED";
            ledger.manualFollowUpRequired = true;
            ledger.cleanup.results.push({ nativeResourceId: resource.nativeResourceId, action: config.cleanupMode.toUpperCase(), result: "FAILED", error: String(cleanupError?.message || cleanupError).slice(0, 300) });
          }
        }
        const incomplete = ledger.cleanup.results.filter((entry) => entry.result !== "VERIFIED_SAFE");
        stage("CLEANUP", incomplete.length ? "INCOMPLETE" : "PASSED", { results: ledger.cleanup.results.length });
        stage("CLEANUP_VERIFICATION", incomplete.length ? "MANUAL_FOLLOW_UP_REQUIRED" : "PASSED");
        if (incomplete.length) {
          outcome.exitCode = outcome.exitCode || 1;
          ledger.finalStatus = "CLEANUP_INCOMPLETE";
          logger.error(`[live-validation] cleanup incomplete; provider resources remain paused: ${incomplete.map((entry) => entry.nativeResourceId).join(", ")}`);
        } else if (ledger.finalStatus === "WRITE_VERIFIED") {
          ledger.finalStatus = "COMPLETED_AND_CLEANED";
        }
      }
      ledger.completedAt = now().toISOString();
      stage("LEDGER_WRITE", "PASSED");
      stage("FINAL_REPORT", ledger.errors.length ? "FAILED" : ledger.stages.FINAL_REPORT?.status || "PASSED");
      try {
        const target = persistLedger();
        logger.log(`[live-validation] run=${runId} status=${ledger.finalStatus} ledger=${target}`);
      } catch (ledgerError) {
        outcome.exitCode = outcome.exitCode || 1;
        logger.error(`[live-validation] LEDGER_WRITE_FAILED: ${String(ledgerError?.message || ledgerError).slice(0, 300)}`);
      }
    }
  }

  return Object.freeze({ run, runId, ledger });
}

module.exports = { STAGES, SECRET_KEY_PATTERN, sanitizeLedgerValue, createLiveValidationHarness };
