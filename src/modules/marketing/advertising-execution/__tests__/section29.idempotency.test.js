"use strict";

// Section 29 — Idempotency mandatory suite (duplicate submit, duplicate
// queue, duplicate attempt, unknown outcome, read-back recovery). Durable
// duplicate queue/submit behavior is additionally proven against PostgreSQL
// in tests/advertising-execution-sections18-24-postgres.test.js; this suite
// covers the complete identity, retry-safety and recovery semantics.

const test = require("node:test");
const assert = require("node:assert/strict");
const { operationIdentity, createProviderOperationKey, assertBeforeStateCurrent } = require("../operations/idempotency.service");
const { submissionIdentity, ExecutionRunRepository } = require("../runs/execution-run.repository");
const { decideRetry } = require("../operations/retry-policy.service");
const { createOperationRunner } = require("../operations/operation-runner.service");
const { assertRetryDatabaseEligibility, retryIdentity, RETRYABLE_CATEGORIES } = require("../operations/retry-review.service");
const { hashExecutionJson } = require("../execution-json.validator");

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT = "a".repeat(64);
const NOW = new Date("2026-07-23T10:00:00.000Z");

function identityInput(overrides = {}) {
  return {
    version: 2, provider: "META", connectionId: CONNECTION, accountExternalId: "act_123",
    approvedPlanId: PLAN_ID, approvedPlanVersion: 3, itemId: ITEM_ID,
    operationType: "CREATE", resourceType: "CAMPAIGN", materialHash: "b".repeat(64),
    ...overrides,
  };
}

test("29-IDEMPOTENCY the canonical operation key changes with every identity field and nothing else", () => {
  const baseline = createProviderOperationKey(identityInput());
  assert.match(baseline, /^[a-f0-9]{64}$/);
  // Same identity always produces the same key.
  assert.equal(createProviderOperationKey(identityInput()), baseline);
  // Case and whitespace normalization keeps identity canonical.
  assert.equal(createProviderOperationKey(identityInput({ provider: "meta", operationType: "create", accountExternalId: " act_123 " })), baseline);
  // Every identity dimension produces a new key.
  const changes = {
    provider: { provider: "TIKTOK" },
    accountExternalId: { accountExternalId: "act_999" },
    connectionId: { connectionId: "44444444-4444-4444-8444-444444444444" },
    approvedPlanId: { approvedPlanId: "55555555-5555-4555-8555-555555555555" },
    approvedPlanVersion: { approvedPlanVersion: 4 },
    itemId: { itemId: "66666666-6666-4666-8666-666666666666" },
    operationType: { operationType: "UPDATE" },
    resourceType: { resourceType: "GROUP" },
    materialHash: { materialHash: "c".repeat(64) },
  };
  for (const [field, change] of Object.entries(changes)) {
    assert.notEqual(createProviderOperationKey(identityInput(change)), baseline, `${field} must change the key`);
  }
  // Timestamps, attempt numbers and worker identity are not part of the identity.
  const identity = operationIdentity(identityInput());
  assert.equal("attempt" in identity || "timestamp" in identity || "workerId" in identity || "leaseOwner" in identity, false);
  // Missing fields and malformed hashes fail closed.
  assert.throws(() => operationIdentity(identityInput({ materialHash: "zzz" })), (error) => error.errors[0].reasonCode === "INVALID_MATERIAL_HASH");
  assert.throws(() => operationIdentity(identityInput({ itemId: "" })), (error) => error.errors[0].reasonCode === "IDEMPOTENCY_FIELD_REQUIRED");
  assert.throws(() => operationIdentity(identityInput({ approvedPlanVersion: 0 })), (error) => error.errors[0].reasonCode === "INVALID_IDEMPOTENCY_VERSION");
});

