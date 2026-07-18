const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  recoverExpiredLeasesInMemory,
  claimDueJobsInMemory,
  buildClaimDueJobsSql,
  recoverThenClaim,
} = require("../src/modules/marketing/social-operations/workers/lease.service");
const {
  runPublishingWorkerOnce,
} = require("../src/modules/marketing/social-operations/workers/publishing.worker");

test("expired publishing and action leases recover to RETRY_SCHEDULED", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const jobs = [
    { id: "pub-1", status: "CLAIMED", leaseExpiresAt: new Date("2026-07-16T11:59:00Z") },
    { id: "act-1", status: "RUNNING", leaseExpiresAt: new Date("2026-07-16T11:59:00Z") },
    { id: "future", status: "RUNNING", leaseExpiresAt: new Date("2026-07-16T12:10:00Z") },
  ];

  assert.equal(recoverExpiredLeasesInMemory({ jobs, now }), 2);
  assert.equal(jobs[0].status, "RETRY_SCHEDULED");
  assert.equal(jobs[1].status, "RETRY_SCHEDULED");
  assert.equal(jobs[2].status, "RUNNING");
});

test("claim selects only due PENDING/RETRY_SCHEDULED jobs in priority and schedule order", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const jobs = [
    { id: "future-schedule", status: "PENDING", priority: 99, scheduledForUtc: "2026-07-16T13:00:00Z" },
    { id: "future-retry", status: "RETRY_SCHEDULED", priority: 99, scheduledForUtc: "2026-07-16T11:00:00Z", nextAttemptAt: "2026-07-16T13:00:00Z" },
    { id: "running", status: "RUNNING", priority: 99, scheduledForUtc: "2026-07-16T11:00:00Z" },
    { id: "second", status: "PENDING", priority: 5, scheduledForUtc: "2026-07-16T10:00:00Z" },
    { id: "first", status: "RETRY_SCHEDULED", priority: 10, scheduledForUtc: "2026-07-16T11:00:00Z" },
  ];

  const claimed = claimDueJobsInMemory({
    jobs,
    workerId: "worker-1",
    limit: 2,
    now,
    leaseDurationMs: 60_000,
  });

  assert.deepEqual(claimed.map((job) => job.id), ["first", "second"]);
  assert.equal(jobs.find((job) => job.id === "first").leaseOwner, "worker-1");
  assert.ok(jobs.find((job) => job.id === "first").leaseExpiresAt);
});

test("claim SQL uses FOR UPDATE SKIP LOCKED against both queues", () => {
  assert.match(buildClaimDueJobsSql("publishing"), /FOR UPDATE SKIP LOCKED/);
  assert.match(buildClaimDueJobsSql("action"), /FOR UPDATE SKIP LOCKED/);
  assert.match(buildClaimDueJobsSql("publishing"), /PENDING', 'RETRY_SCHEDULED/);
});

test("publishing and action queues use the same recover-then-claim utility", async () => {
  const db = {
    __leaseMemory: {
      publishing: [
        { id: "p1", status: "PENDING", priority: 0, scheduledForUtc: new Date("2026-07-16T11:00:00Z") },
      ],
      action: [
        { id: "a1", status: "PENDING", priority: 0, scheduledForUtc: new Date("2026-07-16T11:00:00Z") },
      ],
    },
  };

  const publishing = await recoverThenClaim({ queue: "publishing", workerId: "w", db });
  const action = await recoverThenClaim({ queue: "action", workerId: "w", db });
  assert.equal(publishing[0].id, "p1");
  assert.equal(action[0].id, "a1");
});

test("provider I/O runs after the claim utility returns", async () => {
  const calls = [];
  const db = {
    __leaseMemory: {
      publishing: [
        { id: "p1", status: "PENDING", priority: 0, scheduledForUtc: new Date("2026-07-16T11:00:00Z") },
      ],
    },
  };

  await runPublishingWorkerOnce({
    workerId: "w",
    db,
    executor: async ({ jobId }) => {
      calls.push(`provider-io:${jobId}`);
      assert.equal(db.__leaseMemory.publishing[0].status, "CLAIMED");
      return { status: "SUCCEEDED" };
    },
  });

  assert.deepEqual(calls, ["provider-io:p1"]);
});

