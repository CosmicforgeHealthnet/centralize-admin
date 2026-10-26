"use strict";

// Mail worker: a separately started process (src/mail-worker.js). It is NOT
// registered inside every API replica. Claims durable jobs with leases,
// processes them with bounded concurrency, retries with jittered backoff,
// dead-letters exhausted jobs and drains in-flight work on shutdown.
//
// Reliability rules (spec 17/20):
// - A job's outcome is recorded only while its lease is held (complete/fail/
//   defer are fenced by lease token). A lost lease is never counted as a
//   success; the newer lease holder owns the job.
// - Recording an outcome can fail (database blip): that is logged with the
//   job id and the worker keeps running; the job comes back via lease expiry.
// - Terminal outcomes run the kind's cleanup: onDeadLetter for exhausted
//   jobs, onFailed for non-retryable failures (e.g. an outbound send must
//   never stay QUEUED after its job FAILED).
// - stop() stops claiming, waits for the running tick and every in-flight job
//   up to the drain timeout; jobs still running are left to lease recovery.

const { leaseOwnerId, correlationIdOf } = require("./mail-job.repository");

// Queues whose jobs are lease-heartbeated while the handler runs: long
// broadcast syncs (MARKETING), multi-batch sends and slow provider calls
// (OUTBOUND), large inbound fetch/scan (INBOUND). The heartbeat also detects
// a lost lease so the handler stops before its next provider call.
const HEARTBEAT_QUEUES = new Set(["MARKETING", "OUTBOUND", "INBOUND"]);

function jobRef(job) {
  const correlationId = correlationIdOf(job);
  return `job ${job?.id} ${job?.kind}${job?.idempotencyKey ? ` key=${String(job.idempotencyKey).slice(0, 80)}` : ""}${correlationId ? ` correlationId=${correlationId}` : ""}`;
}

