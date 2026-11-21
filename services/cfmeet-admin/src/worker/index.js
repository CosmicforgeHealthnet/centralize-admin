"use strict";

// CF Meet Admin Stage A worker (separate process, same image):
//   node src/worker/index.js
//
// Polls the CF Meet Admin Bridge HQ event feed for every approved feed
// scope, applies verified events durably, ACKs the Bridge after commit,
// pulls certified Bridge datasets every CFMEET_BRIDGE_DATASET_PULL_SECONDS,
// reconciles on start and then every CFMEET_BRIDGE_RECONCILE_INTERVAL_SECONDS,
// and clears expired inbox payloads daily. While the pinned contract does not
// serve the event feed (hq.events.feed/ack DISABLED or BLOCKED_DEPENDENCY), it
// never calls the feed and only pulls datasets: calling a capability the Bridge
// refuses would only produce failures and false stall alerts. It never calls Headquarters.
// Disabled unless CFMEET_BRIDGE_FEED_ENABLED=true with a fully enrolled
// Bridge; any configuration problem exits non-zero with a sanitized reason.

const { loadConfig } = require("../config");
const { createLogger } = require("../logger");
const { createPool } = require("../db/pool");
const { createBridgeClient } = require("../bridge/client");
const { createPipelineStore } = require("../sync/store");
const { createBridgeConsumer } = require("../sync/bridge-consumer");
const { createDatasetPuller } = require("../sync/dataset-puller");
const { createGovernanceStore } = require("../db/governance");
const R = require("../bridge/contracts/registry");

const NOT_SERVED = new Set(["DISABLED", "BLOCKED_DEPENDENCY"]);

// True when the pinned contract serves both the HQ event feed and its ACK.
function eventFeedServed(registry = R) {
  return ["hq.events.feed", "hq.events.ack"].every((id) => {
    const cap = registry.capability(id);
    return Boolean(cap) && !NOT_SERVED.has(cap.matrix_state);
  });
}

const DAY_MS = 86400000;

function backoff(failures, baseSeconds) {
  return Math.min(baseSeconds * 2 ** Math.min(failures, 6), 900) * 1000;
}

async function startWorker(env = process.env, { logger = createLogger(), now = Date.now, deps = {} } = {}) {
  const config = loadConfig(env);
  if (!config.enabled) throw Object.assign(new Error(), { reason: "CFMEET_ADMIN_DISABLED" });
  if (!config.feed.enabled) throw Object.assign(new Error(), { reason: "CFMEET_BRIDGE_FEED_DISABLED" });
  const pool = deps.pool || createPool(config.databaseUrl, { max: 4 });
  const store = createPipelineStore(pool, { serviceInstanceId: config.serviceInstanceId, now });
  const governance = deps.governance === undefined ? createGovernanceStore(pool, { now }) : deps.governance;
  const bridgeClient = deps.bridgeClient || createBridgeClient(config.bridge, { metrics: {} });
  const consumer = createBridgeConsumer({ feed: config.feed, store, bridgeClient, now, logger });
  await consumer.init();
  const events = deps.eventFeedServed === undefined ? eventFeedServed() : deps.eventFeedServed;
  if (!events) logger({ event: "bridge_event_feed_not_served", contract_version: R.summary().contract_version || null });
  const puller = createDatasetPuller({ feed: config.feed, store, bridgeClient, certifiedDatasets: config.certifiedDatasets, days: config.feed.datasetDays, now, logger });

  let stopping = false;
  let timer = null;
  let failures = 0;
  let lastReconcile = 0;
  let lastRetention = 0;
  let lastPull = 0;
  let wake = null;

  async function cycle() {
    if (events && now() - lastReconcile >= config.feed.reconcileSeconds * 1000) {
      const results = await consumer.reconcile({ trigger: "SCHEDULED" });
      lastReconcile = now();
      logger({ event: "bridge_reconcile", results: results.map((r) => ({ partition_key: r.partitionKey, status: r.status, reason: r.reason })) });
    }
    const results = events ? await consumer.tick() : [];
    if (puller.datasets.length && now() - lastPull >= config.feed.datasetPullSeconds * 1000) {
      const pulled = await puller.pull();
      lastPull = now();
      logger({ event: "bridge_dataset_pull", results: pulled.map((r) => ({ partition_key: r.partitionKey, dataset_id: r.datasetId, status: r.status, reason: r.reason, published: r.published })) });
    }
    if (now() - lastRetention >= DAY_MS) {
      // Per-class retention policy (never shorter than the configured days);
      // rows under an active legal hold are kept.
      const retention = governance
        ? await governance.clearExpiredPayloads({ configuredDays: config.feed.retentionDays })
        : { cleared: await store.clearExpiredPayloads(config.feed.retentionDays), retainedUnderHold: 0 };
      lastRetention = now();
      if (retention.cleared || retention.retainedUnderHold) logger({ event: "inbox_retention", cleared: retention.cleared, retained_under_hold: retention.retainedUnderHold });
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
  return { stop, consumer, puller, store, config };
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

module.exports = { startWorker, eventFeedServed };
