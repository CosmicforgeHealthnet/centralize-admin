const logger = require("../../../../shared/utils/logger");

const { EVENTS, logEvent } = require("../observability");
const { sanitizePlainText } = require("../validation-security");

// Scheduled synchronization registration.
//
// AUDIT NOTE: the repository has no existing cron scheduler, queue, or job
// runner, so node-cron is used (the minimal permitted addition). Registration
// happens once from the server bootstrap (src/server.js) and is disabled by
// default and always disabled under NODE_ENV=test.

const DEFAULT_CRON = "0 */6 * * *";
const DEFAULT_LOOKBACK_DAYS = 3;
const DEFAULT_INITIAL_LOOKBACK_DAYS = 30;

let registeredTask = null;

function syncEnabled() {
  return String(process.env.MARKETING_INTELLIGENCE_SYNC_ENABLED).toLowerCase() === "true";
}

function positiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

// Regular runs look back a few days to catch delayed provider adjustments;
// the very first run (no snapshots yet) uses the initial historical window.
async function computeSyncRange({ prisma }) {
  const lookbackDays = positiveIntEnv(
    "MARKETING_INTELLIGENCE_LOOKBACK_DAYS",
    DEFAULT_LOOKBACK_DAYS,
  );
  const initialLookbackDays = positiveIntEnv(
    "MARKETING_INTELLIGENCE_INITIAL_LOOKBACK_DAYS",
    DEFAULT_INITIAL_LOOKBACK_DAYS,
  );

  const snapshotCount = await prisma.marketing_performance_snapshots.count();
  const days = snapshotCount === 0 ? initialLookbackDays : lookbackDays;

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

  return { since: toDateString(since), until: toDateString(until) };
}

// Register the cron job. Idempotent  repeated calls in the same process
// never create a second schedule. Returns the task or null when not started.
function registerMarketingIntelligenceCron({
  cronLib,
  aggregationService,
  prisma,
  force = false,
} = {}) {
  if (registeredTask) {
    logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "REGISTER", status: "DUPLICATE_SKIPPED" }, { log: logger, level: "warn" });
    return registeredTask;
  }

  if (process.env.NODE_ENV === "test" && !force) {
    return null;
  }

  if (!syncEnabled()) {
    logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "REGISTER", status: "DISABLED" }, { log: logger });
    return null;
  }

  // Lazy requires keep test runs free of side effects unless injected.
  const cron = cronLib || require("node-cron");
  const service = aggregationService || require("./aggregation.service");
  const db = prisma || require("../../../../shared/config/database").prisma;

  const expression = process.env.MARKETING_INTELLIGENCE_CRON || DEFAULT_CRON;
  if (!cron.validate(expression)) {
    logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "REGISTER", status: "INVALID_CONFIGURATION", expression: sanitizePlainText(expression, 100) }, { log: logger, level: "error" });
    return null;
  }

  const timezone = process.env.MARKETING_INTELLIGENCE_SYNC_TIMEZONE || "UTC";

  registeredTask = cron.schedule(
    expression,
    async () => {
      try {
        logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "RUN", status: "STARTED" }, { log: logger });
        const range = await computeSyncRange({ prisma: db });
        const result = await service.syncMarketingInsights({
          ...range,
          trigger: "cron",
        });

        if (result.skipped) {
          logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "RUN", status: "SKIPPED_LOCKED", runId: result.runId || null }, { log: logger });
        } else {
          logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "RUN", status: result.status || "SUCCEEDED", runId: result.runId || null }, { log: logger });
        }
      } catch (error) {
        // A provider failure must never terminate the Node process.
        logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "RUN", status: "FAILED", errorCode: sanitizePlainText(error.code || "SYNC_FAILED", 100) }, { log: logger, level: "error" });
      }
    },
    { timezone },
  );

  logEvent(EVENTS.SCHEDULER_STATUS, { scheduler: "SYNC", operation: "REGISTER", status: "REGISTERED", expression, timezone }, { log: logger });

  return registeredTask;
}

// Test-only helper so the idempotency guard can be reset between test cases.
function resetForTests() {
  if (registeredTask && typeof registeredTask.stop === "function") {
    registeredTask.stop();
  }
  registeredTask = null;
}

module.exports = {
  registerMarketingIntelligenceCron,
  computeSyncRange,
  resetForTests,
};
