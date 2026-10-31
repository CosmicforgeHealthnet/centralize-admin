"use strict";

// Durable Mail worker heartbeats.
//
// Each worker process records where it is (state, served and paused queues,
// progress counters, release image, database name) in one row per worker
// instance. The row lives in mail_outbox_jobs with kind WORKER_HEARTBEAT and
// status SUCCEEDED, so:
// - no schema migration is needed (the table, its indexes and its
//   retention already exist on every Mail database);
// - it is never claimable (claim() only takes PENDING / RETRY_SCHEDULED /
//   RECONCILING), never lease-recovered (only LEASED rows are) and never
//   requeued (only DEAD_LETTER / FAILED are);
// - the API, the ops monitor and the deploy scripts read it from the same
//   database the API writes jobs to, so a worker pointed at another database
//   is visibly absent.
// Nothing here holds message content, addresses or secrets.

const os = require("os");

const HEARTBEAT_KIND = "WORKER_HEARTBEAT";
const HEARTBEAT_KEY_PREFIX = "worker-heartbeat:";
// Heartbeat rows older than this are history, not workers.
const HEARTBEAT_LIST_WINDOW_MS = 7 * 86400000;

function instanceKey({ environment, queues, instance }) {
  const name = String(instance || "").trim().replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60);
  const queueSet = [...queues].map(String).sort().join("+").toLowerCase();
  return `${HEARTBEAT_KEY_PREFIX}${environment}:${name || queueSet}`.slice(0, 160);
}

function createWorkerHeartbeat({ client, config, queues, instance = process.env.MAIL_WORKER_INSTANCE, clock = () => new Date(), logger = null }) {
  const key = instanceKey({ environment: config.deploymentEnvironment, queues, instance });
  const startedAt = clock().toISOString();
  let lastWriteAt = null;
  let database = null;
  let failures = 0;

  async function databaseName() {
    if (database !== null || typeof client.$queryRawUnsafe !== "function") return database;
    try {
      const rows = await client.$queryRawUnsafe("SELECT current_database() AS name");
      database = String(rows?.[0]?.name || "");
    } catch {
      database = null;
    }
    return database;
  }

  // Writes the heartbeat when the interval has passed (or `force`).
  async function beat(state, { force = false } = {}) {
    const now = clock();
    const intervalMs = (config.worker.heartbeatIntervalSeconds || 30) * 1000;
    if (!force && lastWriteAt !== null && now.getTime() - lastWriteAt < intervalMs) return false;
    lastWriteAt = now.getTime();
    const payload = {
      state: state.state,
      leaseOwner: state.leaseOwner || null,
      queues: [...queues],
      activeQueues: state.activeQueues || [],
      pausedQueues: state.pausedQueues || [],
      release: config.worker.release || null,
      hostname: os.hostname().slice(0, 100),
      pid: process.pid,
      database: await databaseName(),
      startedAt,
      lastTickAt: state.metrics?.lastTickAt || null,
      lastTickCompletedAt: state.metrics?.lastTickCompletedAt || null,
      counters: state.metrics
        ? Object.fromEntries(["ticks", "claimed", "succeeded", "retried", "failed", "deadLettered", "deferred", "recovered", "leasesLost", "settleErrors", "inFlight"].map((name) => [name, Number(state.metrics[name] || 0)]))
        : {},
      lastError: state.metrics?.lastError || null,
      heartbeatAt: now.toISOString(),
    };
    try {
      await client.mailOutboxJob.upsert({
        where: { idempotencyKey: key },
        create: { queue: "EVENTS", kind: HEARTBEAT_KIND, status: "SUCCEEDED", idempotencyKey: key, payload, attemptCount: 0, maxAttempts: 1, nextAttemptAt: now, completedAt: now },
        update: { payload, completedAt: now, status: "SUCCEEDED", leaseOwner: null, leaseExpiresAt: null },
      });
      if (failures) logger?.info?.(`[MailWorker] heartbeat recorded again after ${failures} failure(s)`);
      failures = 0;
      return true;
    } catch (error) {
      failures += 1;
      // A heartbeat that cannot be written never stops job processing.
      if (failures === 1 || failures % 20 === 0) logger?.warn?.(`[MailWorker] heartbeat write failed (${error?.code || "error"}); processing continues`);
      return false;
    }
  }

  return { key, beat, databaseName };
}

// Every worker heartbeat seen within the window, newest first, with its age.
async function listWorkerHeartbeats(client, { clock = () => new Date(), staleAfterSeconds = 180 } = {}) {
  const now = clock().getTime();
  const rows = await client.mailOutboxJob.findMany({
    where: { kind: HEARTBEAT_KIND, idempotencyKey: { startsWith: HEARTBEAT_KEY_PREFIX }, completedAt: { gt: new Date(now - HEARTBEAT_LIST_WINDOW_MS) } },
    orderBy: { completedAt: "desc" },
    select: { idempotencyKey: true, payload: true, completedAt: true },
    take: 20,
  });
  return rows.map((row) => {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    const ageSeconds = row.completedAt ? Math.max(0, Math.round((now - row.completedAt.getTime()) / 1000)) : null;
    const reported = String(payload.state || "UNKNOWN");
    // A heartbeat that stopped arriving means the process is gone or hung,
    // whatever it last reported (except a clean STOPPED).
    const state = reported === "STOPPED" ? "STOPPED" : ageSeconds === null || ageSeconds > staleAfterSeconds ? "NOT_RUNNING" : reported;
    return {
      instance: row.idempotencyKey.slice(HEARTBEAT_KEY_PREFIX.length),
      state,
      reportedState: reported,
      ageSeconds,
      queues: Array.isArray(payload.queues) ? payload.queues : [],
      activeQueues: Array.isArray(payload.activeQueues) ? payload.activeQueues : [],
      pausedQueues: Array.isArray(payload.pausedQueues) ? payload.pausedQueues : [],
      release: payload.release || null,
      database: payload.database || null,
      startedAt: payload.startedAt || null,
      lastTickCompletedAt: payload.lastTickCompletedAt || null,
      counters: payload.counters || {},
      lastError: payload.lastError || null,
    };
  });
}

// One summary for health/readiness: is a worker actively serving each core
// queue the backend enables?
function summarizeWorkers(workers, { coreQueues = [] } = {}) {
  const running = workers.filter((worker) => worker.state === "RUNNING");
  const served = new Set(running.flatMap((worker) => worker.activeQueues));
  const paused = [];
  for (const worker of running) for (const entry of worker.pausedQueues) if (coreQueues.includes(entry.queue) && !served.has(entry.queue)) paused.push(entry);
  const unserved = coreQueues.filter((queue) => !served.has(queue));
  const freshest = workers[0] || null;
  return {
    state: running.length ? (unserved.length ? "DEGRADED" : "RUNNING") : freshest?.state === "DISABLED" ? "DISABLED" : "NOT_RUNNING",
    running: running.length,
    lastHeartbeatAgeSeconds: freshest ? freshest.ageSeconds : null,
    servedQueues: [...served].sort(),
    unservedCoreQueues: unserved,
    pausedCoreQueues: paused,
    releases: [...new Set(running.map((worker) => worker.release).filter(Boolean))],
  };
}

module.exports = { createWorkerHeartbeat, listWorkerHeartbeats, summarizeWorkers, instanceKey, HEARTBEAT_KIND, HEARTBEAT_KEY_PREFIX };
