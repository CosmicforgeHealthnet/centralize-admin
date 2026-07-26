"use strict";

// Section 29 — Queue and lease mandatory suite (claim, SKIP LOCKED, heartbeat,
// expiry recovery, shutdown). Multi-connection SKIP LOCKED, queue atomicity
// and cancellation are proven against real PostgreSQL in
// tests/advertising-execution-sections18-24-postgres.test.js and
// tests/advertising-execution-sections25-28-postgres.test.js; this suite
// exercises the complete eligibility, ownership and recovery semantics of the
// production repositories and worker with injected clients and clocks.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ExecutionJobRepository, boundedLimit, jobSubmissionIdentity } = require("../jobs/execution-job.repository");
const { createExecutionWorker } = require("../jobs/execution-worker");
const { createReconciliationWorker } = require("../jobs/reconciliation-worker");
const { assertQueuePacket } = require("../jobs/execution-queue.service");

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-23T10:00:00.000Z");

const ENABLED_ENV = Object.freeze({
  MARKETING_AD_EXECUTION_ENABLED: "true",
  MARKETING_AD_EXECUTION_DRY_RUN: "false",
  MARKETING_AD_EXECUTION_WORKER_ENABLED: "true",
  MARKETING_AD_EXECUTION_META_ENABLED: "true",
  MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0",
});

