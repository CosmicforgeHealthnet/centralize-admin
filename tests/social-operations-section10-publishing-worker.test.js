const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  executePublishingJob,
} = require("../src/modules/marketing/social-operations/services/publication-execution.service");

function makeDb({ provider = "META", jobOverrides = {}, connectionOverrides = {} } = {}) {
  const updates = { jobs: [], publications: [], attempts: [] };
  const post = { id: "post-1", currentVersion: 1 };
  const identity = {
    id: "identity-1",
    connectionId: "conn-1",
    disabledAt: null,
    type: provider === "TIKTOK" ? "TIKTOK_ACCOUNT" : "FACEBOOK_PAGE",
    connection: {
      id: "conn-1",
      provider,
      status: "ACTIVE",
      requiresReauthorization: false,
      ...connectionOverrides,
    },
  };
  const publication = {
    id: "pub-1",
    targetId: "target-1",
    postVersion: 1,
    idempotencyKey: "stable-key",
    status: "PENDING",
    target: {
      id: "target-1",
      postId: "post-1",
      identityId: "identity-1",
      text: "fresh text",
      post,
      identity,
      media: [{ asset: { id: "asset-1", url: "about:blank" } }],
    },
  };
  const job = {
    id: "job-1",
    publicationId: "pub-1",
    status: "CLAIMED",
    attemptCount: 0,
    maxAttempts: 6,
    publication,
    ...jobOverrides,
  };

  const db = {
    updates,
    socialPublishingJob: {
      async findUnique() {
        return job;
      },
      async update({ data }) {
        updates.jobs.push(data);
        Object.assign(job, data);
        return job;
      },
    },
    socialPublication: {
      async update({ data }) {
        updates.publications.push(data);
        Object.assign(publication, data);
        return publication;
      },
    },
    socialPublicationAttempt: {
      async create({ data }) {
        updates.attempts.push(data);
        return data;
      },
    },
    socialPostApproval: {
      async findFirst() {
        return { revision: { id: "rev-1", postId: "post-1", version: 1 } };
      },
    },
    socialPostRevision: {
      async findFirst() {
        return { id: "rev-1", postId: "post-1", version: 1 };
      },
    },
    socialOperationsSetting: {
      async findMany() {
        return [];
      },
    },
  };

  return { db, job, publication, identity, updates };
}

function noHeartbeat() {
  return { stop: async () => {} };
}

test("publishing worker uploads media then publishes with stable idempotency key", async () => {
  const { db, updates } = makeDb();
  const calls = [];
  const connector = {
    async getCapabilities() {
      return { publishPost: { status: "AVAILABLE", reason: null } };
    },
    async uploadMedia() {
      calls.push("uploadMedia");
      return { providerMediaId: "media-1" };
    },
    async publishPost({ idempotencyKey }) {
      calls.push(`publishPost:${idempotencyKey}`);
      return {
        providerPostId: "provider-1",
        url: "https://example.test/post",
        status: "PUBLISHED",
        confirmed: true,
      };
    },
  };

  const result = await executePublishingJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(calls, ["uploadMedia", "publishPost:stable-key"]);
  assert.equal(updates.attempts.length, 1);
  assert.equal(updates.publications.at(-1).status, "PUBLISHED");
  assert.equal(updates.jobs.at(-1).status, "SUCCEEDED");
});

test("permanent publishing validation failure fails publication without retry", async () => {
  const { db, updates } = makeDb({ connectionOverrides: { status: "DISABLED" } });
  let providerCalled = false;
  const connector = {
    async getCapabilities() {
      return { publishPost: { status: "AVAILABLE", reason: null } };
    },
    async uploadMedia() {
      providerCalled = true;
    },
    async publishPost() {
      providerCalled = true;
    },
  };

  const result = await executePublishingJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
  });

  assert.equal(result.permanent, true);
  assert.equal(providerCalled, false);
  assert.equal(updates.publications.at(-1).status, "FAILED_PERMANENT");
  assert.equal(updates.jobs.at(-1).status, "FAILED");
});

test("transient publishing failure schedules retry before max attempts", async () => {
  const { db, updates } = makeDb();
  const connector = {
    async getCapabilities() {
      return { publishPost: { status: "AVAILABLE", reason: null } };
    },
    async uploadMedia() {
      return {};
    },
    async publishPost() {
      throw Object.assign(new Error("network timeout"), { retryable: true });
    },
  };

  const result = await executePublishingJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
    random: () => 0.5,
  });

  assert.equal(result.status, "RETRY_SCHEDULED");
  assert.equal(updates.publications.at(-1).status, "FAILED_RETRYABLE");
  assert.equal(updates.jobs.at(-1).status, "RETRY_SCHEDULED");
  assert.ok(updates.jobs.at(-1).nextAttemptAt);
});

test("max attempts fail permanently without DEAD_LETTER", async () => {
  const { db, updates } = makeDb({ jobOverrides: { attemptCount: 5, maxAttempts: 6 } });
  const connector = {
    async getCapabilities() {
      return { publishPost: { status: "AVAILABLE", reason: null } };
    },
    async uploadMedia() {
      return {};
    },
    async publishPost() {
      throw Object.assign(new Error("timeout"), { retryable: true });
    },
  };

  await executePublishingJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
  });

  assert.equal(updates.jobs.at(-1).status, "FAILED");
  assert.equal(updates.jobs.at(-1).lastErrorCategory, "RETRYABLE_EXHAUSTED");
  assert.notEqual(updates.jobs.at(-1).status, "DEAD_LETTER");
  assert.equal(updates.publications.at(-1).status, "FAILED_PERMANENT");
});

test("TikTok upload-to-draft maps to AWAITING_USER_ACTION, not PUBLISHED", async () => {
  const { db, updates } = makeDb({ provider: "TIKTOK" });
  const connector = {
    async getCapabilities() {
      return { publishPost: { status: "AVAILABLE", reason: null } };
    },
    async uploadMedia() {
      return {};
    },
    async publishPost() {
      return {
        postingMode: "UPLOAD_TO_DRAFT",
        providerPostId: "draft-1",
        url: null,
      };
    },
  };

  await executePublishingJob({
    jobId: "job-1",
    workerId: "worker",
    db,
    connectorResolver: () => connector,
    heartbeatFactory: noHeartbeat,
  });

  assert.equal(updates.publications.at(-1).status, "AWAITING_USER_ACTION");
  assert.notEqual(updates.publications.at(-1).status, "PUBLISHED");
});

