const crypto = require("crypto");
const logger = require("../../../../shared/utils/logger");
const { EVENTS, logEvent } = require("../observability");

// Distributed lock preventing overlapping synchronization runs.
//
// AUDIT NOTE: this repository has no Redis infrastructure (no client, no
// dependency, no Paystack idempotency code  that lives in the main backend),
// and introducing new Redis infrastructure is explicitly out of scope for
// Phase 1. This lock therefore uses the admin Postgres database
// (marketing_sync_locks) with the exact semantics of a Redis
// `SET key owner NX PX ttl` lock:
//   - acquire is atomic (INSERT, or conditional steal of an expired row),
//   - each acquisition gets a unique owner token,
//   - TTL expiry means a crashed worker can never lock the system forever,
//   - release only succeeds when the stored owner token matches.

const SYNC_LOCK_KEY = "marketing:intelligence:sync";
const DEFAULT_TTL_SECONDS = 1800;
const MIN_HEARTBEAT_INTERVAL_MS = 1000;

function lockTtlSeconds() {
  const parsed = Number(process.env.MARKETING_INTELLIGENCE_LOCK_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTL_SECONDS;
}

function renewalIntervalMs(ttlSeconds = lockTtlSeconds()) {
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor((ttlSeconds * 1000) / 3));
}

function createSyncLock({ prisma, now = () => new Date(), log = logger }) {
  // Attempt to acquire the lock. Returns the owner token on success or null
  // when another run already holds an unexpired lock.
  async function acquire(key = SYNC_LOCK_KEY, ttlSeconds = lockTtlSeconds()) {
    const owner = crypto.randomUUID();
    const current = now();
    const expiresAt = new Date(current.getTime() + ttlSeconds * 1000);

    try {
      await prisma.marketing_sync_locks.create({
        data: { key, owner, expiresAt },
      });
      logEvent(EVENTS.LOCK_RESULT, { runId: null, lockNamespace: key, operation: "ACQUIRE", result: "ACQUIRED", ownerMismatch: false, attempt: 1, ttlSeconds }, { log });
      return owner;
    } catch (error) {
      if (error.code !== "P2002") throw error;
    }

    // A lock row exists  steal it only if it has expired. updateMany with a
    // WHERE clause is a single atomic UPDATE.
    const stolen = await prisma.marketing_sync_locks.updateMany({
      where: { key, expiresAt: { lt: current } },
      data: { owner, expiresAt },
    });

    const result = stolen.count === 1 ? "STALE_RECOVERED" : "SKIPPED_LOCKED";
    logEvent(stolen.count === 1 ? EVENTS.LOCK_RESULT : EVENTS.LOCK_CONFLICT, { runId: null, lockNamespace: key, operation: "ACQUIRE", result, ownerMismatch: false, attempt: 2, ttlSeconds }, { log, level: stolen.count === 1 ? "info" : "warn" });
    return stolen.count === 1 ? owner : null;
  }

  // Extend the TTL of a lock we still own (renewal for long-running jobs).
  async function renew(key, owner, ttlSeconds = lockTtlSeconds()) {
    const current = now();
    const expiresAt = new Date(current.getTime() + ttlSeconds * 1000);
    const renewed = await prisma.marketing_sync_locks.updateMany({
      where: { key, owner, expiresAt: { gt: current } },
      data: { expiresAt },
    });
    const ok = renewed.count === 1;
    logEvent(ok ? EVENTS.LOCK_RESULT : EVENTS.LOCK_RENEWAL_FAILED, { runId: null, lockNamespace: key, operation: "RENEW", result: ok ? "RENEWED" : "RENEWAL_FAILED", ownerMismatch: !ok, attempt: 1, ttlSeconds }, { log, level: ok ? "info" : "warn" });
    return ok;
  }

  // Release only when the stored owner matches  a stale process that lost
  // its lock to TTL expiry can never delete the new owner's lock.
  async function release(key, owner) {
    if (!owner) return false;

    const deleted = await prisma.marketing_sync_locks.deleteMany({
      where: { key, owner },
    });

    if (deleted.count !== 1) {
      logEvent(EVENTS.LOCK_RESULT, { runId: null, lockNamespace: key, operation: "RELEASE", result: "OWNER_MISMATCH", ownerMismatch: true, attempt: 1, ttlSeconds: lockTtlSeconds() }, { log, level: "warn" });
    } else {
      logEvent(EVENTS.LOCK_RESULT, { runId: null, lockNamespace: key, operation: "RELEASE", result: "RELEASED", ownerMismatch: false, attempt: 1, ttlSeconds: lockTtlSeconds() }, { log });
    }

    return deleted.count === 1;
  }

  function startHeartbeat({
    key = SYNC_LOCK_KEY,
    owner,
    ttlSeconds = lockTtlSeconds(),
    onFailure,
  } = {}) {
    if (!owner) {
      const error = new Error("owner is required for lock heartbeat");
      error.statusCode = 500;
      throw error;
    }

    let stopped = false;
    let failed = false;
    let lastError = null;
    const intervalMs = renewalIntervalMs(ttlSeconds);

    const tick = async () => {
      if (stopped || failed) return;
      try {
        const ok = await renew(key, owner, ttlSeconds);
        if (!ok) {
          failed = true;
          lastError = new Error("lock owner lost during renewal");
          if (onFailure) await onFailure(lastError);
        }
      } catch (error) {
        failed = true;
        lastError = error;
        if (onFailure) await onFailure(error);
      }
    };

    const timer = setInterval(() => {
      tick().catch((error) => {
        failed = true;
        lastError = error;
      });
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();

    return {
      intervalMs,
      stop() {
        stopped = true;
        clearInterval(timer);
      },
      failed() {
        return failed;
      },
      lastError() {
        return lastError;
      },
      renewNow: tick,
    };
  }

  return { acquire, renew, release, startHeartbeat };
}

module.exports = { SYNC_LOCK_KEY, lockTtlSeconds, renewalIntervalMs, createSyncLock };
