"use strict";

// CosmicForge Mail worker process. Start separately (one replica per queue
// set) with `npm run mail:worker`; it is never registered inside API replicas.
// Depends only on the Admin database (not on the HealthNet Main DB).

require("dotenv").config();
const logger = require("./shared/utils/logger");
const { loadMailConfig, publicStatus } = require("./modules/mail/mail.config");

// Idle without processing (Mail off, or the worker explicitly shut down).
// The process stays up instead of exiting 0, so a container supervisor with
// `restart: unless-stopped` never restart-loops and a deploy check can never
// mistake a clean exit for a healthy worker. With Mail enabled the idle
// worker records a DISABLED heartbeat so the shutdown is visible.
function idle({ reason, config, heartbeat = null, setTimer = setInterval, on = (event, handler) => process.on(event, handler), exit = (code) => process.exit(code) }) {
  logger.info(`[MailWorker] idle: ${reason}; not processing any queue (state ${heartbeat ? "DISABLED" : "MAIL_DISABLED"})`);
  const beat = () => (heartbeat ? heartbeat.beat({ state: "DISABLED", activeQueues: [], pausedQueues: [], metrics: null }, { force: true }).catch(() => false) : null);
  beat();
  const timer = setTimer(() => {
    logger.info(`[MailWorker] idle: ${reason}`);
    beat();
  }, Math.max(60000, (config.worker.heartbeatIntervalSeconds || 30) * 1000));
  const stop = (signal) => {
    clearInterval(timer);
    logger.info(`[MailWorker] ${signal} received while idle; exiting`);
    exit(0);
  };
  on("SIGTERM", () => stop("SIGTERM"));
  on("SIGINT", () => stop("SIGINT"));
  return { idle: true, timer };
}

async function main() {
  const config = loadMailConfig(process.env);
  if (!config.enabled) {
    idle({ reason: "MAIL_ENABLED is not true", config });
    return null;
  }
  const { prisma, connectDatabase } = require("./shared/config/database");
  await connectDatabase();
  if (!config.workerEnabled) {
    const { createWorkerHeartbeat } = require("./modules/mail/jobs/worker-heartbeat");
    idle({ reason: "MAIL_WORKER_ENABLED=false (explicit shutdown)", config, heartbeat: createWorkerHeartbeat({ client: prisma, config, queues: config.workerQueues, logger }) });
    return null;
  }
  const { createMailApplication } = require("./modules/mail/application");
  const mail = createMailApplication({ client: prisma, config, logger });
  // With MAIL_KMS_PROVIDER=aws-kms or file the keyring is loaded asynchronously;
  // wait for it so the first jobs do not fail closed needlessly.
  await mail.ready();
  if (!mail.storage.available) logger.warn("[MailWorker] Private storage is unavailable; inbound/outbound jobs will retry until configured.");
  // MAIL_WORKER_QUEUES selects the queues this process serves (default
  // outbound,inbound,events). MARKETING (broadcasts, automation) is opt-in;
  // run it as its own single replica.
  const queues = config.workerQueues;
  if (!queues.length) {
    idle({ reason: "MAIL_WORKER_QUEUES selects no known queue", config });
    return null;
  }
  const worker = mail.createWorker({ queues });
  if (config.worker.leaseClampedFrom != null) logger.warn(`[MailWorker] MAIL_WORKER_LEASE_SECONDS=${config.worker.leaseClampedFrom} is shorter than the provider timeout plus margin; using ${config.worker.leaseSeconds}s`);
  // Which database this worker serves (name only): it must be the API's.
  const database = await prisma.$queryRawUnsafe("SELECT current_database() AS name").then((rows) => rows?.[0]?.name || "unknown").catch(() => "unknown");
  logger.info(`[MailWorker] starting ${JSON.stringify({ ...publicStatus(config), queues, database, release: config.worker.release, leaseOwner: worker.leaseOwner, leaseSeconds: config.worker.leaseSeconds, drainTimeoutMs: config.worker.drainTimeoutMs, heartbeatSeconds: config.worker.heartbeatIntervalSeconds })}`);
  worker.start();
  installShutdown({ worker, config, disconnect: () => prisma.$disconnect() });
  return null;
}

// Graceful shutdown: stop claiming, drain in-flight jobs up to
// MAIL_WORKER_DRAIN_TIMEOUT_MS, then exit. Jobs still running are left to
// lease recovery (their ids are logged by worker.stop). An unexpected
// rejection/exception is logged and also triggers a graceful shutdown (exit
// code 1) instead of a silent crash; the supervisor restarts the process.
function installShutdown({ worker, config, disconnect, exit = (code) => process.exit(code), on = (event, handler) => process.on(event, handler) }) {
  let stopping = null;
  const shutdown = (reason, code = 0) => {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info(`[MailWorker] ${reason}; draining in-flight jobs (up to ${config.worker.drainTimeoutMs}ms)`);
      let result = null;
      try {
        result = await worker.stop({ timeoutMs: config.worker.drainTimeoutMs });
      } catch (error) {
        logger.error(`[MailWorker] stop failed: ${error?.message}`);
      }
      logger.info(`[MailWorker] stopped ${JSON.stringify({ ...(result || {}), metrics: worker.metrics })}`);
      await Promise.resolve().then(disconnect).catch(() => {});
      exit(code);
    })();
    return stopping;
  };
  on("SIGTERM", () => shutdown("SIGTERM received"));
  on("SIGINT", () => shutdown("SIGINT received"));
  on("unhandledRejection", (error) => {
    logger.error(`[MailWorker] unhandled rejection (${error?.code || "error"}): ${error?.message || error}`);
    shutdown("unhandled rejection", 1);
  });
  on("uncaughtException", (error) => {
    logger.error(`[MailWorker] uncaught exception (${error?.code || "error"}): ${error?.message || error}`);
    shutdown("uncaught exception", 1);
  });
  return { shutdown };
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`[MailWorker] fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, installShutdown, idle };
