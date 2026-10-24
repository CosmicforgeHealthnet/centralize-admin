"use strict";

// Mail worker: a separately started process (src/mail-worker.js). It is NOT
// registered inside every API replica. Claims durable jobs with leases,
// processes them with bounded concurrency, retries with jittered backoff,
// dead-letters exhausted jobs and drains in-flight work on shutdown.

const { leaseOwnerId } = require("./mail-job.repository");

function createMailWorker({ jobs, handlers, config, logger, onDeadLetter = {}, queues = ["OUTBOUND", "INBOUND", "EVENTS"], setTimer = setTimeout, clearTimer = clearTimeout }) {
  const leaseOwner = leaseOwnerId();
  const metrics = { claimed: 0, succeeded: 0, retried: 0, failed: 0, deadLettered: 0, recovered: 0, lastTickAt: null, lastError: null };
  let running = false;
  let timer = null;
  const inFlight = new Set();

  async function runJob(job) {
    const handler = handlers[job.kind];
    if (!handler) {
      await jobs.fail(job, { code: "UNKNOWN_JOB_KIND", message: job.kind, retryable: false });
      metrics.failed += 1;
      return;
    }
    try {
      const result = await handler(job);
      await jobs.complete(job, { providerRequestId: result?.providerMessageId || null });
      metrics.succeeded += 1;
    } catch (error) {
      const retryable = error?.retryable !== false;
      const outcome = await jobs.fail(job, { code: error?.code || "HANDLER_ERROR", message: error?.message, retryable, reconcile: Boolean(error?.reconcile), retryAfterSeconds: error?.retryAfterSeconds ?? null });
      if (outcome.status === "DEAD_LETTER") {
        metrics.deadLettered += 1;
        await onDeadLetter[job.kind]?.(job, error).catch(() => {});
      } else if (outcome.status === "FAILED") metrics.failed += 1;
      else metrics.retried += 1;
      logger?.warn?.(`[MailWorker] job ${job.id} ${job.kind} -> ${outcome.status} (${error?.code || "error"})`);
    }
  }

  async function tick() {
    metrics.lastTickAt = new Date().toISOString();
    metrics.recovered += await jobs.recoverExpiredLeases();
    const capacity = config.worker.concurrency - inFlight.size;
    if (capacity <= 0) return 0;
    const claimed = await jobs.claim({ queues, leaseOwner, leaseSeconds: config.worker.leaseSeconds, limit: capacity });
    metrics.claimed += claimed.length;
    for (const job of claimed) {
      const promise = runJob(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }
    return claimed.length;
  }

  // Processes until no eligible jobs remain (used by tests and one-shot runs).
  async function drain({ maxTicks = 50 } = {}) {
    for (let index = 0; index < maxTicks; index += 1) {
      const claimed = await tick();
      await Promise.all([...inFlight]);
      if (!claimed) break;
    }
  }

  function schedule() {
    if (!running) return;
    timer = setTimer(async () => {
      try {
        await tick();
      } catch (error) {
        metrics.lastError = error?.code || "tick-error";
        logger?.error?.(`[MailWorker] tick failed: ${error?.message}`);
      }
      schedule();
    }, config.worker.pollIntervalMs);
  }

  function start() {
    if (running) return { started: false, reason: "already-running" };
    running = true;
    schedule();
    return { started: true, leaseOwner };
  }

  async function stop({ timeoutMs = 30000 } = {}) {
    running = false;
    if (timer) clearTimer(timer);
    const deadline = new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.());
    await Promise.race([Promise.allSettled([...inFlight]), deadline]);
    return { stopped: true, inFlight: inFlight.size };
  }

  return { start, stop, tick, drain, metrics, leaseOwner, get running() { return running; } };
}

module.exports = { createMailWorker };
