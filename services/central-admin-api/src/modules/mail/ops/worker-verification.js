"use strict";

// Deploy-time proof that the Mail worker really processes work (used by
// scripts/mail/verify-worker.js from the deploy scripts). A container that
// exited 0, or one that runs but serves no queue, never passes:
//   1. a fresh RUNNING heartbeat from a worker on THIS database (same
//      current_database() as the API), optionally on the expected release;
//   2. every core queue the backend enables (OUTBOUND / INBOUND / EVENTS) is
//      actively served by a running worker;
//   3. optionally an isolated WORKER_SELF_TEST job (no side effects) is
//      claimed and completed by a worker within the wait.
// Reports counts, ages, states and codes only.

const crypto = require("crypto");
const { listWorkerHeartbeats } = require("../jobs/worker-heartbeat");

const SELF_TEST_KIND = "WORKER_SELF_TEST";

function coreQueuesFor(config) {
  return [
    ...(config.sendingEnabled ? ["OUTBOUND"] : []),
    ...(config.receivingEnabled && config.inbound?.ownedHere === true ? ["INBOUND"] : []),
    ...(config.enabled ? ["EVENTS"] : []),
  ];
}

async function verifyWorker({ client, config, jobs = null, expectRelease = null, selfTest = true, waitSeconds = 120, clock = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 2000 }) {
  if (!config.enabled) return { ok: true, state: "MAIL_DISABLED", applicable: false };
  if (!config.workerEnabled) return { ok: true, state: "WORKER_DISABLED", applicable: false, detail: "MAIL_WORKER_ENABLED=false (explicit shutdown)" };
  const rows = await client.$queryRawUnsafe("SELECT current_database() AS name");
  const database = String(rows?.[0]?.name || "");
  const coreQueues = coreQueuesFor(config);
  const deadline = clock().getTime() + waitSeconds * 1000;
  const result = { ok: false, applicable: true, database, coreQueues, expectRelease: expectRelease || null, checks: {} };

  // 1 + 2: heartbeat from a running worker on this database serving every core queue.
  let matching = [];
  let workers = [];
  for (;;) {
    workers = await listWorkerHeartbeats(client, { clock, staleAfterSeconds: config.worker.staleAfterSeconds });
    matching = workers.filter((worker) => worker.state === "RUNNING" && worker.database === database && (!expectRelease || worker.release === expectRelease));
    const served = new Set(matching.flatMap((worker) => worker.activeQueues));
    if (matching.length && coreQueues.every((queue) => served.has(queue))) break;
    if (clock().getTime() >= deadline) break;
    await sleep(pollMs);
  }
  const served = new Set(matching.flatMap((worker) => worker.activeQueues));
  result.workers = workers.slice(0, 5).map((worker) => ({ instance: worker.instance, state: worker.state, ageSeconds: worker.ageSeconds, release: worker.release, database: worker.database, activeQueues: worker.activeQueues, pausedQueues: worker.pausedQueues, counters: worker.counters }));
  result.checks.heartbeat = matching.length > 0;
  result.checks.database = matching.length > 0 || !workers.some((worker) => worker.state === "RUNNING" && worker.database !== database);
  result.checks.release = !expectRelease || matching.length > 0;
  result.checks.queues = coreQueues.every((queue) => served.has(queue));
  result.unservedQueues = coreQueues.filter((queue) => !served.has(queue));
  if (!result.checks.heartbeat) {
    const wrongDb = workers.find((worker) => worker.state === "RUNNING" && worker.database && worker.database !== database);
    result.reason = wrongDb ? "WORKER_ON_OTHER_DATABASE" : expectRelease && workers.some((worker) => worker.state === "RUNNING") ? "WORKER_RELEASE_MISMATCH" : "NO_FRESH_HEARTBEAT";
    return result;
  }
  if (!result.checks.queues) {
    result.reason = "CORE_QUEUE_NOT_SERVED";
    return result;
  }

  // 3: an isolated job, claimed first (oldest next_attempt_at), no side effects.
  if (selfTest) {
    const key = `worker-self-test:${clock().getTime()}:${crypto.randomBytes(4).toString("hex")}`;
    const requestedAt = clock();
    await client.mailOutboxJob.create({ data: { queue: "EVENTS", kind: SELF_TEST_KIND, idempotencyKey: key, payload: { requestedAt: requestedAt.toISOString() }, maxAttempts: 1, nextAttemptAt: new Date("2000-01-01T00:00:00Z") } });
    let job = null;
    for (;;) {
      job = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: key }, select: { status: true, completedAt: true, lastErrorCode: true } });
      if (job && ["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(job.status)) break;
      if (clock().getTime() >= deadline) break;
      await sleep(pollMs);
    }
    result.selfTest = { status: job?.status || "MISSING", lastErrorCode: job?.lastErrorCode || null, latencySeconds: job?.completedAt ? Math.round((job.completedAt.getTime() - requestedAt.getTime()) / 1000) : null };
    result.checks.selfTest = job?.status === "SUCCEEDED";
    if (!result.checks.selfTest) {
      // Never leave an unprocessed probe behind for a later worker.
      if (job && !["SUCCEEDED", "FAILED", "DEAD_LETTER"].includes(job.status)) await client.mailOutboxJob.updateMany({ where: { idempotencyKey: key, status: { in: ["PENDING", "RETRY_SCHEDULED"] } }, data: { status: "CANCELLED", completedAt: clock(), lastErrorCode: "SELF_TEST_TIMEOUT" } }).catch(() => {});
      result.reason = job?.status === "FAILED" ? "SELF_TEST_FAILED" : "SELF_TEST_NOT_PROCESSED";
      return result;
    }
  }
  if (jobs?.queueHealth) result.queues = await jobs.queueHealth().catch(() => null);
  result.ok = true;
  result.state = "RUNNING";
  return result;
}

module.exports = { verifyWorker, coreQueuesFor, SELF_TEST_KIND };