function createMailWorker({ jobs, handlers, config, logger, onDeadLetter = {}, onFailed = {}, queues = ["OUTBOUND", "INBOUND", "EVENTS"], beforeTick = null, queueFilter = null, schemaReady = null, setTimer = setTimeout, clearTimer = clearTimeout, heartbeatIntervalMs = null, livenessLogIntervalMs = 60000, now = () => Date.now() }) {
  const leaseOwner = leaseOwnerId();
  const metrics = { claimed: 0, succeeded: 0, retried: 0, failed: 0, deadLettered: 0, deferred: 0, recovered: 0, leasesLost: 0, settleErrors: 0, cleanupErrors: 0, ticks: 0, inFlight: 0, lastTickAt: null, lastTickCompletedAt: null, lastError: null };
  let running = false;
  let stopping = false;
  let timer = null;
  let currentTick = null;
  let lastLivenessLog = 0;
  // promise -> job id (for drain reporting)
  const inFlight = new Map();

  // Lease heartbeat: extends the lease every third of its length. If the
  // lease is lost, job.lease.lost is set so the handler can stop before any
  // provider call; the stale run's complete/fail/payload writes are refused
  // by lease token.
  function startHeartbeat(job) {
    const lease = { lost: false };
    job.lease = lease;
    if (!HEARTBEAT_QUEUES.has(job.queue) || typeof jobs.heartbeat !== "function") return () => {};
    const leaseSeconds = config.worker.leaseSeconds || 120;
    const every = heartbeatIntervalMs || Math.max(5000, Math.floor((leaseSeconds * 1000) / 3));
    const timerId = setInterval(() => {
      if (lease.lost) return;
      jobs.heartbeat(job, { leaseSeconds }).then((held) => {
        if (!held && !lease.lost) {
          lease.lost = true;
          metrics.leasesLost += 1;
          logger?.warn?.(`[MailWorker] ${jobRef(job)} lease lost during processing; the run stops before its next provider call`);
        }
      }).catch((error) => {
        logger?.warn?.(`[MailWorker] ${jobRef(job)} lease heartbeat failed (${error?.code || "error"})`);
      });
    }, every);
    timerId.unref?.();
    return () => clearInterval(timerId);
  }

  function leaseLost(job, what) {
    metrics.leasesLost += 1;
    logger?.warn?.(`[MailWorker] ${jobRef(job)} lease lost; ${what} not recorded (the newer lease holder owns the job)`);
  }

  async function runCleanup(callbacks, job, error, label) {
    const callback = callbacks[job.kind];
    if (!callback) return;
    try {
      await callback(job, error);
    } catch (cleanupError) {
      metrics.cleanupErrors += 1;
      logger?.error?.(`[MailWorker] ${jobRef(job)} ${label} cleanup failed (${cleanupError?.code || "error"}): ${cleanupError?.message}`);
    }
  }

  async function settleSuccess(job, result) {
    // Handlers may ask to run again later without consuming an attempt
    // (paused dispatch, disabled flag, batched multi-step progress).
    if (result?.defer) {
      const deferred = await jobs.defer(job, result.defer);
      if (deferred?.updated === false) return leaseLost(job, "defer");
      metrics.deferred += 1;
      return;
    }
    const completed = await jobs.complete(job, { providerRequestId: result?.providerMessageId || null });
    if (completed === false) return leaseLost(job, "success");
    metrics.succeeded += 1;
  }

  async function settleFailure(job, error) {
    if (error?.leaseLost || job.lease?.lost) {
      leaseLost(job, `failure (${error?.code || "error"})`);
      return;
    }
    const retryable = error?.retryable !== false;
    const outcome = await jobs.fail(job, { code: error?.code || "HANDLER_ERROR", message: error?.message, retryable, reconcile: Boolean(error?.reconcile), retryAfterSeconds: error?.retryAfterSeconds ?? null });
    if (outcome?.updated === false) return leaseLost(job, `failure (${error?.code || "error"})`);
    if (outcome.status === "DEAD_LETTER") {
      metrics.deadLettered += 1;
      await runCleanup(onDeadLetter, job, error, "dead-letter");
    } else if (outcome.status === "FAILED") {
      metrics.failed += 1;
      await runCleanup(onFailed, job, error, "terminal-failure");
    } else metrics.retried += 1;
    logger?.warn?.(`[MailWorker] ${jobRef(job)} attempt ${job.attemptCount} -> ${outcome.status} (${error?.code || "error"})`);
  }

  // Never rejects: an exception while recording the outcome is logged with
  // the job id; the job is recovered after its lease expires.
  async function runJob(job) {
    try {
      const handler = handlers[job.kind];
      if (!handler) {
        await jobs.fail(job, { code: "UNKNOWN_JOB_KIND", message: job.kind, retryable: false });
        metrics.failed += 1;
        return;
      }
      const stopHeartbeat = startHeartbeat(job);
      let result;
      let failure = null;
      try {
        result = await handler(job);
      } catch (error) {
        failure = error || new Error("handler failed");
      } finally {
        stopHeartbeat();
      }
      if (failure) await settleFailure(job, failure);
      else await settleSuccess(job, result);
    } catch (settleError) {
      metrics.settleErrors += 1;
      metrics.lastError = settleError?.code || "settle-error";
      logger?.error?.(`[MailWorker] ${jobRef(job)} outcome could not be recorded (${settleError?.code || "error"}): ${settleError?.message}; the job is recovered when its lease expires`);
    }
  }

  async function tick() {
    metrics.lastTickAt = new Date(now()).toISOString();
    metrics.ticks += 1;
    // Idle (claim nothing, touch no table) until the Mail schema exists.
    if (schemaReady && !(await schemaReady())) {
      metrics.schemaReady = false;
      return 0;
    }
    metrics.schemaReady = true;
    if (stopping) return 0;
    if (beforeTick) await beforeTick({ queues });
    const recovered = await jobs.recoverExpiredLeases();
    metrics.recovered += recovered.length;
    for (const entry of recovered) {
      logger?.warn?.(`[MailWorker] ${jobRef(entry.job)} lease expired; recovered as ${entry.status}`);
      if (entry.status !== "DEAD_LETTER") continue;
      metrics.deadLettered += 1;
      // A worker died mid-send on the final attempt: outcome is unknown.
      await runCleanup(onDeadLetter, entry.job, { code: "LEASE_EXPIRED", reconcile: true }, "dead-letter");
    }
    if (stopping) return 0;
    const capacity = config.worker.concurrency - inFlight.size;
    if (capacity <= 0) return 0;
    // M10: rollout rules can keep a deployed worker idle for a queue.
    const active = queueFilter ? await queueFilter(queues) : queues;
    metrics.activeQueues = active;
    if (!active.length || stopping) return 0;
    const claimed = await jobs.claim({ queues: active, leaseOwner, leaseSeconds: config.worker.leaseSeconds, limit: capacity });
    metrics.claimed += claimed.length;
    for (const job of claimed) {
      const promise = runJob(job).finally(() => {
        inFlight.delete(promise);
        metrics.inFlight = inFlight.size;
      });
      inFlight.set(promise, job.id);
    }
    metrics.inFlight = inFlight.size;
    return claimed.length;
  }

  // Liveness (spec 20): last completed tick, exported via metrics and logged
  // periodically so a stalled worker is visible in the logs.
  function noteLiveness() {
    metrics.lastTickCompletedAt = new Date(now()).toISOString();
    if (!livenessLogIntervalMs || now() - lastLivenessLog < livenessLogIntervalMs) return;
    lastLivenessLog = now();
    logger?.info?.(`[MailWorker] alive ${JSON.stringify({ leaseOwner, queues, lastTickAt: metrics.lastTickCompletedAt, inFlight: inFlight.size, claimed: metrics.claimed, succeeded: metrics.succeeded, retried: metrics.retried, failed: metrics.failed, deadLettered: metrics.deadLettered, leasesLost: metrics.leasesLost, settleErrors: metrics.settleErrors })}`);
  }

  // Processes until no eligible jobs remain (used by tests and one-shot runs).
  async function drain({ maxTicks = 50 } = {}) {
    for (let index = 0; index < maxTicks; index += 1) {
      const claimed = await tick();
      await Promise.all([...inFlight.keys()]);
      if (!claimed) break;
    }
  }

  function schedule() {
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      currentTick = (async () => {
        try {
          await tick();
          noteLiveness();
        } catch (error) {
          metrics.lastError = error?.code || "tick-error";
          logger?.error?.(`[MailWorker] tick failed (${error?.code || "error"}) leaseOwner=${leaseOwner} queues=${queues.join(",")}: ${error?.message}`);
        }
      })();
      await currentTick;
      currentTick = null;
      schedule();
    }, config.worker.pollIntervalMs);
  }

  function start() {
    if (running) return { started: false, reason: "already-running" };
    running = true;
    stopping = false;
    schedule();
    return { started: true, leaseOwner };
  }

  // Stops claiming, then waits for the running tick and all in-flight jobs up
  // to the drain timeout. Jobs still running afterwards are left to lease
  // recovery (their ids are logged and returned).
  async function stop({ timeoutMs = null } = {}) {
    running = false;
    stopping = true;
    if (timer) clearTimer(timer);
    timer = null;
    const limit = timeoutMs ?? config.worker.drainTimeoutMs ?? 30000;
    let deadlineTimer = null;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), limit);
      deadlineTimer.unref?.();
    });
    const settled = (async () => {
      if (currentTick) await currentTick.catch(() => {});
      // Snapshot after the tick: it may have claimed jobs just before stop.
      while (inFlight.size) await Promise.allSettled([...inFlight.keys()]);
      return "drained";
    })();
    const outcome = await Promise.race([settled, deadline]);
    clearTimeout(deadlineTimer);
    const remaining = [...inFlight.values()];
    if (remaining.length) logger?.warn?.(`[MailWorker] drain timeout after ${limit}ms; ${remaining.length} job(s) still running are left to lease recovery: ${remaining.join(", ")}`);
    return { stopped: true, drained: outcome === "drained" && !remaining.length, inFlight: remaining.length, inFlightJobIds: remaining };
  }

  return { start, stop, tick, drain, metrics, leaseOwner, get running() { return running; } };
}

module.exports = { createMailWorker, HEARTBEAT_QUEUES };
