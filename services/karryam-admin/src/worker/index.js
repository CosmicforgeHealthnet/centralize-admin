"use strict";

// Karryam Admin Stage A worker (separate process, same image):
//   node src/worker/index.js
//
// Polls the Karryam Backoffice Bridge HQ event feed for every approved feed
// scope, applies verified events durably, ACKs the Bridge after commit,
// reconciles on start and then every KARRYAM_BRIDGE_RECONCILE_INTERVAL_SECONDS,
// and clears expired inbox payloads daily. It never calls Headquarters.
// Disabled unless KARRYAM_BRIDGE_FEED_ENABLED=true with a fully enrolled
// Bridge; any configuration problem exits non-zero with a sanitized reason.

const { loadConfig } = require("../config");
const { createLogger } = require("../logger");
const { createPool } = require("../db/pool");
const { createBridgeClient } = require("../bridge/client");
const { createPipelineStore } = require("../sync/store");
const { createBridgeConsumer } = require("../sync/bridge-consumer");

const DAY_MS = 86400000;

function backoff(failures, baseSeconds) {
  return Math.min(baseSeconds * 2 ** Math.min(failures, 6), 900) * 1000;
}

async function startWorker(env = process.env, { logger = createLogger(), now = Date.now, deps = {} } = {}) {
  const config = loadConfig(env);
  if (!config.enabled) throw Object.assign(new Error(), { reason: "KARRYAM_ADMIN_DISABLED" });
  if (!config.feed.enabled) throw Object.assign(new Error(), { reason: "KARRYAM_BRIDGE_FEED_DISABLED" });
  const pool = deps.pool || createPool(config.databaseUrl, { max: 4 });
  const store = createPipelineStore(pool, { serviceInstanceId: config.serviceInstanceId, now });
  const bridgeClient = deps.bridgeClient || createBridgeClient(config.bridge, { metrics: {} });
  const consumer = createBridgeConsumer({ feed: config.feed, store, bridgeClient, now, logger });
  await consumer.init();

  let stopping = false;
  let timer = null;
  let failures = 0;
  let lastReconcile = 0;
  let lastRetention = 0;
  let wake = null;

  async function cycle() {
    if (now() - lastReconcile >= config.feed.reconcileSeconds * 1000) {
      const results = await consumer.reconcile({ trigger: "SCHEDULED" });
      lastReconcile = now();
      logger({ event: "bridge_reconcile", results: results.map((r) => ({ partition_key: r.partitionKey, status: r.status, reason: r.reason })) });
    }
    const results = await consumer.tick();
    if (now() - lastRetention >= DAY_MS) {
      const cleared = await store.clearExpiredPayloads(config.feed.retentionDays);
      lastRetention = now();
      if (cleared) logger({ event: "inbox_retention", cleared });
    }
    return results;
  }

  async function loop() {
    while (!stopping) {
      let delay = config.feed.pollSeconds * 1000;
      try {
        const results = await cycle();
        const failed = results.some((r) => r.status === "FAILED");
        failures = failed ? failures + 1 : 0;
        if (failed) delay = backoff(failures, config.feed.pollSeconds);
        // Backpressure: a full page means more is waiting; continue promptly.
        if (results.some((r) => r.status === "SUCCEEDED" && r.received >= config.feed.pageSize)) delay = 250;
      } catch (err) {
        failures += 1;
        delay = backoff(failures, config.feed.pollSeconds);
        logger({ event: "bridge_worker_cycle_failed", error: err && err.name, failures });
      }
      if (stopping) break;
      await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, delay); });
    }
  }

  const running = loop();
  logger({ event: "bridge_worker_started", worker_id: consumer.workerId, partitions: config.feed.scopes.length, contract_revision: consumer.revision });

  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    logger({ event: "bridge_worker_stopping", signal });
    clearTimeout(timer);
    if (wake) wake();
    await running; // finish the in-flight transaction; nothing is left half-applied
    if (!deps.pool) await pool.end().catch(() => {});
  }
  return { stop, consumer, store, config };
}

if (require.main === module) {
  const logger = createLogger();
  startWorker(process.env, { logger }).then(({ stop }) => {
    process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)));
    process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)));
  }).catch((err) => {
    logger({ event: "worker_startup_failed", reason: err && err.reason ? err.reason : (err && err.code) || "STARTUP_FAILED" });
    process.exit(1);
  });
}

module.exports = { startWorker };