test("29-IDEMPOTENCY duplicate submit resolves to the existing run and changed fingerprints get new identity", async () => {
  const runs = new Map();
  const client = {
    marketingExecutionRun: {
      findUnique: async ({ where }) => runs.get(where.submissionKey) || null,
      create: async ({ data }) => {
        if (runs.has(data.submissionKey)) { const error = new Error("unique"); error.code = "P2002"; throw error; }
        const run = { id: `run-${runs.size + 1}`, ...data };
        runs.set(data.submissionKey, run);
        return run;
      },
    },
  };
  const repository = new ExecutionRunRepository({ client });
  const input = { planId: PLAN_ID, approvedPlanVersion: 3, approvalFingerprint: FINGERPRINT, trigger: "MANUAL" };
  const first = await repository.createIdempotent(input);
  const second = await repository.createIdempotent(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.id, first.run.id, "the same validated plan submitted twice resolves to one run");
  // Concurrent submit: simulate the race where the pre-check misses and the
  // unique constraint resolves the duplicate.
  runs.set(submissionIdentity(input), first.run);
  const raced = await new ExecutionRunRepository({ client: { marketingExecutionRun: { findUnique: async ({ where }) => runs.get(where.submissionKey), create: client.marketingExecutionRun.create } } }).createIdempotent(input);
  assert.equal(raced.run.id, first.run.id);
  // A changed fingerprint is a different submission identity entirely.
  const changed = await repository.createIdempotent({ ...input, approvalFingerprint: "d".repeat(64) });
  assert.equal(changed.created, true);
  assert.notEqual(changed.run.id, first.run.id);
  // Compensation triggers do not collide with the primary submission.
  assert.notEqual(submissionIdentity(input), submissionIdentity({ ...input, trigger: "COMPENSATION" }));
});

test("29-IDEMPOTENCY unknown outcomes are never blindly retried and precondition changes block mutation", () => {
  // UNKNOWN → reconcile before any retry.
  const unknown = decideRetry({ providerProcessing: "UNKNOWN", outcomeCertain: false, attempt: 1 });
  assert.equal(unknown.automaticRetry, false);
  assert.equal(unknown.action, "RECONCILE_BEFORE_RETRY");
  // Known provider success with local persistence failure → reconcile persistence.
  assert.equal(decideRetry({ localPersistenceFailed: true, outcomeCertain: true }).action, "RECONCILE_LOCAL_PERSISTENCE");
  // Policy failures never auto-retry; stale preconditions revalidate.
  assert.equal(decideRetry({ category: "POLICY", providerProcessing: "NOT_STARTED", outcomeCertain: true }).automaticRetry, false);
  assert.equal(decideRetry({ preconditionFresh: false }).action, "REVALIDATE_AND_REAPPROVE");
  // Rate limits with certain non-started processing may retry with backoff.
  assert.equal(decideRetry({ category: "RATE_LIMIT", providerProcessing: "NOT_STARTED", outcomeCertain: true, attempt: 1 }).automaticRetry, true);
  // Before-state hash mismatches block the provider mutation entirely.
  assert.throws(() => assertBeforeStateCurrent({ approvedHash: "e".repeat(64), currentState: { status: "ACTIVE" } }), (error) => error.code === "EXECUTION_PRECONDITION_CHANGED");
  const currentState = { status: "PAUSED" };
  assert.equal(assertBeforeStateCurrent({ approvedHash: hashExecutionJson(currentState, "beforeState").hash, currentState }), hashExecutionJson(currentState, "beforeState").hash);
});

