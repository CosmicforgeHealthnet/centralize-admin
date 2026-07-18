const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getSocialOperationsHealth,
} = require("../src/modules/marketing/social-operations/observability/operations-health.service");
const {
  getSocialOperationGrant,
} = require("../src/modules/marketing/social-operations/governance/social-operations.rbac");

function compare(value, condition) {
  if (condition.lt !== undefined && !(new Date(value) < new Date(condition.lt))) return false;
  if (condition.lte !== undefined && !(new Date(value) <= new Date(condition.lte))) return false;
  if (condition.gt !== undefined && !(new Date(value) > new Date(condition.gt))) return false;
  if (condition.gte !== undefined && !(new Date(value) >= new Date(condition.gte))) return false;
  if (condition.in && !condition.in.includes(value)) return false;
  if (condition.not !== undefined && value === condition.not) return false;
  return true;
}

function matches(row, where = {}) {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!condition.some((nested) => matches(row, nested))) return false;
      continue;
    }
    if (key === "task" && condition?.is) {
      if (!matches(row.task || {}, condition.is)) return false;
      continue;
    }
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (!compare(row[key], condition)) return false;
    } else if (row[key] !== condition) {
      return false;
    }
  }
  return true;
}

function pick(row, select) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

function model(rows) {
  return {
    async count({ where } = {}) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async findMany({ where, select, take } = {}) {
      return rows.filter((row) => matches(row, where)).slice(0, take || rows.length).map((row) => pick(row, select));
    },
    async findFirst({ where, orderBy, select } = {}) {
      const filtered = rows.filter((row) => matches(row, where));
      const [[field, direction] = []] = Object.entries(orderBy || {});
      if (field) {
        filtered.sort((left, right) => {
          const delta = new Date(left[field]).getTime() - new Date(right[field]).getTime();
          return direction === "desc" ? -delta : delta;
        });
      }
      return filtered[0] ? pick(filtered[0], select) : null;
    },
    async groupBy({ by }) {
      const field = by[0];
      const counts = new Map();
      for (const row of rows) counts.set(row[field], (counts.get(row[field]) || 0) + 1);
      return [...counts.entries()].map(([status, count]) => ({
        [field]: status,
        _count: { _all: count },
      }));
    },
  };
}

function fakeDb(now) {
  const old = new Date(now.getTime() - 60 * 60 * 1000);
  const staleLease = new Date(now.getTime() - 5 * 60 * 1000);
  const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return {
    socialPublishingJob: model([
      { status: "PENDING", scheduledForUtc: old, attemptCount: 5, maxAttempts: 6 },
      { status: "RETRY_SCHEDULED", scheduledForUtc: now, attemptCount: 1, maxAttempts: 6 },
      { status: "CLAIMED", scheduledForUtc: now, attemptCount: 2, maxAttempts: 3, leaseExpiresAt: staleLease },
      { status: "FAILED", scheduledForUtc: now, attemptCount: 6, maxAttempts: 6 },
    ]),
    socialActionJob: model([
      { status: "RUNNING", scheduledForUtc: old, attemptCount: 1, maxAttempts: 6, leaseExpiresAt: staleLease },
      { status: "PENDING", scheduledForUtc: now, attemptCount: 0, maxAttempts: 6 },
    ]),
    socialWebhookEvent: model([
      { status: "RECEIVED", signatureValid: true, receivedAt: old },
      { status: "FAILED", signatureValid: false, receivedAt: now },
      { status: "IGNORED_DUPLICATE", signatureValid: true, receivedAt: now },
    ]),
    socialAccountConnection: model([
      { accessTokenExpiresAt: old, refreshTokenExpiresAt: future, requiresReauthorization: true },
      { accessTokenExpiresAt: future, refreshTokenExpiresAt: future, requiresReauthorization: false },
    ]),
    socialWebhookSubscription: model([{ status: "DEGRADED" }, { status: "ACTIVE" }]),
    socialMessage: model([
      { sensitiveDataState: "CONFIRMED", redactedAt: null, content: "private message" },
    ]),
    socialComment: model([
      { sensitiveDataState: "FLAGGED", redactedAt: null, text: "private comment" },
    ]),
    socialInternalNote: model([
      { sensitiveDataState: "CONFIRMED", redactedAt: null, text: "private note" },
    ]),
    socialEscalation: model([
      {
        status: "DETECTED",
        classification: "MEDICAL_EMERGENCY",
        restrictedVisibility: true,
        taskId: null,
        detectedAt: old,
      },
      {
        status: "CONFIRMED",
        classification: "SELF_HARM_RISK",
        restrictedVisibility: true,
        taskId: "task-1",
        task: { assigneeId: null },
        detectedAt: now,
      },
      {
        status: "CONFIRMED",
        classification: "PRIVACY_INCIDENT",
        restrictedVisibility: true,
        taskId: "task-2",
        task: { assigneeId: "admin-1" },
        detectedAt: now,
      },
    ]),
  };
}

