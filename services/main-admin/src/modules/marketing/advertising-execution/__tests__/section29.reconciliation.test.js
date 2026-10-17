"use strict";

// Section 29 — Reconciliation mandatory suite (VERIFIED, DRIFTED, UNKNOWN,
// EXTERNAL_CHANGE, COMPENSATION). The durable read-back worker runs against
// real PostgreSQL in tests/advertising-execution-sections18-24-postgres.test.js;
// this suite drives the production classification and reconciliation service
// with a transactional fake client that records every durable write.

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyReconciliation, compareMaterialState, createReconciliationService } = require("../reconciliation/reconciliation.service");
const { createReconciliationWorker } = require("../jobs/reconciliation-worker");
const { hashExecutionJson } = require("../execution-json.validator");

function fakeState() {
  return {
    snapshots: [], reconciliations: [], operationUpdates: [], runUpdates: [], planUpdates: [],
    compensationLink: null, compensationUpdates: [], audits: [], events: [],
  };
}

function fakeClient(state, { siblings = [] } = {}) {
  const client = {
    $transaction: (handler) => handler(client),
    marketingExecutionStateSnapshot: { create: async ({ data }) => { state.snapshots.push(data); return { id: `snapshot-${state.snapshots.length}`, ...data }; } },
    marketingExecutionReconciliation: { create: async ({ data }) => { state.reconciliations.push(data); return { id: `recon-${state.reconciliations.length}`, ...data }; } },
    marketingProviderOperation: {
      update: async ({ data }) => state.operationUpdates.push(data),
      findMany: async () => siblings,
    },
    marketingExecutionRun: { update: async ({ data }) => state.runUpdates.push(data) },
    marketingExecutionPlan: { updateMany: async ({ data }) => state.planUpdates.push(data), update: async ({ data }) => state.planUpdates.push(data) },
    marketingExecutionCompensationLink: {
      findFirst: async () => state.compensationLink,
      update: async ({ data }) => state.compensationUpdates.push(data),
    },
  };
  return client;
}

function bundle(overrides = {}) {
  const operation = {
    id: "op-1", outcomeCertainty: "KNOWN_SUCCESS",
    snapshots: [
      { kind: "DESIRED", sequence: 1, normalizedState: { status: "PAUSED", name: "Campaign" } },
    ],
    item: { intent: { status: "PAUSED", name: "Campaign" } },
    ...overrides.operation,
  };
  return {
    operation,
    run: { id: "run-1", summary: null, plan: { id: "plan-1", version: 2, createdByAdminUserId: "author-1" }, ...overrides.run },
    plan: { id: "plan-1", version: 2, createdByAdminUserId: "author-1" },
    reason: overrides.reason,
  };
}

function service(state, options = {}) {
  return createReconciliationService({
    client: fakeClient(state, options),
    audit: { event: async (entry) => state.audits.push(entry) },
    events: { emit: async (name, payload, recipients) => state.events.push({ name, payload, recipients }) },
  });
}

test("29-RECON VERIFIED persists the AFTER snapshot and promotes operation, run and plan aggregates", async () => {
  const state = fakeState();
  const result = await service(state, { siblings: [{ id: "op-1", status: "SUCCEEDED" }] }).reconcile({
    bundle: bundle(), currentState: { status: "PAUSED", name: "Campaign" }, providerVersion: "v25.0",
  });
  assert.equal(result.status, "VERIFIED");
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].kind, "AFTER");
  assert.match(state.snapshots[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(state.reconciliations[0].status, "VERIFIED");
  assert.equal(state.operationUpdates[0].status, "VERIFIED");
  assert.equal(state.runUpdates[0].status, "SUCCEEDED");
  assert.equal(state.planUpdates[0].status, "SUCCEEDED");
  assert.equal(state.audits[0].action, "MARKETING_RECONCILIATION_VERIFIED");
  assert.equal(state.events[0].name, "RECONCILIATION_VERIFIED");
  assert.deepEqual(state.events[0].recipients, ["author-1"]);
});