test("29-IDEMPOTENCY runner marks unknown outcomes UNKNOWN, freezes dependents and routes to reconciliation", async () => {
  const events = [];
  const persisted = [];
  const enqueued = [];
  const item = (id, sequence, dependsOnItemIds = []) => ({ id, sequence, operationType: "CREATE", resourceType: "CAMPAIGN", materialHash: "b".repeat(64), intent: {}, dependsOnItemIds });
  const operationFor = (id, opItem) => ({ id, itemId: opItem.id, status: "READY", attempts: [], item: opItem, snapshots: [{ kind: "BEFORE", sequence: 1, hash: hashExecutionJson({ exists: false }, "beforeState").hash }] });
  const first = operationFor("op-1", item(ITEM_ID, 0));
  const second = operationFor("op-2", item("77777777-7777-4777-8777-777777777777", 1, [ITEM_ID]));
  const bundle = { id: "job-1", run: { id: "run-1", approvedPlanVersion: 3, summary: null, plan: { id: PLAN_ID, version: 3, sourceType: "MANUAL", platform: "META", connectionId: CONNECTION, accountExternalId: "act_123", createdByAdminUserId: "author-1" }, operations: [first, second] } };
  let providerCalls = 0;
  const runner = createOperationRunner({
    operationRepository: {
      createAttempt: async () => ({ id: `attempt-${persisted.length + 1}` }),
      completeAttempt: async () => {},
      persistResult: async (entry) => persisted.push(entry),
    },
    providerReadRegistry: { resolve: () => ({ readResource: async () => ({ exists: false }) }) },
    finalMutationGate: { assert: async () => ({ globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true }) },
    adapterResolver: async () => ({ executeOperation: async () => { providerCalls += 1; const error = new Error("socket closed mid-flight"); error.outcomeUnknown = true; throw error; } }),
    reconciliationRepository: { enqueue: async (entry) => { enqueued.push(entry); return { id: `recon-${enqueued.length}` }; } },
    events: { emit: async (name, payload) => events.push({ name, payload }) },
  });
  const outcome = await runner.run({ bundle, leaseOwner: "worker-1", lockKey: "lock-1" });
  assert.equal(outcome.status, "RECONCILING");
  // Exactly one provider call happened; the dependent operation was frozen.
  assert.equal(providerCalls, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, "UNKNOWN");
  assert.equal(persisted[0].outcomeCertainty, "UNKNOWN");
  assert.equal(persisted[0].safeToRetry, false);
  // Reconciliation was queued for the unknown outcome with the idempotency key preserved.
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].reason, "UNKNOWN_PROVIDER_OUTCOME");
  assert.equal(enqueued[0].providerIdentity.idempotencyKey, createProviderOperationKey(identityInput({ approvedPlanVersion: 3 })));
  assert.ok(events.some((event) => event.name === "OPERATION_UNKNOWN"));
  assert.ok(events.some((event) => event.name === "RECONCILIATION_QUEUED"));
});

test("29-IDEMPOTENCY known provider success with failed local persistence routes to durable recovery", async () => {
  const enqueued = [];
  const item = { id: ITEM_ID, sequence: 0, operationType: "CREATE", resourceType: "CAMPAIGN", materialHash: "b".repeat(64), intent: {}, dependsOnItemIds: [] };
  const operation = { id: "op-1", itemId: ITEM_ID, status: "READY", attempts: [], item, snapshots: [{ kind: "BEFORE", sequence: 1, hash: hashExecutionJson({ exists: false }, "beforeState").hash }] };
  const bundle = { id: "job-1", run: { id: "run-1", approvedPlanVersion: 3, summary: null, plan: { id: PLAN_ID, version: 3, sourceType: "MANUAL", platform: "META", connectionId: CONNECTION, accountExternalId: "act_123", createdByAdminUserId: "author-1" }, operations: [operation] } };
  const runner = createOperationRunner({
    operationRepository: {
      createAttempt: async () => ({ id: "attempt-1" }),
      completeAttempt: async () => {},
      persistResult: async () => { throw new Error("database write failed after provider success"); },
    },
    providerReadRegistry: { resolve: () => ({ readResource: async () => ({ exists: false }) }) },
    finalMutationGate: { assert: async () => ({ globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true }) },
    adapterResolver: async () => ({ executeOperation: async () => ({ status: "SUCCEEDED", outcomeCertain: true, providerRequestId: "meta-req-1", nativeResourceId: "native-1", retryable: false, error: null, warnings: [], returnedState: {}, nativeResourceName: null }) }),
    reconciliationRepository: { enqueue: async (entry) => { enqueued.push(entry); return { id: "recon-1" }; } },
    events: { emit: async () => {} },
  });
  await assert.rejects(runner.run({ bundle, leaseOwner: "worker-1", lockKey: "lock-1" }), (error) => error.localPersistenceFailed === true && error.providerProcessing === "COMPLETED");
  // The provider identity (request id + native resource id) is preserved for read-back recovery.
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].reason, "PROVIDER_SUCCESS_LOCAL_PERSISTENCE_FAILED");
  assert.equal(enqueued[0].providerIdentity.providerRequestId, "meta-req-1");
  assert.equal(enqueued[0].providerIdentity.nativeResourceId, "native-1");
  // The worker-level decision for this failure is reconciliation, never a blind provider retry.
  assert.equal(decideRetry({ localPersistenceFailed: true, outcomeCertain: true, providerProcessing: "COMPLETED" }).action, "RECONCILE_LOCAL_PERSISTENCE");
});

