const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  assertIanaTimezone,
  workerShouldRunScheduledJob,
  cancelPendingPublishingJobsForPostEdit,
  assertJobCancellable,
} = require("../src/modules/marketing/social-operations/services/scheduling.service");

test("SocialPostTarget scheduling uses UTC comparison and IANA timezones", () => {
  assert.equal(assertIanaTimezone("Africa/Lagos"), "Africa/Lagos");
  assert.equal(
    workerShouldRunScheduledJob({
      scheduledForUtc: "2026-07-16T09:00:00Z",
      now: new Date("2026-07-16T09:00:01Z"),
    }),
    true,
  );
  assert.equal(
    workerShouldRunScheduledJob({
      scheduledForUtc: "2026-07-16T09:00:00Z",
      now: new Date("2026-07-16T08:59:59Z"),
    }),
    false,
  );
  assert.throws(() => assertIanaTimezone("Not/AZone"), /IANA/);
});

test("edit after approval cancels only pending or retry-scheduled publishing jobs", async () => {
  const calls = [];
  const db = {
    socialPublishingJob: {
      async findMany({ where }) {
        calls.push(where.status.in);
        return [{ id: "pending" }, { id: "retry" }];
      },
      async updateMany({ where, data }) {
        calls.push(where.id.in);
        calls.push(data.status);
        return { count: where.id.in.length };
      },
    },
  };

  const result = await cancelPendingPublishingJobsForPostEdit({ postId: "post-1", db });
  assert.equal(result.cancelled, 2);
  assert.deepEqual(calls[0], ["PENDING", "RETRY_SCHEDULED"]);
  assert.deepEqual(calls[1], ["pending", "retry"]);
  assert.equal(calls[2], "CANCELLED");
});

test("cancellation is direct only for PENDING and RETRY_SCHEDULED jobs", () => {
  assert.equal(assertJobCancellable({ status: "PENDING" }), true);
  assert.equal(assertJobCancellable({ status: "RETRY_SCHEDULED" }), true);
  assert.throws(() => assertJobCancellable({ status: "CLAIMED" }), /delete flow/);
  assert.throws(() => assertJobCancellable({ status: "RUNNING" }), /delete flow/);
});

test("DST ambiguity is documented for UI reconfirmation", () => {
  const doc = require("node:fs").readFileSync(
    require("node:path").resolve(__dirname, "../docs/social-operations-sections-10-11.md"),
    "utf8",
  );
  assert.match(doc, /DST/i);
  assert.match(doc, /UI/i);
});

