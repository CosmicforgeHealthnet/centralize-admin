const logger = require("../../../../shared/utils/logger");
const {
  runPublishingWorkerOnce,
} = require("./publishing.worker");
const {
  runActionWorkerOnce,
} = require("./action.worker");
const {
  recoverExpiredLeases,
} = require("./lease.service");
const {
  createWorkerShutdownController,
} = require("./worker-shutdown.service");

function flagEnabled(name) {
  return String(process.env[name] || "false").toLowerCase() === "true";
}

function intFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function socialWorkerConfigFromEnv() {
  const allEnabled = flagEnabled("SOCIAL_WORKERS_ENABLED");
  return {
    workersEnabled: allEnabled,
    publishingEnabled: allEnabled && flagEnabled("SOCIAL_PUBLISHING_WORKER_ENABLED"),
    actionEnabled: allEnabled && flagEnabled("SOCIAL_ACTION_WORKER_ENABLED"),
    reconciliationEnabled: flagEnabled("SOCIAL_RECONCILIATION_ENABLED"),
    intervalMs: intFromEnv("SOCIAL_WORKER_POLL_INTERVAL_MS", 30_000),
    recoveryIntervalMs: intFromEnv("SOCIAL_WORKER_RECOVERY_INTERVAL_MS", 30_000),
    publishingBatchSize: intFromEnv("SOCIAL_PUBLISHING_WORKER_BATCH_SIZE", 5),
    actionBatchSize: intFromEnv("SOCIAL_ACTION_WORKER_BATCH_SIZE", 10),
    leaseDurationMs: intFromEnv("SOCIAL_WORKER_LEASE_DURATION_MS", 5 * 60 * 1000),
  };
}

function startLoop({ name, intervalMs, fn, shutdownController, log = logger }) {
  const run = () => {
    if (shutdownController.isStopping) return;
    shutdownController.track(
      fn().catch((error) => {
        log.error(`[SocialOperations] ${name} worker run failed: ${error.message}`);
      }),
    );
  };
  const interval = setInterval(run, intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  run();
  return () => clearInterval(interval);
}

function registerSocialWorkers({
  config = socialWorkerConfigFromEnv(),
  log = logger,
  publishingRunner = runPublishingWorkerOnce,
  actionRunner = runActionWorkerOnce,
  leaseRecovery = recoverExpiredLeases,
} = {}) {
  if (!config.workersEnabled) {
    log.info("[SocialOperations] Workers disabled (SOCIAL_WORKERS_ENABLED != true)");
    return {
      started: false,
      config,
      async shutdown() {
        return { stoppedClaiming: true, inFlightRemaining: 0 };
      },
    };
  }

  const shutdownController = createWorkerShutdownController();
  const stopFns = [];
  for (const queue of ["publishing", "action"]) {
    stopFns.push(
      startLoop({
        name: `${queue}-lease-recovery`,
        intervalMs: config.recoveryIntervalMs,
        fn: () => leaseRecovery({ queue }),
        shutdownController,
        log,
      }),
    );
  }

  if (config.publishingEnabled) {
    stopFns.push(
      startLoop({
        name: "publishing",
        intervalMs: config.intervalMs,
        fn: () =>
          publishingRunner({
            batchSize: config.publishingBatchSize,
            leaseDurationMs: config.leaseDurationMs,
          }),
        shutdownController,
        log,
      }),
    );
  } else {
    log.info("[SocialOperations] Publishing worker disabled");
  }

  if (config.actionEnabled) {
    stopFns.push(
      startLoop({
        name: "action",
        intervalMs: config.intervalMs,
        fn: () =>
          actionRunner({
            batchSize: config.actionBatchSize,
            leaseDurationMs: config.leaseDurationMs,
          }),
        shutdownController,
        log,
      }),
    );
  } else {
    log.info("[SocialOperations] Action worker disabled");
  }

  return {
    started: stopFns.length > 0,
    config,
    async shutdown() {
      for (const stop of stopFns) stop();
      return shutdownController.shutdown();
    },
  };
}

module.exports = {
  flagEnabled,
  socialWorkerConfigFromEnv,
  registerSocialWorkers,
};