test("29-RECON DRIFTED records bounded differences, never overwrites, and blocks global success", async () => {
  const state = fakeState();
  const result = await service(state, { siblings: [{ id: "op-1", status: "SUCCEEDED" }, { id: "op-2", status: "VERIFIED" }] }).reconcile({
    bundle: bundle(), currentState: { status: "ACTIVE", name: "Campaign" },
  });
  assert.equal(result.status, "DRIFTED");
  assert.deepEqual(result.differences, [{ field: "status", desired: "PAUSED", actual: "ACTIVE" }]);
  assert.equal(state.operationUpdates[0].status, "DRIFTED");
  // Runs and plans never claim success on drift; nothing writes to the provider.
  assert.equal(state.runUpdates[0].status, "PARTIAL_SUCCESS");
  assert.equal(state.planUpdates[0].status, "PARTIAL_SUCCESS");
  assert.equal(state.audits[0].action, "EXECUTION_DRIFT_DETECTED");
  assert.equal(state.events[0].name, "RECONCILIATION_DRIFTED");
  // Difference lists are bounded.
  const wide = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field${index}`, index]));
  assert.ok(compareMaterialState(wide, {}).length <= 100);
});

test("29-RECON UNKNOWN read-back keeps the operation unknown, durable and escalates after bounded retries", async () => {
  const state = fakeState();
  const result = await service(state, { siblings: [{ id: "op-1", status: "UNKNOWN" }] }).reconcile({
    bundle: bundle(), currentState: null,
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(state.snapshots.length, 0, "no AFTER snapshot without a read-back");
  assert.equal(state.operationUpdates[0].status, "UNKNOWN");
  assert.equal(state.operationUpdates[0].outcomeCertainty, "UNKNOWN");
  assert.equal(state.runUpdates[0].status, "RECONCILING");
  assert.equal(state.planUpdates[0].status, "EXECUTING");
  // The worker retries read-back with bounded backoff and escalates at the cap,
  // never re-issuing a provider mutation.
  const scheduled = [];
  const finished = [];
  const worker = createReconciliationWorker({
    enabled: true,
    repository: {
      claim: async () => ({ id: "recon-job-1" }),
      markRunning: async () => {},
      loadBundle: async () => ({ ...bundle(), operationId: "op-1", attemptCount: 5, plan: { platform: "META" }, providerIdentity: {} }),
      reschedule: async (entry) => scheduled.push(entry),
      finish: async (entry) => finished.push(entry),
    },
    reconciliationService: { reconcile: async () => ({ status: "UNKNOWN" }) },
    providerReadRegistry: { resolve: () => ({ readResource: async () => null, apiVersion: "v25.0" }) },
    events: { emit: async (name, payload) => state.events.push({ name, payload }) },
    maximumAttempts: 5,
  });
  await worker.processNext({ owner: "recon-worker" });
  assert.equal(scheduled.length, 0);
  assert.equal(finished[0].status, "ESCALATED");
  assert.ok(state.events.some((event) => event.name === "RECONCILIATION_ESCALATED"));
});

test("29-RECON EXTERNAL_CHANGE keeps both hashes, classifies the external actor and stays unresolved", async () => {
  const previousState = { status: "PAUSED", name: "Campaign" };
  const previousHash = hashExecutionJson(previousState, "normalizedState").hash;
  const classified = classifyReconciliation({ desired: previousState, current: { status: "ACTIVE", name: "Campaign" }, previousVerifiedHash: previousHash });
  assert.equal(classified.status, "EXTERNAL_CHANGE");
  assert.equal(classified.previousVerifiedHash, previousHash);
  assert.match(classified.currentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(classified.currentHash, previousHash);

  const state = fakeState();
  const externalBundle = bundle({ operation: {
    id: "op-1", outcomeCertainty: "KNOWN_SUCCESS",
    snapshots: [
      { kind: "DESIRED", sequence: 1, normalizedState: previousState },
      { kind: "AFTER", sequence: 1, hash: previousHash, normalizedState: previousState },
    ],
    item: { intent: previousState },
  } });
  const result = await service(state, { siblings: [{ id: "op-1", status: "VERIFIED" }] }).reconcile({
    bundle: externalBundle, currentState: { status: "ACTIVE", name: "Campaign" }, externalActor: "EXTERNAL_OR_UNKNOWN",
  });
  assert.equal(result.status, "EXTERNAL_CHANGE");
  // A drift incident row is created with both hashes and the external actor.
  assert.equal(state.reconciliations[0].status, "EXTERNAL_CHANGE");
  assert.equal(state.reconciliations[0].previousVerifiedHash, previousHash);
  assert.equal(state.reconciliations[0].externalActor, "EXTERNAL_OR_UNKNOWN");
  // The operation is drifted, never auto-overwritten, and the drift audit fires.
  assert.equal(state.operationUpdates[0].status, "DRIFTED");
  assert.equal(state.audits[0].action, "EXECUTION_DRIFT_DETECTED");
});

test("29-RECON COMPENSATED is set only after safe-state verification of the full compensation run", async () => {
  const state = fakeState();
  state.compensationLink = {
    id: "link-1",
    compensationRun: { operations: [{ id: "op-1", status: "SUCCEEDED" }, { id: "op-2", status: "VERIFIED" }] },
  };
  const compensationBundle = bundle({ reason: "COMPENSATION_VERIFICATION" });
  const result = await service(state, { siblings: [{ id: "op-1", status: "SUCCEEDED" }] }).reconcile({
    bundle: compensationBundle, currentState: { status: "PAUSED", name: "Campaign" },
  });
  assert.equal(result.status, "VERIFIED");
  // Every compensation operation is verified, so the link records the safe state
  // and the plan becomes ROLLED_BACK.
  assert.equal(state.compensationUpdates.length, 1);
  assert.equal(state.compensationUpdates[0].verifiedSafeStateHash, result.currentHash);
  assert.ok(state.compensationUpdates[0].compensatedAt instanceof Date);
  assert.ok(state.planUpdates.some((update) => update.status === "ROLLED_BACK"));
  assert.ok(state.events.some((event) => event.name === "COMPENSATION_COMPLETED"));

  // A partially verified compensation run never records COMPENSATED.
  const partial = fakeState();
  partial.compensationLink = {
    id: "link-2",
    compensationRun: { operations: [{ id: "op-1", status: "SUCCEEDED" }, { id: "op-2", status: "FAILED" }] },
  };
  await service(partial, { siblings: [{ id: "op-1", status: "SUCCEEDED" }] }).reconcile({
    bundle: bundle({ reason: "COMPENSATION_VERIFICATION" }), currentState: { status: "PAUSED", name: "Campaign" },
  });
  assert.equal(partial.compensationUpdates.length, 0, "failed compensation states are preserved, not resolved");
  assert.equal(partial.planUpdates.some((update) => update.status === "ROLLED_BACK"), false);
});

test("29-RECON material comparison normalizes decimals, URLs and unordered collections without false drift", () => {
  assert.deepEqual(compareMaterialState(
    { budget: "10.00", tags: ["b", "a"], url: "https://x.example/a?b=2&a=1#fragment" },
    { budget: "10", tags: ["a", "b"], url: "https://x.example/a?a=1&b=2" },
  ), []);
  assert.deepEqual(compareMaterialState({ nested: { amount: "5.50" } }, { nested: { amount: "5.5" } }), []);
  const differences = compareMaterialState({ nested: { amount: "5.50", status: "PAUSED" } }, { nested: { amount: "6", status: "PAUSED" } });
  assert.deepEqual(differences, [{ field: "nested.amount", desired: "5.50", actual: "6" }]);
});