test("operations health returns aggregate queue, webhook, privacy, connection and HealthNet metrics", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const health = await getSocialOperationsHealth({
    db: fakeDb(now),
    env: {
      SOCIAL_PHASE_D_ENABLED: "false",
      SOCIAL_INBOX_ENABLED: "false",
      SOCIAL_REDACTION_WORKER_ENABLED: "false",
    },
    now,
  });
  assert.equal(health.publishingQueue.pendingCount, 1);
  assert.equal(health.publishingQueue.failedCount, 1);
  assert.equal(health.publishingQueue.nearMaxAttemptsCount, 2);
  assert.equal(health.publishingQueue.oldestPendingAgeSeconds, 3600);
  assert.equal(health.actionQueue.runningCount, 1);
  assert.equal(health.webhooks.invalidSignatureCount, 1);
  assert.equal(health.webhooks.duplicateEventCount, 1);
  assert.equal(health.connections.expiredCredentialCount, 1);
  assert.equal(health.connections.requiresReauthorizationCount, 1);
  assert.equal(health.privacy.phaseDEnabled, false);
  assert.equal(health.privacy.recordsAwaitingApprovedRedaction.messages, 1);
  assert.equal(health.healthNet.unresolvedEmergencyCount, 1);
  assert.equal(health.healthNet.unresolvedSelfHarmCount, 1);
  assert.equal(health.healthNet.unassignedSafetyTaskCount, 2);
  assert.equal(health.healthNet.oldestUnresolvedSafetyEscalationAgeSeconds, 3600);
  const serialized = JSON.stringify(health);
  assert.equal(serialized.includes("private message"), false);
  assert.equal(serialized.includes("private comment"), false);
  assert.equal(/accessToken|refreshToken|Bearer|secret-value/i.test(serialized), false);
});

test("one metric failure returns a safe unavailable marker without private details", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const db = fakeDb(now);
  db.socialWebhookEvent = {
    async groupBy() {
      throw new Error("private stack with token abc");
    },
  };
  const health = await getSocialOperationsHealth({ db, now });
  assert.equal(health.webhooks.available, false);
  assert.equal(health.webhooks.error, "METRIC_UNAVAILABLE");
  assert.equal(JSON.stringify(health).includes("abc"), false);
  assert.equal(health.publishingQueue.available, true);
});

test("operations health route is authenticated and tied to social_operations VIEW", async () => {
  const grant = getSocialOperationGrant("OPERATIONS_VIEW");
  assert.deepEqual(grant, {
    module: "marketing",
    section: "social_operations",
    mode: "VIEW",
  });
});

let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = "test";
  const app = require("../src/app");
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("operations health endpoint returns 401 without authentication", async () => {
  const response = await fetch(`${baseUrl}/api/v1/marketing/social/operations/health`);
  assert.equal(response.status, 401);
});