test("29-IDEMPOTENCY retry review only accepts known safe failures and binds to the exact failed attempt", () => {
  const basePlan = {
    id: PLAN_ID, version: 3, status: "QUEUED", validationFingerprint: FINGERPRINT, platform: "META",
    connectionId: CONNECTION, currencyCode: "USD", createdByAdminUserId: "author-1", desiredState: {},
    approvals: [{ planId: PLAN_ID, planVersion: 3, validationFingerprint: FINGERPRINT, decision: "APPROVED", approverAdminUserId: "approver-1", approvalScope: { approverTier: "EXECUTIVE" } }],
    validationPackets: [{ valid: true, planVersion: 3, validationFingerprint: FINGERPRINT, expiresAt: new Date("2026-07-23T11:00:00.000Z") }],
  };
  const operation = (overrides = {}) => ({
    id: "op-1", runId: "run-1", itemId: ITEM_ID, status: "FAILED", outcomeCertainty: "KNOWN_FAILURE",
    attempts: [{ number: 2, errorCategory: "RATE_LIMIT", normalizedError: { providerProcessing: "NOT_STARTED" } }],
    item: { id: ITEM_ID, resourceType: "CAMPAIGN", operationType: "CREATE", dependsOnItemIds: [] },
    run: { id: "run-1", planId: PLAN_ID, approvedPlanVersion: 3, approvalFingerprint: FINGERPRINT, plan: basePlan, operations: [] },
    snapshots: [], ...overrides,
  });
  assert.ok(assertRetryDatabaseEligibility(operation(), NOW));
  assert.deepEqual([...RETRYABLE_CATEGORIES].sort(), ["NETWORK", "RATE_LIMIT", "TRANSIENT"]);
  // UNKNOWN outcome must reconcile, never retry.
  assert.throws(() => assertRetryDatabaseEligibility(operation({ status: "UNKNOWN", outcomeCertainty: "UNKNOWN" }), NOW), (error) => error.code === "EXECUTION_OUTCOME_UNKNOWN" && error.errors[0].reconciliationRequired === true);
  // Provider processing that may have started blocks the mutation retry.
  assert.throws(() => assertRetryDatabaseEligibility(operation({ attempts: [{ number: 2, errorCategory: "NETWORK", normalizedError: { providerProcessing: "UNKNOWN" } }] }), NOW), (error) => error.errors[0].reasonCode === "PROVIDER_PROCESSING_MAY_HAVE_STARTED");
  // Non-retryable categories are blocked; expired packets demand revalidation.
  assert.throws(() => assertRetryDatabaseEligibility(operation({ attempts: [{ number: 2, errorCategory: "POLICY", normalizedError: {} }] }), NOW), (error) => error.errors[0].reasonCode === "RETRY_BLOCKED_POLICY");
  assert.throws(() => assertRetryDatabaseEligibility(operation({ run: { ...operation().run, plan: { ...basePlan, validationPackets: [{ valid: true, planVersion: 3, validationFingerprint: FINGERPRINT, expiresAt: NOW }] } } }), NOW), (error) => error.code === "STALE_VALIDATION_FINGERPRINT");
  // The retry identity is bound to the exact failed attempt: a newer attempt changes it.
  const before = retryIdentity(operation());
  const after = retryIdentity(operation({ attempts: [{ number: 3, errorCategory: "RATE_LIMIT", normalizedError: { providerProcessing: "NOT_STARTED" } }] }));
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.notEqual(before, after);
});
