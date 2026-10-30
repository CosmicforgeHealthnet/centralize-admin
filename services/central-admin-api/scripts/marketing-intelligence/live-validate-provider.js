#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { AD_PLATFORMS } = require("../../src/modules/marketing/intelligence/platforms");
const {
  assertUuid,
  sanitizeBoundedJson,
  sanitizePlainText,
  utcDateRange,
} = require("../../src/modules/marketing/intelligence/validation-security");
const { providerFailure } = require("../../src/modules/marketing/intelligence/observability");
const { isPhase2Enabled } = require("../../src/modules/marketing/intelligence/phase2-feature");

const DEFAULT_OUTPUT = path.resolve("docs/marketing-intelligence-phase2-live-validation-status.json");
const MAX_LIVE_RANGE_DAYS = 7;

class LiveValidationSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveValidationSafetyError";
    this.code = code;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = { confirmLive: false };
  for (const argument of argv) {
    if (argument === "--confirm-live") result.confirmLive = true;
    else if (argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      if (separator < 0) throw new LiveValidationSafetyError("INVALID_ARGUMENT", `Unsupported flag: ${argument}`);
      const key = argument.slice(2, separator).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      result[key] = argument.slice(separator + 1);
    } else throw new LiveValidationSafetyError("INVALID_ARGUMENT", "Positional arguments are not supported");
  }
  return result;
}

function validateInvocation({ args, env = process.env } = {}) {
  if (String(env.NODE_ENV || "").toLowerCase() === "test") {
    throw new LiveValidationSafetyError("LIVE_VALIDATION_FORBIDDEN_IN_TEST", "Live validation cannot run under NODE_ENV=test");
  }
  if (String(env.MARKETING_LIVE_VALIDATION_ENABLED || "").toLowerCase() !== "true") {
    throw new LiveValidationSafetyError("LIVE_VALIDATION_FLAG_REQUIRED", "MARKETING_LIVE_VALIDATION_ENABLED=true is required");
  }
  if (!args?.confirmLive) {
    throw new LiveValidationSafetyError("LIVE_CONFIRMATION_REQUIRED", "--confirm-live is required");
  }
  const platform = String(args.platform || "").trim().toUpperCase();
  if (!AD_PLATFORMS.includes(platform)) {
    throw new LiveValidationSafetyError("INVALID_PLATFORM", `--platform must be one of ${AD_PLATFORMS.join(", ")}`);
  }
  try { assertUuid(args.connectionId, "connectionId"); }
  catch (_error) { throw new LiveValidationSafetyError("INVALID_CONNECTION_ID", "--connection-id must be a UUID"); }
  const account = sanitizePlainText(args.account, 255);
  if (!account || account !== args.account?.trim()) {
    throw new LiveValidationSafetyError("INVALID_ACCOUNT", "--account must be a bounded plain identifier");
  }
  let range;
  try { range = utcDateRange(args.from, args.to, { maximumDays: MAX_LIVE_RANGE_DAYS }); }
  catch (_error) { throw new LiveValidationSafetyError("INVALID_DATE_RANGE", `--from and --to must be valid dates spanning no more than ${MAX_LIVE_RANGE_DAYS} days`); }
  const output = path.resolve(args.output || DEFAULT_OUTPUT);
  const docsRoot = path.resolve("docs") + path.sep;
  if (!output.startsWith(docsRoot) || path.extname(output).toLowerCase() !== ".json") {
    throw new LiveValidationSafetyError("INVALID_OUTPUT", "--output must be a JSON file inside docs/");
  }
  return { platform, connectionId: args.connectionId, account, from: args.from, to: args.to, range, output };
}

function stableIds(items = []) {
  return items.map((item) => String(item.sourceKey || item.creativeExternalId || item.adExternalId || "")).filter(Boolean).sort();
}

function sameIds(left, right) {
  return JSON.stringify(stableIds(left)) === JSON.stringify(stableIds(right));
}

function safeFailure(error) {
  const failure = providerFailure(error);
  return {
    code: sanitizePlainText(error?.code || "LIVE_VALIDATION_FAILED", 100),
    providerErrorCategory: failure.providerErrorCategory,
    retryable: failure.retryable,
  };
}