test("29-QUEUE claim SQL excludes ineligible states, disabled providers, stale packets and expired plans", async () => {
  let sql; let values;
  const client = { $transaction: (handler) => handler({ $queryRaw: async (query) => { sql = query.strings.join("?"); values = query.values; return []; } }) };
  const repository = new ExecutionJobRepository({ client, now: () => NOW });
  await repository.claimEligibleApproved({ leaseOwner: "worker-1", leaseSeconds: 60, limit: 5, enabledProviders: ["META", "TIKTOK"] });
  // Only PENDING/RETRY_SCHEDULED are claimable: DEAD_LETTER and CANCELLED can never match.
  assert.match(sql, /job\.status IN \('PENDING', 'RETRY_SCHEDULED'\)/);
  // Future retries are not claimed; due retries are.
  assert.match(sql, /job\.next_attempt_at IS NULL OR job\.next_attempt_at <=/);
  // Provider-disabled jobs are excluded through the enabled provider list.
  assert.match(sql, /job\.platform::text IN \(/);
  assert.ok(values.includes("META") && values.includes("TIKTOK"));
  // Stale fingerprints, versions and expired approvals never qualify.
  assert.match(sql, /run\.approved_plan_version = plan\.version/);
  assert.match(sql, /run\.approval_fingerprint = plan\.validation_fingerprint/);
  assert.match(sql, /plan\.expires_at IS NULL OR plan\.expires_at >/);
  assert.match(sql, /approval\.decision IN \('REJECTED', 'REVOKED'\)/);
  // Priority descending then createdAt ascending, bounded batch, SKIP LOCKED.
  assert.match(sql, /ORDER BY job\.priority DESC, job\.created_at ASC/);
  assert.match(sql, /FOR UPDATE OF job SKIP LOCKED LIMIT /);
  // One in-flight job per provider account: serialization subquery present.
  assert.match(sql, /active\.status IN \('CLAIMED', 'RUNNING'\)/);
});

test("29-QUEUE claim requires a lease owner, an enabled provider list and clamps batch size", async () => {
  const repository = new ExecutionJobRepository({ client: {}, now: () => NOW });
  await assert.rejects(repository.claimEligibleApproved({ leaseOwner: " ", enabledProviders: ["META"] }), (error) => error.errors[0].reasonCode === "LEASE_OWNER_REQUIRED");
  // Kill-switch semantics: with zero enabled providers no client call happens at all.
  assert.deepEqual(await repository.claimEligibleApproved({ leaseOwner: "worker-1", enabledProviders: [] }), []);
  assert.equal(boundedLimit(500, 20, 100), 100);
  assert.equal(boundedLimit(0, 20, 100), 20, "zero falls back to the default");
  assert.equal(boundedLimit(-3, 20, 100), 1, "negative limits clamp to the floor of one");
});

test("29-QUEUE eligible scan orders by priority, due time and age with a bounded window", async () => {
  let captured;
  const client = { marketingExecutionJob: { findMany: async (query) => { captured = query; return []; } } };
  await new ExecutionJobRepository({ client, now: () => NOW }).findEligible({ limit: 999 });
  assert.deepEqual(captured.where.status, { in: ["PENDING", "RETRY_SCHEDULED"] });
  assert.deepEqual(captured.orderBy, [{ priority: "desc" }, { nextAttemptAt: "asc" }, { createdAt: "asc" }]);
  assert.equal(captured.take, 100, "eligible batch clamps at 100");
  assert.ok(captured.where.OR.some((clause) => clause.nextAttemptAt?.lte?.getTime() === NOW.getTime()));
});

test("29-QUEUE heartbeat succeeds only for the owner, extends the lease and cannot revive terminal jobs", async () => {
  const updates = [];
  const jobs = { "job-1": { id: "job-1", leaseOwner: "worker-1", status: "RUNNING" } };
  const client = {
    marketingExecutionJob: {
      updateMany: async ({ where, data }) => {
        updates.push({ where, data });
        const job = jobs[where.id];
        const owned = job && job.leaseOwner === where.leaseOwner && where.status.in.includes(job.status);
        if (owned) Object.assign(job, data);
        return { count: owned ? 1 : 0 };
      },
      findUnique: async ({ where }) => jobs[where.id],
    },
  };
  const repository = new ExecutionJobRepository({ client, now: () => NOW });
  const refreshed = await repository.heartbeatOwned({ id: "job-1", leaseOwner: "worker-1", leaseSeconds: 120 });
  assert.equal(refreshed.leaseExpiresAt.getTime(), NOW.getTime() + 120000, "heartbeat extends the lease");
  // Lease seconds are clamped into [15, 900].
  await repository.heartbeatOwned({ id: "job-1", leaseOwner: "worker-1", leaseSeconds: 100000 });
  assert.equal(jobs["job-1"].leaseExpiresAt.getTime(), NOW.getTime() + 900000);
  // Non-owner heartbeat fails with the stable ownership error.
  await assert.rejects(repository.heartbeatOwned({ id: "job-1", leaseOwner: "intruder" }), (error) => error.errors[0].reasonCode === "LEASE_OWNER_MISMATCH");
  // A terminal job is not in CLAIMED/RUNNING and cannot be revived.
  jobs["job-1"].status = "SUCCEEDED";
  await assert.rejects(repository.heartbeatOwned({ id: "job-1", leaseOwner: "worker-1" }), (error) => error.errors[0].reasonCode === "LEASE_OWNER_MISMATCH");
  assert.ok(updates.every((update) => update.where.leaseOwner !== undefined), "every heartbeat predicate binds the owner");
});

test("29-QUEUE expiry recovery routes each expired job to retry, reconciliation, failure or dead letter", async () => {
  const expired = [
    { id: "job-retry", status: "CLAIMED", leaseOwner: "gone-1", attemptCount: 1, runId: "run-1", run: { planId: "plan-1", operations: [] } },
    { id: "job-unknown", status: "RUNNING", leaseOwner: "gone-2", attemptCount: 1, runId: "run-2", run: { planId: "plan-2", operations: [{ id: "op-u", status: "UNKNOWN", providerRequestId: "req-u", nativeResourceId: null }] } },
    { id: "job-success-incomplete", status: "RUNNING", leaseOwner: "gone-3", attemptCount: 1, runId: "run-3", run: { planId: "plan-3", operations: [{ id: "op-s", status: "SUCCEEDED", providerRequestId: "req-s", nativeResourceId: "res-1" }] } },
    { id: "job-failed", status: "RUNNING", leaseOwner: "gone-4", attemptCount: 1, runId: "run-4", run: { planId: "plan-4", operations: [{ id: "op-f", status: "FAILED" }] } },
    { id: "job-dead", status: "CLAIMED", leaseOwner: "gone-5", attemptCount: 5, runId: "run-5", run: { planId: "plan-5", operations: [] } },
  ];
  const state = Object.fromEntries(expired.map((job) => [job.id, { ...job }]));
  const deadLetterReviews = [];
  const enqueued = [];
  const audits = [];
  const client = {
    marketingExecutionJob: {
      findMany: async ({ where }) => {
        assert.ok(where.leaseExpiresAt.lt.getTime() === NOW.getTime(), "only expired leases are scanned; active leases stay untouched");
        return expired;
      },
      updateMany: async ({ where, data }) => { Object.assign(state[where.id], data); return { count: 1 }; },
      findUnique: async ({ where }) => state[where.id],
    },
    marketingExecutionDeadLetterReview: { upsert: async ({ where }) => deadLetterReviews.push(where.jobId) },
    $transaction: (handler) => handler(client),
  };
  const repository = new ExecutionJobRepository({ client, now: () => NOW, maximumAttempts: 5 });
  const results = await repository.recoverExpiredLeases({
    reconciliationRepository: { enqueue: async (entry) => enqueued.push(entry) },
    audit: { event: async (entry) => audits.push(entry) },
  });
  assert.equal(results.length, 5);
  assert.equal(state["job-retry"].status, "RETRY_SCHEDULED");
  assert.equal(state["job-unknown"].status, "RECONCILING");
  assert.equal(state["job-success-incomplete"].status, "RECONCILING");
  assert.equal(state["job-failed"].status, "FAILED");
  assert.equal(state["job-dead"].status, "DEAD_LETTER");
  assert.deepEqual(deadLetterReviews, ["job-dead"]);
  // Recovery reason and previous owner are durably stored, lease cleared.
  assert.equal(state["job-retry"].recoveryReason, "EXPIRED_CLAIMED_SAFE_TO_RETRY");
  assert.equal(state["job-retry"].previousLeaseOwner, "gone-1");
  assert.equal(state["job-retry"].leaseOwner, null);
  assert.equal(state["job-unknown"].recoveryReason, "EXPIRED_RUNNING_RECONCILIATION_REQUIRED");
  // Unknown outcomes reconcile before any retry; known success verifies post-write.
  assert.deepEqual(enqueued.map((entry) => entry.reason), ["UNKNOWN_PROVIDER_OUTCOME", "POST_WRITE_VERIFICATION"]);
  assert.equal(enqueued[1].providerIdentity.nativeResourceId, "res-1");
  assert.equal(audits.length, 5);
  assert.ok(audits.every((entry) => entry.action === "MARKETING_EXECUTION_LEASE_RECOVERED"));
});

test("29-QUEUE completion accepts only terminal statuses and queue packets gate on capability evidence", () => {
  const repository = new ExecutionJobRepository({ client: {}, now: () => NOW });
  assert.rejects(repository.completeOwned({ id: "job-1", leaseOwner: "worker-1", status: "RUNNING" }), (error) => error.code === "INVALID_OPERATION_TRANSITION");
  // Queue packet checks: disabled gates and stale capability fail closed.
  const plan = {
    status: "APPROVED", version: 2, validationFingerprint: "a".repeat(64),
    validationPackets: [{ valid: true, planVersion: 2, validationFingerprint: "a".repeat(64), expiresAt: new Date("2026-07-23T11:00:00.000Z") }],
  };
  const policyEvidence = { capabilityValid: true, globalEnabled: true, providerEnabled: true, connectionWriteEnabled: true };
  assert.ok(assertQueuePacket(plan, { expectedVersion: 2, fingerprint: "a".repeat(64), now: NOW, policyEvidence }));
  assert.throws(() => assertQueuePacket(plan, { expectedVersion: 1, fingerprint: "a".repeat(64), now: NOW, policyEvidence }), (error) => error.code === "EXECUTION_PLAN_CONFLICT");
  assert.throws(() => assertQueuePacket(plan, { expectedVersion: 2, fingerprint: "a".repeat(64), now: NOW, policyEvidence: { ...policyEvidence, capabilityValid: false } }), (error) => error.errors[0].reasonCode === "QUEUE_CAPABILITY_NOT_CURRENT");
  assert.throws(() => assertQueuePacket(plan, { expectedVersion: 2, fingerprint: "a".repeat(64), now: NOW, policyEvidence: { ...policyEvidence, connectionWriteEnabled: false } }), (error) => error.errors[0].reasonCode === "QUEUE_EXECUTION_GATE_DISABLED");
  assert.throws(() => assertQueuePacket({ ...plan, status: "DRAFT" }, { expectedVersion: 2, fingerprint: "a".repeat(64), now: NOW, policyEvidence }), (error) => error.errors[0].reasonCode === "APPROVED_PLAN_REQUIRED");
  // Dedupe identity is stable per run and purpose.
  assert.equal(jobSubmissionIdentity("Run-1", "primary"), jobSubmissionIdentity("run-1", "PRIMARY"));
  assert.notEqual(jobSubmissionIdentity("run-1", "PRIMARY"), jobSubmissionIdentity("run-1", "RETRY:op:2"));
});

test("29-QUEUE worker never starts on import, refuses disabled gates and stops new claims on shutdown", async () => {
  const workerModule = require("../jobs/execution-worker");
  assert.equal(workerModule.isStarted(), false, "importing the worker module never starts it");
  // Every gate blocks before any claim.
  let claims = 0;
  const claimCounter = { claimEligibleApproved: async () => { claims += 1; return []; }, recoverExpiredLeases: async () => [] };
  for (const env of [
    { ...ENABLED_ENV, MARKETING_AD_EXECUTION_ENABLED: "false" },
    { ...ENABLED_ENV, MARKETING_AD_EXECUTION_WORKER_ENABLED: "false" },
    { ...ENABLED_ENV, MARKETING_AD_EXECUTION_DRY_RUN: "true" },
  ]) {
    const gated = createExecutionWorker({ env, jobRepository: claimCounter });
    await assert.rejects(gated.claimNext(), (error) => error.code === "EXECUTION_DISABLED");
  }
  assert.equal(claims, 0, "disabled gates block before any claim");

  // Shutdown stops new claims, waits for the in-flight job, releases only owned resources.
  const releases = [];
  let resolveExecution;
  const jobRepository = {
    recoverExpiredLeases: async () => [],
    claimEligibleApproved: async () => [{ id: "job-1", connectionId: CONNECTION, platform: "META", accountExternalId: "act_1" }],
    markRunningOwned: async () => {},
    loadExecutionBundle: async () => ({ id: "job-1", run: { id: "run-1", summary: null, plan: { id: "plan-1", platform: "META", createdByAdminUserId: null } } }),
    heartbeatOwned: async () => {},
    completeOwned: async ({ leaseOwner, status }) => releases.push(`complete:${leaseOwner}:${status}`),
    observeCancellationOwned: async () => null,
  };
  const accountLockRepository = {
    acquire: async () => ({ key: "META:act_1" }),
    heartbeat: async () => {},
    release: async ({ key, owner }) => releases.push(`lock-release:${owner}:${key}`),
  };
  const worker = createExecutionWorker({
    env: { ...ENABLED_ENV },
    jobRepository,
    accountLockRepository,
    connectionGate: async () => true,
    executeBundle: () => new Promise((resolve) => { resolveExecution = resolve; }),
  });
  assert.equal(worker.isStarted(), false);
  const inFlight = worker.processNext({ leaseOwner: "worker-1" });
  await new Promise((resolve) => setImmediate(resolve));
  const shutdownPromise = worker.shutdown();
  assert.equal(worker.isStopping(), true);
  // New claims are rejected while stopping.
  await assert.rejects(worker.claimNext({ leaseOwner: "worker-1" }), (error) => error.errors[0].reasonCode === "WORKER_STOPPING");
  // The safe in-flight job is allowed to complete, then owned resources release.
  resolveExecution({ status: "SUCCEEDED" });
  const result = await inFlight;
  await shutdownPromise;
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(releases, ["complete:worker-1:SUCCEEDED", "lock-release:worker-1:META:act_1"]);
  assert.equal(worker.isStarted(), false, "shutdown leaves the worker stopped");
  // Unfinished work is never marked successful: a failing bundle maps to FAILED.
  const failing = createExecutionWorker({
    env: { ...ENABLED_ENV }, jobRepository, accountLockRepository, connectionGate: async () => true,
    executeBundle: async () => { const error = new Error("provider validation failed"); error.category = "VALIDATION"; error.outcomeCertain = true; error.providerProcessing = "NOT_STARTED"; throw error; },
  });
  const failed = await failing.processNext({ leaseOwner: "worker-2" });
  assert.equal(failed.status, "FAILED");
});

test("29-QUEUE reconciliation worker never starts when disabled and never starts on import", () => {
  const disabled = createReconciliationWorker({ enabled: false, repository: {}, reconciliationService: {}, providerReadRegistry: {} });
  assert.equal(disabled.start(), false);
  assert.equal(disabled.isStarted(), false);
  const enabled = createReconciliationWorker({ enabled: true, repository: null, reconciliationService: null, providerReadRegistry: null });
  assert.throws(() => enabled.start(), (error) => error.errors[0].reasonCode === "RECONCILIATION_WORKER_DEPENDENCIES_REQUIRED");
});

test("29-QUEUE cancellation observation is lease-owner scoped and cascades run and plan atomically", async () => {
  const state = {
    job: { id: "job-1", runId: "run-1", leaseOwner: "worker-1", status: "CLAIMED", cancellationRequestedAt: new Date("2026-07-23T09:59:00.000Z"), run: { planId: "plan-1" } },
    runStatus: "QUEUED", planStatus: "QUEUED",
  };
  const client = {
    $transaction: (handler) => handler(client),
    marketingExecutionJob: {
      findFirst: async ({ where }) => where.leaseOwner === state.job.leaseOwner && state.job.cancellationRequestedAt ? state.job : null,
      updateMany: async ({ where, data }) => { if (where.leaseOwner !== state.job.leaseOwner) return { count: 0 }; Object.assign(state.job, data); return { count: 1 }; },
      findUnique: async () => state.job,
    },
    marketingExecutionRun: { updateMany: async ({ data }) => { state.runStatus = data.status; return { count: 1 }; } },
    marketingExecutionPlan: { updateMany: async ({ data }) => { state.planStatus = data.status; return { count: 1 }; } },
  };
  const repository = new ExecutionJobRepository({ client, now: () => NOW });
  assert.equal(await repository.observeCancellationOwned({ id: "job-1", leaseOwner: "intruder" }), null);
  const observed = await repository.observeCancellationOwned({ id: "job-1", leaseOwner: "worker-1" });
  assert.equal(observed.status, "CANCELLED");
  assert.equal(observed.cancellationOutcome, "CANCELLED_BEFORE_PROVIDER_MUTATION");
  assert.equal(state.runStatus, "CANCELLED");
  assert.equal(state.planStatus, "CANCELLED");
});
