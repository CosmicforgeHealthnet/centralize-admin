const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createSyncLock, SYNC_LOCK_KEY } = require("../aggregation/sync-lock");
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
