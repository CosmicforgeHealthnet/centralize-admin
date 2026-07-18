const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  executePublishingJob,
} = require("../src/modules/marketing/social-operations/services/publication-execution.service");
const {
  executeActionJob,
} = require("../src/modules/marketing/social-operations/services/action-execution.service");
const {
  applyNormalizedWebhookEvent,
} = require("../src/modules/marketing/social-operations/services/webhook-processing.service");
const {
  clearPublishedSocialEvents,
  listPublishedSocialEvents,
} = require("../src/modules/marketing/social-operations/services/social-domain-events.service");
const {
  pollPublicationIdempotencyKey,
} = require("../src/modules/marketing/social-operations/services/publication-status-transition.service");
const {
  recoverExpiredLeasesInMemory,
  buildRecoverExpiredLeasesSql,
} = require("../src/modules/marketing/social-operations/workers/lease.service");

function applyUpdate(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && Object.hasOwn(value, "increment")) {
      row[key] = (row[key] || 0) + value.increment;
    } else {
      row[key] = value;
    }
  }
  return row;
}

function makePublishingFixture({ provider = "META", publishResult }) {
  const updates = { publications: [], jobs: [], attempts: [], actionJobs: [] };
  const post = { id: "post-1", currentVersion: 1 };
  const identity = {
    id: "identity-1",
    connectionId: "connection-1",
    disabledAt: null,
    type: provider === "TIKTOK" ? "TIKTOK_ACCOUNT" : "FACEBOOK_PAGE",
    connection: {
      id: "connection-1",
      provider,
      status: "ACTIVE",
      requiresReauthorization: false,
    },
  };
  const publication = {
    id: "publication-1",
    targetId: "target-1",
    postVersion: 1,
    idempotencyKey: "publish-key",
    status: "PENDING",
    publishedAt: null,
    postingMode: "DIRECT_POST",
    target: {
      id: "target-1",
      postId: post.id,
      identityId: identity.id,
      post,
      identity,
      media: [],
    },
  };
  const job = {
    id: "publishing-job-1",
    publicationId: publication.id,
    publication,
    status: "CLAIMED",
    attemptCount: 0,
    maxAttempts: 6,
  };
  const actionJobs = [];

  const db = {
    socialPublishingJob: {
      async findUnique() {
        return job;
      },
      async update({ data }) {
        updates.jobs.push(data);
        return applyUpdate(job, data);
      },
    },
    socialPublication: {
      async update({ data }) {
        updates.publications.push(data);
        return applyUpdate(publication, data);
      },
      async updateMany({ where, data }) {
        if (where.status?.not && publication.status === where.status.not) return { count: 0 };
        updates.publications.push(data);
        applyUpdate(publication, data);
        return { count: 1 };
      },
    },
    socialPublicationAttempt: {
      async create({ data }) {
        updates.attempts.push(data);
        return data;
      },
    },
    socialActionJob: {
      async findUnique({ where }) {
        return actionJobs.find((row) => row.idempotencyKey === where.idempotencyKey) || null;
      },
      async create({ data }) {
        const row = { id: `action-${actionJobs.length + 1}`, ...data };
        actionJobs.push(row);
        updates.actionJobs.push({ op: "create", data });
        return row;
      },
      async update({ where, data }) {
        const row = actionJobs.find((item) => item.id === where.id);
        updates.actionJobs.push({ op: "update", data });
        return applyUpdate(row, data);
      },
      async updateMany({ data }) {
        updates.actionJobs.push({ op: "updateMany", data });
        return { count: 0 };
      },
    },
    socialPostApproval: {
      async findFirst() {
        return { revision: { id: "revision-1", postId: post.id, version: 1 } };
      },
    },
    socialPostRevision: {
      async findFirst() {
        return { id: "revision-1", postId: post.id, version: 1 };
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
      return { publishPost: { status: "AVAILABLE", reason: null } };
    },
    async uploadMedia() {
      return {};
    },
    async publishPost() {
      return publishResult;
    },
  };

  return { db, connector, updates, publication, actionJobs };
}

async function runPublishingFixture(fixture) {
  return executePublishingJob({
    jobId: "publishing-job-1",
    workerId: "worker",
    db: fixture.db,
    connectorResolver: () => fixture.connector,
    heartbeatFactory: () => ({ stop: async () => {} }),
    random: () => 0.5,
  });
}

function makePollFixture({ publicationStatus = "PROCESSING", providerResult }) {
  const updates = { publications: [], jobs: [], attempts: [], providerCalls: 0 };
  const identity = {
    id: "identity-1",
    disabledAt: null,
    syncState: {},
    connection: {
      id: "connection-1",
      provider: "META",
      status: "ACTIVE",
      requiresReauthorization: false,
    },
  };
  const publication = {
    id: "publication-1",
    providerPostId: "provider-post-1",
    url: null,
    postingMode: "DIRECT_POST",
    status: publicationStatus,
    publishedAt: null,
    target: { identityId: identity.id, identity },
  };
  const job = {
    id: "poll-job-1",
    jobType: "POLL_PUBLICATION",
    status: "CLAIMED",
    identityId: identity.id,
    publicationId: publication.id,
    publication,
    identity,
    attemptCount: 0,
    maxAttempts: 6,
  };

  const db = {
    socialActionJob: {
      async findUnique() {
        return job;
      },
      async update({ data }) {
        updates.jobs.push(data);
        return applyUpdate(job, data);
      },
    },
    socialActionAttempt: {
      async create({ data }) {
        updates.attempts.push(data);
        return data;
      },
    },
    socialPublication: {
      async update({ data }) {
        updates.publications.push(data);
        return applyUpdate(publication, data);
      },
      async updateMany({ where, data }) {
        if (where.status?.not && publication.status === where.status.not) return { count: 0 };
        updates.publications.push(data);
        applyUpdate(publication, data);
        return { count: 1 };
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
      return { getPublishStatus: { status: "AVAILABLE", reason: null } };
    },
    async getPublishStatus() {
      updates.providerCalls += 1;
      if (providerResult instanceof Error) throw providerResult;
      return providerResult;
    },
  };

  return { db, connector, updates, publication, job };
}

async function runPollFixture(fixture) {
  return executeActionJob({
    jobId: "poll-job-1",
    workerId: "worker",
    db: fixture.db,
    connectorResolver: () => fixture.connector,
    heartbeatFactory: () => ({ stop: async () => {} }),
    random: () => 0.5,
  });
}

function makeWebhookFixture({ publicationStatus = "PROCESSING" } = {}) {
  const updates = { publications: [], actionJobs: [] };
  const identity = {
    id: "identity-1",
    providerIdentityId: "page-1",
    connection: { id: "connection-1", provider: "META" },
  };
  const publication = {
    id: "publication-1",
    providerPostId: "provider-post-1",
    status: publicationStatus,
    publishedAt: null,
    url: null,
    postingMode: "DIRECT_POST",
    target: { identityId: identity.id, identity },
  };
  const actionJobs = [
    {
      id: "poll-job-1",
      jobType: "POLL_PUBLICATION",
      publicationId: publication.id,
      status: "RETRY_SCHEDULED",
    },
  ];
  const db = {
    socialPublishingIdentity: {
      async findFirst() {
        return identity;
      },
    },
    socialPublication: {
      async findMany() {
        return [publication];
      },
      async update({ data }) {
        updates.publications.push(data);
        return applyUpdate(publication, data);
      },
      async updateMany({ where, data }) {
        if (where.status?.not && publication.status === where.status.not) return { count: 0 };
        updates.publications.push(data);
        applyUpdate(publication, data);
        return { count: 1 };
      },
    },
    socialActionJob: {
      async findUnique({ where }) {
        return actionJobs.find((row) => row.idempotencyKey === where.idempotencyKey) || null;
      },
      async create({ data }) {
        const row = { id: `action-${actionJobs.length + 1}`, ...data };
        actionJobs.push(row);
        updates.actionJobs.push({ op: "create", data });
        return row;
      },
      async update({ where, data }) {
        const row = actionJobs.find((item) => item.id === where.id);
        updates.actionJobs.push({ op: "update", data });
        return applyUpdate(row, data);
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of actionJobs) {
          const statusMatch = where.status?.in?.includes(row.status);
          if (row.publicationId === where.publicationId && row.jobType === where.jobType && statusMatch) {
            applyUpdate(row, data);
            count += 1;
          }
        }
        updates.actionJobs.push({ op: "updateMany", data, count });
        return { count };
      },
    },
  };
  return { db, updates, publication, actionJobs };
}

test("non-terminal publish responses create exactly one sanitized poll job", async () => {
  clearPublishedSocialEvents();
  const processing = makePublishingFixture({
    publishResult: {
      providerPostId: "provider-processing",
      status: "PROCESSING",
      url: "https://example.test/processing",
    },
  });

  await runPublishingFixture(processing);
  await runPublishingFixture(processing);

  assert.equal(processing.publication.status, "PROCESSING");
  assert.equal(processing.publication.publishedAt, null);
  assert.equal(processing.updates.attempts.length, 2);
  assert.equal(processing.actionJobs.length, 1);
  assert.equal(processing.actionJobs[0].jobType, "POLL_PUBLICATION");
  assert.equal(processing.actionJobs[0].idempotencyKey, pollPublicationIdempotencyKey("publication-1"));
  assert.equal(processing.actionJobs[0].payloadJson.publicationId, "publication-1");
  assert.deepEqual(listPublishedSocialEvents(), []);

  const payload = JSON.stringify(processing.actionJobs[0].payloadJson);
  assert.doesNotMatch(payload, /token|credential|secret|message|comment|raw/i);
});

test("awaiting user action creates one poll job and published response creates none", async () => {
  clearPublishedSocialEvents();
  const awaiting = makePublishingFixture({
    provider: "TIKTOK",
    publishResult: {
      providerPostId: "draft-1",
      postingMode: "UPLOAD_TO_DRAFT",
    },
  });
  await runPublishingFixture(awaiting);

  assert.equal(awaiting.publication.status, "AWAITING_USER_ACTION");
  assert.equal(awaiting.publication.publishedAt, null);
  assert.equal(awaiting.actionJobs.length, 1);
  assert.deepEqual(listPublishedSocialEvents(), []);

  const published = makePublishingFixture({
    publishResult: {
      providerPostId: "provider-published",
      status: "PUBLISHED",
      confirmed: true,
    },
  });
  await runPublishingFixture(published);
  assert.equal(published.publication.status, "PUBLISHED");
  assert.ok(published.publication.publishedAt);
  assert.equal(published.actionJobs.length, 0);
  assert.equal(listPublishedSocialEvents().length, 1);
});

test("poll execution reschedules non-terminal provider states and records attempts", async () => {
  const processing = makePollFixture({
    providerResult: { providerPostId: "provider-post-1", status: "PROCESSING" },
  });
  await runPollFixture(processing);
  assert.equal(processing.publication.status, "PROCESSING");
  assert.equal(processing.updates.jobs.at(-1).status, "RETRY_SCHEDULED");
  assert.ok(processing.updates.jobs.at(-1).nextAttemptAt);
  assert.equal(processing.updates.attempts.length, 1);

  const awaiting = makePollFixture({
    publicationStatus: "AWAITING_USER_ACTION",
    providerResult: { providerPostId: "provider-post-1", status: "AWAITING_USER_ACTION" },
  });
  await runPollFixture(awaiting);
  assert.equal(awaiting.publication.status, "AWAITING_USER_ACTION");
  assert.equal(awaiting.updates.jobs.at(-1).status, "RETRY_SCHEDULED");
  assert.equal(awaiting.updates.attempts.length, 1);
});

test("poll confirmation publishes once and already-published polling makes no provider call", async () => {
  clearPublishedSocialEvents();
  const fixture = makePollFixture({
    providerResult: {
      providerPostId: "provider-post-1",
      status: "PUBLISHED",
      confirmed: true,
      publishedAt: "2026-07-16T12:00:00Z",
    },
  });
  await runPollFixture(fixture);
  assert.equal(fixture.publication.status, "PUBLISHED");
  assert.ok(fixture.publication.publishedAt);
  assert.equal(listPublishedSocialEvents().length, 1);
  assert.equal(fixture.updates.attempts.length, 1);

  fixture.connector.getPublishStatus = async () => {
    fixture.updates.providerCalls += 1;
    throw new Error("provider should not be called");
  };
  await runPollFixture(fixture);
  assert.equal(fixture.updates.providerCalls, 1);
  assert.equal(listPublishedSocialEvents().length, 1);
});

test("poll permanent and retryable failures use terminal or backoff action states", async () => {
  const permanent = makePollFixture({
    providerResult: { providerPostId: "provider-post-1", status: "FAILED_PERMANENT" },
  });
  await runPollFixture(permanent);
  assert.equal(permanent.publication.status, "FAILED_PERMANENT");
  assert.equal(permanent.updates.jobs.at(-1).status, "FAILED");
  assert.equal(permanent.updates.attempts.length, 1);

  const error = Object.assign(new Error("temporary provider timeout access_token=secret"), {
    retryable: true,
  });
  const retryable = makePollFixture({ providerResult: error });
  await runPollFixture(retryable);
  assert.equal(retryable.updates.jobs.at(-1).status, "RETRY_SCHEDULED");
  assert.ok(retryable.updates.jobs.at(-1).nextAttemptAt);
  assert.doesNotMatch(retryable.updates.jobs.at(-1).lastError, /secret/);
  assert.equal(retryable.updates.attempts.length, 1);
});

test("publication status webhooks use exactly-once publish transition behavior", async () => {
  clearPublishedSocialEvents();
  const fixture = makeWebhookFixture();
  const published = {
    kind: "PUBLICATION_STATUS",
    eventId: "webhook-1",
    identityProviderId: "page-1",
    data: {
      providerPostId: "provider-post-1",
      status: "PUBLISHED",
      publishedAt: "2026-07-16T12:00:00Z",
    },
  };

  await applyNormalizedWebhookEvent({ provider: "META", normalized: published, db: fixture.db });
  await applyNormalizedWebhookEvent({ provider: "META", normalized: published, db: fixture.db });

  assert.equal(fixture.publication.status, "PUBLISHED");
  assert.ok(fixture.publication.publishedAt);
  assert.equal(listPublishedSocialEvents().length, 1);
  assert.equal(fixture.actionJobs[0].status, "CANCELLED");

  const poll = makePollFixture({ publicationStatus: "PUBLISHED", providerResult: null });
  await runPollFixture(poll);
  assert.equal(listPublishedSocialEvents().length, 1);
});

test("non-terminal publication status webhooks preserve polling and emit no success", async () => {
  clearPublishedSocialEvents();
  const processing = makeWebhookFixture();
  await applyNormalizedWebhookEvent({
    provider: "META",
    normalized: {
      kind: "PUBLICATION_STATUS",
      eventId: "webhook-processing",
      identityProviderId: "page-1",
      data: { providerPostId: "provider-post-1", status: "PROCESSING" },
    },
    db: processing.db,
  });
  assert.equal(processing.publication.status, "PROCESSING");
  assert.equal(processing.publication.publishedAt, null);
  assert.equal(listPublishedSocialEvents().length, 0);
  assert.ok(processing.actionJobs.some((job) => job.jobType === "POLL_PUBLICATION"));

  const awaiting = makeWebhookFixture();
  await applyNormalizedWebhookEvent({
    provider: "META",
    normalized: {
      kind: "PUBLICATION_STATUS",
      eventId: "webhook-awaiting",
      identityProviderId: "page-1",
      data: { providerPostId: "provider-post-1", status: "AWAITING_USER_ACTION" },
    },
    db: awaiting.db,
  });
  assert.equal(awaiting.publication.status, "AWAITING_USER_ACTION");
  assert.equal(awaiting.publication.publishedAt, null);
  assert.equal(listPublishedSocialEvents().length, 0);
});

test("expired lease recovery clears owner, expiry and heartbeat only for active leases", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const jobs = [
    {
      id: "publishing-expired",
      status: "CLAIMED",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-07-16T11:59:00Z"),
      heartbeatAt: new Date("2026-07-16T11:58:00Z"),
    },
    {
      id: "action-expired",
      status: "RUNNING",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-07-16T11:59:00Z"),
      heartbeatAt: new Date("2026-07-16T11:58:00Z"),
    },
    {
      id: "active",
      status: "RUNNING",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-07-16T12:10:00Z"),
      heartbeatAt: new Date("2026-07-16T11:58:00Z"),
    },
    {
      id: "terminal",
      status: "SUCCEEDED",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-07-16T11:59:00Z"),
      heartbeatAt: new Date("2026-07-16T11:58:00Z"),
    },
  ];

  assert.equal(recoverExpiredLeasesInMemory({ jobs, now }), 2);
  assert.equal(jobs[0].leaseOwner, null);
  assert.equal(jobs[0].leaseExpiresAt, null);
  assert.equal(jobs[0].heartbeatAt, null);
  assert.equal(jobs[1].leaseOwner, null);
  assert.equal(jobs[1].leaseExpiresAt, null);
  assert.equal(jobs[1].heartbeatAt, null);
  assert.ok(jobs[2].heartbeatAt);
  assert.ok(jobs[3].heartbeatAt);
  assert.match(buildRecoverExpiredLeasesSql("publishing"), /heartbeat_at = NULL/);
  assert.match(buildRecoverExpiredLeasesSql("action"), /heartbeat_at = NULL/);
});
