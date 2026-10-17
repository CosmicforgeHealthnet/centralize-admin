const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createSyncLock, renewalIntervalMs, SYNC_LOCK_KEY } = require("../aggregation/sync-lock");
const { createAggregationService } = require("../aggregation/aggregation.service");
const { createFakePrisma } = require("./helpers/fake-prisma");

test("first synchronization acquires the lock", async () => {
  const lock = createSyncLock({ prisma: createFakePrisma() });
  const owner = await lock.acquire(SYNC_LOCK_KEY, 60);
  assert.ok(owner);
});

test("a concurrent synchronization is skipped", async () => {
  const lock = createSyncLock({ prisma: createFakePrisma() });
  const first = await lock.acquire(SYNC_LOCK_KEY, 60);
  const second = await lock.acquire(SYNC_LOCK_KEY, 60);
  assert.ok(first);
  assert.equal(second, null);
});

test("only the lock owner can release the lock", async () => {
  const prisma = createFakePrisma();
  const lock = createSyncLock({ prisma });
  const owner = await lock.acquire(SYNC_LOCK_KEY, 60);

  assert.equal(await lock.release(SYNC_LOCK_KEY, "not-the-owner"), false);
  assert.equal(await lock.acquire(SYNC_LOCK_KEY, 60), null); // still held

  assert.equal(await lock.release(SYNC_LOCK_KEY, owner), true);
  assert.ok(await lock.acquire(SYNC_LOCK_KEY, 60)); // free again
});

test("an expired lock can be stolen by a new run", async () => {
  const prisma = createFakePrisma();
  let currentTime = new Date("2026-07-01T00:00:00.000Z");
  const lock = createSyncLock({ prisma, now: () => currentTime });

  const stale = await lock.acquire(SYNC_LOCK_KEY, 60);
  assert.ok(stale);

  currentTime = new Date("2026-07-01T00:02:00.000Z"); // past the 60s TTL
  const fresh = await lock.acquire(SYNC_LOCK_KEY, 60);
  assert.ok(fresh);
  assert.notEqual(fresh, stale);

  // The stale owner can no longer release the new owner's lock.
  assert.equal(await lock.release(SYNC_LOCK_KEY, stale), false);
});

test("renew extends only a lock the caller still owns", async () => {
  const lock = createSyncLock({ prisma: createFakePrisma() });
  const owner = await lock.acquire(SYNC_LOCK_KEY, 60);
  assert.equal(await lock.renew(SYNC_LOCK_KEY, owner, 60), true);
  assert.equal(await lock.renew(SYNC_LOCK_KEY, "someone-else", 60), false);
});

test("an owner cannot renew after its lock has expired", async () => {
  const prisma = createFakePrisma();
  let currentTime = new Date("2026-07-01T00:00:00.000Z");
  const lock = createSyncLock({ prisma, now: () => currentTime });
  const owner = await lock.acquire(SYNC_LOCK_KEY, 10);
  currentTime = new Date("2026-07-01T00:00:11.000Z");
  assert.equal(await lock.renew(SYNC_LOCK_KEY, owner, 10), false);
});

test("heartbeat renews at one-third TTL and stops after completion", async () => {
  const prisma = createFakePrisma();
  let currentTime = new Date("2026-07-01T00:00:00.000Z");
  const lock = createSyncLock({ prisma, now: () => currentTime });
  const owner = await lock.acquire(SYNC_LOCK_KEY, 30);
  const before = prisma.__state.locks.get(SYNC_LOCK_KEY).expiresAt.getTime();

  const heartbeat = lock.startHeartbeat({ owner, ttlSeconds: 30 });
  assert.equal(heartbeat.intervalMs, renewalIntervalMs(30));

  currentTime = new Date("2026-07-01T00:00:10.000Z");
  await heartbeat.renewNow();
  const renewed = prisma.__state.locks.get(SYNC_LOCK_KEY).expiresAt.getTime();
  assert.ok(renewed > before);

  heartbeat.stop();
  currentTime = new Date("2026-07-01T00:00:20.000Z");
  await heartbeat.renewNow();
  assert.equal(prisma.__state.locks.get(SYNC_LOCK_KEY).expiresAt.getTime(), renewed);
});

test("heartbeat stops after owner loss and reports sanitized renewal failure", async () => {
  const prisma = createFakePrisma();
  const lock = createSyncLock({ prisma });
  await lock.acquire(SYNC_LOCK_KEY, 30);
  let failureMessage = null;

  const heartbeat = lock.startHeartbeat({
    owner: "not-the-owner",
    ttlSeconds: 30,
    onFailure: async (error) => {
      failureMessage = error.message;
    },
  });

  await heartbeat.renewNow();
  assert.equal(heartbeat.failed(), true);
  assert.equal(failureMessage, "lock owner lost during renewal");
  heartbeat.stop();
});

test("sync records lock renewal failure without deleting another owner's lock", async () => {
  const prisma = createFakePrisma();
  const releaseCalls = [];
  const syncLock = {
    async acquire() {
      return "owner-a";
    },
    startHeartbeat({ onFailure }) {
      onFailure(new Error("lock owner lost during renewal"));
      return { stop() {} };
    },
    async release(key, owner) {
      releaseCalls.push({ key, owner });
      return false;
    },
  };
  const service = createAggregationService({
    prisma,
    connectors: {},
    syncLock,
    log: { info() {}, warn() {}, error() {} },
  });

  const result = await service.syncMarketingInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    platforms: ["META"],
    trigger: "scheduled",
  });

  assert.equal(result.platforms.META, undefined);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].owner, "owner-a");
  assert.ok(prisma.__state.evaluationRuns.some((run) => run.status === "LOCK_RENEWAL_FAILED"));
});

test("database errors propagate instead of silently locking", async () => {
  const failingPrisma = {
    marketing_sync_locks: {
      async create() {
        throw new Error("database unavailable");
      },
    },
  };
  const lock = createSyncLock({ prisma: failingPrisma });
  await assert.rejects(lock.acquire(SYNC_LOCK_KEY, 60), /database unavailable/);
});