async function runLiveValidation(options, dependencies) {
  const startedAt = new Date().toISOString();
  const connection = await dependencies.loadConnection(options.connectionId);
  if (!connection) throw new LiveValidationSafetyError("CONNECTION_NOT_FOUND", "The selected connection does not exist");
  if (connection.platform !== options.platform) throw new LiveValidationSafetyError("CONNECTION_PLATFORM_MISMATCH", "The connection does not match --platform");
  if (String(connection.accountId) !== options.account) throw new LiveValidationSafetyError("CONNECTION_ACCOUNT_MISMATCH", "The connection does not match --account");
  if (connection.status !== "ACTIVE") throw new LiveValidationSafetyError("CONNECTION_INACTIVE", "The selected connection is not active");

  const connector = dependencies.getConnector(options.platform, connection);
  if (!connector) throw new LiveValidationSafetyError("CAPABILITY_UNAVAILABLE", "No creative validation connector is registered");

  const result = {
    status: "LIVE_VALIDATION_IN_PROGRESS",
    startedAt,
    completedAt: null,
    connectionTest: "NOT_RUN",
    boundedFetch: "NOT_RUN",
    pagination: "NOT_RUN",
    rateLimit: "CLASSIFIER_AVAILABLE_NOT_TRIGGERED",
    campaignReconciliation: "NOT_RUN_OPERATOR_REVIEW_REQUIRED",
    stableCreativeIds: "NOT_RUN",
    currency: connection.currency ? "CONFIGURED_PENDING_RECONCILIATION" : "NOT_CONFIGURED",
    microUnits: ["X", "GOOGLE_ADS"].includes(options.platform) ? "IMPLEMENTATION_PRESENT_LIVE_RECONCILIATION_REQUIRED" : "NOT_APPLICABLE",
    normalizedRows: { catalog: 0, insights: 0 },
    observationMode: "NOT_ENABLED",
    blockers: [],
  };

  try {
    const connectionTest = await dependencies.testConnection(options.connectionId, { since: options.from, until: options.to });
    result.connectionTest = connectionTest?.success ? "PASSED" : "FAILED";
    if (!connectionTest?.success) {
      result.status = connectionTest?.providerErrorCategory === "PERMISSION" ? "PROVIDER_APPROVAL_REQUIRED" : "LIVE_VALIDATION_FAILED";
      result.blockers.push({ code: connectionTest?.errorCategory || "CONNECTION_TEST_FAILED", retryable: Boolean(connectionTest?.retryable) });
      return result;
    }
    const args = { connection, since: options.from, until: options.to, cursor: null, limit: 25, onTokensRefreshed: async () => {} };
    const [catalog, insights, repeatCatalog] = await Promise.all([
      connector.fetchCreativeCatalog(args),
      connector.fetchCreativeInsights(args),
      connector.fetchCreativeCatalog(args),
    ]);
    result.boundedFetch = "PASSED";
    result.pagination = catalog.nextCursor || insights.nextCursor ? "CURSOR_OBSERVED" : "SINGLE_PAGE_NO_CURSOR";
    result.stableCreativeIds = sameIds(catalog.items, repeatCatalog.items) ? "PASSED" : "FAILED";
    result.normalizedRows = { catalog: catalog.items?.length || 0, insights: insights.rows?.length || 0 };
    result.completedAt = new Date().toISOString();
    result.status = result.stableCreativeIds === "PASSED" ? "LIVE_VALIDATION_IN_PROGRESS" : "LIVE_VALIDATION_FAILED";
    return result;
  } catch (error) {
    const failure = safeFailure(error);
    result.completedAt = new Date().toISOString();
    result.status = failure.providerErrorCategory === "PERMISSION" ? "PROVIDER_APPROVAL_REQUIRED" : failure.providerErrorCategory === "INVALID_REQUEST" ? "CREDENTIALS_REQUIRED" : "LIVE_VALIDATION_FAILED";
    result.blockers.push(failure);
    return result;
  }
}

function writeStatus(output, platform, result, env = process.env) {
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(output, "utf8")); } catch (_error) { previous = {}; }
  const document = sanitizeBoundedJson({
    generatedAt: new Date().toISOString(),
    phase2MasterEnabled: isPhase2Enabled(env),
    platforms: { ...(previous.platforms || {}), [platform]: result },
  }, { maxBytes: 128 * 1024, maxDepth: 8, maxFields: 100, maxArray: 100, maxString: 1000 });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

function humanSummary(platform, result, output) {
  return [
    `Marketing Intelligence live validation: ${platform}`,
    `Status: ${result.status}`,
    `Connection test: ${result.connectionTest}`,
    `Bounded fetch: ${result.boundedFetch}`,
    `Normalized catalog/insight rows: ${result.normalizedRows?.catalog || 0}/${result.normalizedRows?.insights || 0}`,
    `Sanitized result: ${path.relative(process.cwd(), output)}`,
  ].join("\n");
}

async function defaultDependencies() {
  const { prisma } = require("../../src/shared/config/database");
  const providerConnections = require("../../src/modules/marketing/intelligence/provider-connections.service");
  const { CREATIVE_REGISTRY } = require("../../src/modules/marketing/intelligence/creative/creative.registry");
  return {
    loadConnection: (id) => prisma.marketing_ad_platform_connections.findUnique({ where: { id } }),
    testConnection: providerConnections.testConnection,
    getConnector: (platform) => CREATIVE_REGISTRY[platform],
    disconnect: () => prisma.$disconnect(),
  };
}

async function main() {
  let dependencies;
  try {
    const options = validateInvocation({ args: parseArgs() });
    dependencies = await defaultDependencies();
    const result = await runLiveValidation(options, dependencies);
    writeStatus(options.output, options.platform, result);
    process.stdout.write(`${humanSummary(options.platform, result, options.output)}\n`);
    if (!["LIVE_VALIDATION_IN_PROGRESS", "LIVE_VALIDATION_PASSED"].includes(result.status)) process.exitCode = 2;
  } catch (error) {
    const safe = safeFailure(error);
    process.stderr.write(`Live validation stopped safely: ${safe.code}\n`);
    process.exitCode = 1;
  } finally {
    await dependencies?.disconnect?.().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_OUTPUT,
  MAX_LIVE_RANGE_DAYS,
  LiveValidationSafetyError,
  parseArgs,
  validateInvocation,
  stableIds,
  sameIds,
  runLiveValidation,
  writeStatus,
  humanSummary,
};
