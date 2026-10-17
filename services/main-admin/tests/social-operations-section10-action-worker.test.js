const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  executeActionJob,
} = require("../src/modules/marketing/social-operations/services/action-execution.service");
const {
  runActionWorkerOnce,
} = require("../src/modules/marketing/social-operations/workers/action.worker");

function makeActionDb({ jobType = "SEND_MESSAGE", capabilityStatus = "AVAILABLE" } = {}) {
  const updates = { jobs: [], attempts: [] };
  const job = {
    id: "job-1",
    jobType,
    status: "CLAIMED",
    attemptCount: 0,
    maxAttempts: 6,
    identityId: "identity-1",
    payloadJson: { text: "stale payload text" },
    identity: {
      id: "identity-1",
      disabledAt: null,
      syncState: {},
      connection: {
        id: "conn-1",
        provider: "META",
        status: "ACTIVE",
        requiresReauthorization: false,
      },
    },
    message: {
      id: "message-1",
      conversationId: "conversation-1",
      content: "fresh message text",
      type: "TEXT",
    },
    comment: {
      id: "comment-1",
      providerCommentId: "provider-comment-1",
      text: "fresh comment text",
      parent: { providerCommentId: "parent-provider-comment" },
      providerContent: { id: "content-1" },
    },
  };

  const db = {
    updates,
    socialActionJob: {
      async findUnique() {
        return job;
      },
      async update({ data }) {
        updates.jobs.push(data);
        Object.assign(job, data);
        return job;
      },
    },
    socialActionAttempt: {
      async create({ data }) {
        updates.attempts.push(data);
        return data;
      },
    },
    socialOperationsSetting: {
      async findMany() {
        return [];
      },
    },
  };

  const connector = {
    async getCapabilities() {
      return {
        sendMessage: { status: capabilityStatus, reason: capabilityStatus === "AVAILABLE" ? null : "PROVIDER_API_NOT_AVAILABLE" },
        replyToComment: { status: capabilityStatus, reason: capabilityStatus === "AVAILABLE" ? null : "PROVIDER_API_NOT_AVAILABLE" },
        moderateComment: { status: capabilityStatus, reason: capabilityStatus === "AVAILABLE" ? null : "PROVIDER_API_NOT_AVAILABLE" },
      };
    },
    async sendMessage({ message }) {
      updates.sentMessage = message.text;
      return { ok: true };
    },
    async replyToComment({ text }) {
      updates.commentReply = text;
      return { ok: true };
    },
    async moderateComment({ action }) {
      updates.moderation = action;
      return { ok: true };
    },
  };

  return { db, job, connector, updates };
}

function noHeartbeat() {
  return { stop: async () => {} };
}

test("action worker reads fresh message content and ignores stale payload", async () => {
  const { db, connector, updates } = makeActionDb({ jobType: "SEND_MESSAGE" });

  const result = await executeActionJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(updates.sentMessage, "fresh message text");
  assert.notEqual(updates.sentMessage, "stale payload text");
  assert.equal(updates.attempts.length, 1);
});

test("native-only action capability fails permanently and is not retried", async () => {
  const { db, connector, updates } = makeActionDb({
    jobType: "REPLY_COMMENT",
    capabilityStatus: "NATIVE_ONLY",
  });

  const result = await executeActionJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
  });

  assert.equal(result.status, "FAILED");
  assert.equal(updates.jobs.at(-1).status, "FAILED");
  assert.equal(updates.jobs.at(-1).nextAttemptAt, null);
});

test("transient action failure retries independently", async () => {
  const { db, connector, updates } = makeActionDb({ jobType: "SEND_MESSAGE" });
  connector.sendMessage = async () => {
    throw Object.assign(new Error("temporary unavailable"), { retryable: true });
  };

  const result = await executeActionJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
    random: () => 0.5,
  });

  assert.equal(result.status, "RETRY_SCHEDULED");
  assert.equal(updates.jobs.at(-1).status, "RETRY_SCHEDULED");
  assert.ok(updates.jobs.at(-1).nextAttemptAt);
});

test("one stuck action job does not block unrelated jobs", async () => {
  const processed = [];
  const db = {
    __leaseMemory: {
      action: [
        { id: "stuck", status: "PENDING", priority: 10, scheduledForUtc: new Date("2026-07-16T11:00:00Z") },
        { id: "ok", status: "PENDING", priority: 1, scheduledForUtc: new Date("2026-07-16T11:00:00Z") },
      ],
    },
  };

  const result = await runActionWorkerOnce({
    workerId: "worker",
    db,
    executor: async ({ jobId }) => {
      processed.push(jobId);
      if (jobId === "stuck") throw new Error("stuck");
      return { status: "SUCCEEDED" };
    },
  });

  assert.equal(result.claimed, 2);
  assert.deepEqual(processed, ["stuck", "ok"]);
  assert.equal(result.results[0].status, "ERROR");
  assert.equal(result.results[1].status, "SUCCEEDED");
});
