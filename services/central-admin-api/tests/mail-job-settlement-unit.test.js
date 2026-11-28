"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMailJobRepository } = require("../src/modules/mail/jobs/mail-job.repository");
function fixture({ rejectEvent = false, stale = false } = {}) {
  const state = { job: "LEASED", event: "RECEIVED" };
  const client = { async $transaction(run) {
    const pending = { ...state };
    const result = await run({
      mailOutboxJob: { async updateMany({ data }) { if (stale) return { count: 0 }; pending.job = data.status; return { count: 1 }; } },
      mailWebhookEvent: { async updateMany({ data }) { if (rejectEvent) throw new Error("event update failed"); pending.event = data.status; return { count: 1 }; } },
    });
    Object.assign(state, pending);
    return result;
  } };
  return { state, jobs: createMailJobRepository({ client }), job: { id: "job", webhookEventId: "event", leaseOwner: "lease", attemptCount: 1, maxAttempts: 2 } };
}
test("success and terminal failure settle job and event together", async () => {
  const success = fixture();
  assert.equal(await success.jobs.complete(success.job), true);
  assert.deepEqual(success.state, { job: "SUCCEEDED", event: "PROCESSED" });
  const failure = fixture();
  assert.deepEqual(await failure.jobs.fail(failure.job, { code: "FAIL", retryable: false }), { updated: true, status: "FAILED" });
  assert.deepEqual(failure.state, { job: "FAILED", event: "FAILED" });
});
test("event settlement failure rolls back terminal job; stale leases cannot settle events", async () => {
  for (const operation of ["complete", "fail"]) {
    const broken = fixture({ rejectEvent: true });
    await assert.rejects(operation === "complete" ? broken.jobs.complete(broken.job) : broken.jobs.fail(broken.job, { code: "FAIL", retryable: false }), /event update failed/);
    assert.deepEqual(broken.state, { job: "LEASED", event: "RECEIVED" });
    const stale = fixture({ stale: true });
    const result = operation === "complete" ? await stale.jobs.complete(stale.job) : await stale.jobs.fail(stale.job, { code: "FAIL", retryable: false });
    assert.equal(operation === "complete" ? result : result.updated, false);
    assert.deepEqual(stale.state, { job: "LEASED", event: "RECEIVED" });
  }
});
