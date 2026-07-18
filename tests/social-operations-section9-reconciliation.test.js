const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  socialReconciliationEnabled,
  reconciliationStatus,
  enqueueContentSync,
  updateIdentitySyncCheckpoint,
  runReconciliationOnce,
} = require("../src/modules/marketing/social-operations/services/reconciliation.service");

test("reconciliation is disabled by default and makes no provider calls", async () => {
  const previous = process.env.SOCIAL_RECONCILIATION_ENABLED;
  delete process.env.SOCIAL_RECONCILIATION_ENABLED;
  assert.equal(socialReconciliationEnabled(), false);
  assert.deepEqual(reconciliationStatus(), {
    enabled: false,
    providerPollingOnStartup: false,
  });

  const result = await runReconciliationOnce({
    db: {
      socialIdentitySyncState: {
        async findMany() {
          throw new Error("should not query when disabled");
        },
      },
    },
  });
  assert.equal(result.providerCallsMade, 0);
  assert.equal(result.enabled, false);
  if (previous !== undefined) process.env.SOCIAL_RECONCILIATION_ENABLED = previous;
});

test("content sync route foundation enqueues a SYNC_PROVIDER_CONTENT job only", async () => {
  const calls = [];
  const db = {
    socialPublishingIdentity: {
      async findUnique({ where }) {
        calls.push(["findIdentity", where.id]);
        return { id: where.id };
      },
    },
    socialIdentitySyncState: {
      async upsert({ where, create }) {
        calls.push(["syncState", where.identityId]);
        return create;
      },
    },
    socialActionJob: {
      async upsert({ create }) {
        calls.push(["job", create.jobType]);
        return { id: "job-1", ...create };
      },
    },
  };

  const job = await enqueueContentSync({
    identityId: "11111111-1111-4111-8111-111111111111",
    requestedById: "admin-1",
    db,
  });

  assert.equal(job.jobType, "SYNC_PROVIDER_CONTENT");
  assert.equal(job.status, "PENDING");
  assert.deepEqual(calls.map((call) => call[0]), ["findIdentity", "syncState", "job"]);
});

test("identity sync checkpoints are durable per identity and scope", async () => {
  const writes = [];
  const db = {
    socialIdentitySyncState: {
      async upsert(args) {
        writes.push(args);
        return args.create || args.update;
      },
    },
  };

  await updateIdentitySyncCheckpoint({
    identityId: "identity-1",
    scope: "content",
    cursor: "cursor-1",
    syncedAt: new Date("2026-07-16T00:00:00Z"),
    db,
  });

  assert.equal(writes[0].where.identityId, "identity-1");
  assert.equal(writes[0].update.contentCursor, "cursor-1");
  assert.equal(writes[0].update.lastContentSync.toISOString(), "2026-07-16T00:00:00.000Z");
});

