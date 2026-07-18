const crypto = require("crypto");
const logger = require("../../../../shared/utils/logger");

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

function lockTtlSeconds() {
  const parsed = Number(process.env.MARKETING_INTELLIGENCE_LOCK_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTL_SECONDS;
}

function createSyncLock({ prisma, now = () => new Date() }) {
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

    return stolen.count === 1 ? owner : null;
  }

  // Extend the TTL of a lock we still own (renewal for long-running jobs).
  async function renew(key, owner, ttlSeconds = lockTtlSeconds()) {
    const expiresAt = new Date(now().getTime() + ttlSeconds * 1000);
    const renewed = await prisma.marketing_sync_locks.updateMany({
      where: { key, owner },
      data: { expiresAt },
    });
    return renewed.count === 1;
  }

  // Release only when the stored owner matches  a stale process that lost
  // its lock to TTL expiry can never delete the new owner's lock.
  async function release(key, owner) {
    if (!owner) return false;

    const deleted = await prisma.marketing_sync_locks.deleteMany({
      where: { key, owner },
    });

    if (deleted.count !== 1) {
      logger.warn(
        `[MarketingIntelligence] Lock release skipped  owner no longer holds ${key}`,
      );
    }

    return deleted.count === 1;
  }

  return { acquire, renew, release };
}

module.exports = { SYNC_LOCK_KEY, lockTtlSeconds, createSyncLock };
