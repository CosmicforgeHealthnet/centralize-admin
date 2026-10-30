const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeExecutionJson, hashExecutionJson } = require("../execution-json.validator");
const { PlanRepository, generatePlanNumber } = require("../plans/plan.repository");
const { ApprovalRepository } = require("../approvals/approval.repository");
const { OperationRepository } = require("../operations/operation.repository");
const { ExecutionJobRepository } = require("../jobs/execution-job.repository");
const { PolicyRepository } = require("../policy/policy.repository");
const { CreativePublicationRepository } = require("../creatives/creative-publication.repository");

const IDS = Object.freeze({
  plan: "11111111-1111-4111-8111-111111111111",
  connection: "22222222-2222-4222-8222-222222222222",
  item: "33333333-3333-4333-8333-333333333333",
  operation: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  approval: "66666666-6666-4666-8666-666666666666",
  actor: "admin-1",
});

function expectCode(code, fn) {
  assert.throws(fn, (error) => error.code === code);
}

test("bounded execution JSON accepts normalized DTOs", () => {
  assert.deepEqual(sanitizeExecutionJson({ campaign: { objective: "CONVERSIONS", budget: 100 }, placements: ["FEED"] }, "desiredState"), {
    campaign: { objective: "CONVERSIONS", budget: 100 }, placements: ["FEED"],
  });
});

test("bounded execution JSON rejects oversize, depth and executable content", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ text: "x".repeat(5000) }, "intent"));
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }, "intent"));
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ html: "<script>alert(1)</script>" }, "intent"));
});

test("bounded execution JSON rejects prototype, authorization, tokens and credential envelopes", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson(JSON.parse('{"__proto__":{"polluted":true}}'), "intent"));
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ authorization: "Bearer secret" }, "intent"));
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ access_token: "secret" }, "intent"));
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ encryptedCredentialEnvelope: "secret" }, "intent"));
});

test("bounded execution JSON rejects raw provider-native mutation shapes", () => {
  expectCode("RAW_PROVIDER_PAYLOAD_FORBIDDEN", () => sanitizeExecutionJson({ googleAdsPayload: { mutate: [] } }, "intent"));
  expectCode("RAW_PROVIDER_PAYLOAD_FORBIDDEN", () => sanitizeExecutionJson({ rawProviderResponse: {} }, "normalizedResult"));
});

test("canonical snapshot hashing is deterministic", () => {
  assert.equal(hashExecutionJson({ b: 2, a: 1 }).hash, hashExecutionJson({ a: 1, b: 2 }).hash);
  assert.match(hashExecutionJson({ a: 1 }).hash, /^[a-f0-9]{64}$/);
});

test("plan numbers are unique-shaped and date scoped", () => {
  const one = generatePlanNumber(new Date("2026-07-22T00:00:00Z"));
  const two = generatePlanNumber(new Date("2026-07-22T00:00:00Z"));
  assert.match(one, /^MEP-20260722-[A-F0-9]{12}$/);
  assert.notEqual(one, two);
});

test("plan repository creates a DRAFT with deterministic item sequence and safe state", async () => {
  let planData;
  let itemData;
  const tx = {
    marketingExecutionPlan: {
      create: async ({ data }) => { planData = data; return { id: IDS.plan, ...data }; },
      findUnique: async () => ({ id: IDS.plan, ...planData, items: itemData }),
    },
    marketingExecutionPlanItem: { createMany: async ({ data }) => { itemData = data; return { count: data.length }; } },
  };
  const repository = new PlanRepository({ client: { $transaction: (fn) => fn(tx) }, planNumberFactory: () => "MEP-20260722-ABCDEF123456" });
  const result = await repository.create({
    platform: "META", connectionId: IDS.connection, accountExternalId: "acct-1", currencyCode: "USD",
    name: "Plan", desiredState: { provider: "META", objective: "CONVERSIONS" },
    createdByAdminUserId: IDS.actor, updatedByAdminUserId: IDS.actor,
    items: [
      { id: IDS.item, sequence: 0, operationType: "CREATE", resourceType: "CAMPAIGN", clientReference: "campaign", intent: { objective: "CONVERSIONS" } },
      { sequence: 1, operationType: "CREATE", resourceType: "AD", clientReference: "ad", dependsOnItemIds: [IDS.item], intent: { creativeRef: "creative" } },
    ],
  });
  assert.equal(planData.status, "DRAFT");
  assert.equal(planData.version, 1);
  assert.equal(planData.validationFingerprint, null);
  assert.deepEqual(itemData.map((item) => item.sequence), [0, 1]);
  assert.ok(itemData.every((item) => /^[a-f0-9]{64}$/.test(item.materialHash)));
  assert.equal(result.items.length, 2);
});

test("plan repository rejects duplicate ordering, references and invalid dependencies before persistence", async () => {
  const repository = new PlanRepository({ client: { $transaction: async () => assert.fail("invalid items reached persistence") } });
  const base = { platform: "META", connectionId: IDS.connection, accountExternalId: "acct-1", currencyCode: "USD", desiredState: {}, createdByAdminUserId: IDS.actor };
  await assert.rejects(repository.create({ ...base, items: [
    { sequence: 0, operationType: "CREATE", resourceType: "CAMPAIGN", clientReference: "same", intent: {} },
    { sequence: 0, operationType: "CREATE", resourceType: "AD", clientReference: "same", intent: {} },
  ] }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  await assert.rejects(repository.create({ ...base, items: [
    { sequence: 1, operationType: "CREATE", resourceType: "AD", clientReference: "ad", dependsOnItemIds: [IDS.item], intent: {} },
  ] }), (error) => error.code === "INVALID_EXECUTION_PLAN");
});

test("material plan update uses id/version/DRAFT optimistic predicate and clears validation", async () => {
  let update;
  const tx = {
    marketingExecutionPlan: {
      updateMany: async (input) => { update = input; return { count: 1 }; },
      findUnique: async () => ({ id: IDS.plan, version: 3, status: "DRAFT" }),
    },
    marketingExecutionPlanItem: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
  };
  const repository = new PlanRepository({ client: { $transaction: (fn) => fn(tx) } });
  await repository.updateMaterial({ id: IDS.plan, expectedVersion: 2, actorId: IDS.actor, desiredState: { objective: "LEADS" } });
  assert.deepEqual(update.where, { id: IDS.plan, version: 2, status: "DRAFT" });
  assert.equal(update.data.validationFingerprint, null);
  assert.equal(update.data.validatedAt, null);
  assert.equal(update.data.expiresAt, null);
  assert.deepEqual(update.data.version, { increment: 1 });
});

test("stale or non-editable durable plan update returns stable conflict", async () => {
  const client = { $transaction: (fn) => fn({ marketingExecutionPlan: { updateMany: async () => ({ count: 0 }) } }) };
  await assert.rejects(new PlanRepository({ client }).updateMaterial({ id: IDS.plan, expectedVersion: 1, actorId: IDS.actor, desiredState: {} }), (error) => error.code === "PLAN_VERSION_CONFLICT");
});

test("material edits keep old approvals as stale evidence", async () => {
  assert.deepEqual(await new PlanRepository({ client: {} }).invalidateApprovals(), { count: 0, strategy: "VERSIONED_STALENESS" });
});

test("approval repository persists exact packet and sanitized scope", async () => {
  let saved;
  const repository = new ApprovalRepository({ client: { marketingExecutionApproval: { create: async ({ data }) => { saved = data; return data; } } }, now: () => new Date("2026-07-22T00:00:00Z") });
  await repository.create({ planId: IDS.plan, planVersion: 4, validationFingerprint: "a".repeat(64), decision: "APPROVED", actorId: IDS.actor, approvalScope: { provider: "META", currency: "USD" } });
  assert.equal(saved.planVersion, 4);
  assert.equal(saved.validationFingerprint, "a".repeat(64));
  assert.deepEqual(saved.approvalScope, { provider: "META", currency: "USD" });
  expectCode("INVALID_EXECUTION_PLAN", () => sanitizeExecutionJson({ accessToken: "secret" }, "approvalScope"));
});

test("approval revocation is a separate append-only event", async () => {
  let event;
  const repository = new ApprovalRepository({ client: {
    marketingExecutionApproval: { findUnique: async () => ({ id: IDS.approval, approverAdminUserId: IDS.actor, decision: "APPROVED" }) },
    marketingExecutionApprovalEvent: { create: async ({ data }) => { event = data; return data; } },
  } });
  await repository.revoke(IDS.approval, IDS.actor, "Approval withdrawn after review");
  assert.equal(event.decision, "REVOKED");
  assert.equal(event.approvalId, IDS.approval);
});

test("operation repository defaults retry safety false and sanitizes request identifiers", async () => {
  let saved;
  const repository = new OperationRepository({ client: { marketingProviderOperation: { create: async ({ data }) => { saved = data; return data; } } } });
  await repository.createOperation({ runId: IDS.run, itemId: IDS.item, providerOperationKey: "op-key", idempotencyIdentity: { version: 2, materialHash: "a".repeat(64) }, providerRequestId: " request ! id " });
  assert.equal(saved.safeToRetry, false);
  assert.equal(saved.outcomeCertainty, "UNKNOWN");
  assert.equal(saved.providerRequestId, "requestid");
});

test("operation repository rejects a non-normalized persisted result", async () => {
  const repository = new OperationRepository({ client: { marketingProviderOperation: { create: async () => assert.fail("invalid result reached persistence") } } });
  await assert.rejects(
    repository.createOperation({ runId: IDS.run, itemId: IDS.item, providerOperationKey: "op-bad", idempotencyIdentity: { version: 2, materialHash: "a".repeat(64) }, normalizedResult: { status: "SUCCEEDED", rawProviderResponse: {} } }),
    (error) => error.code === "RAW_PROVIDER_PAYLOAD_FORBIDDEN",
  );
});

test("operation attempts and snapshots are persisted as numbered immutable evidence", async () => {
  let attempt;
  const snapshots = [];
  const repository = new OperationRepository({ client: {
    marketingProviderOperationAttempt: { create: async ({ data }) => { attempt = data; return data; } },
    marketingExecutionStateSnapshot: { create: async ({ data }) => { snapshots.push(data); return data; } },
  } });
  await repository.createAttempt({ operationId: IDS.operation, number: 1 });
  await repository.createSnapshot({ operationId: IDS.operation, kind: "BEFORE", normalizedState: { status: "ACTIVE" } });
  await repository.createSnapshot({ operationId: IDS.operation, kind: "AFTER", normalizedState: { status: "PAUSED" } });
  assert.equal(attempt.number, 1);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.kind), ["BEFORE", "AFTER"]);
  assert.ok(snapshots.every((snapshot) => /^[a-f0-9]{64}$/.test(snapshot.hash)));
});

test("execution job repository persists queue priority independently and exposes safe claim ordering", async () => {
  let created;
  let query;
  const repository = new ExecutionJobRepository({ client: { marketingExecutionJob: {
    create: async ({ data }) => { created = data; return data; },
    findMany: async (input) => { query = input; return []; },
  } }, now: () => new Date("2026-07-22T00:00:00Z") });
  await repository.create({ runId: IDS.run, connectionId: IDS.connection, platform: "META", accountExternalId: "act_1", priority: 9 });
  await repository.findEligible();
  assert.equal(created.attemptCount, 0);
  assert.equal(created.priority, 9);
  assert.deepEqual(query.orderBy, [{ priority: "desc" }, { nextAttemptAt: "asc" }, { createdAt: "asc" }]);
});

test("policy repository resolves connection over platform over global", async () => {
  const rows = [
    { scope: "GLOBAL", value: false },
    { scope: "PLATFORM", value: true },
    { scope: "CONNECTION", value: false },
  ];
  const repository = new PolicyRepository({ client: { marketingExecutionPolicy: { findMany: async () => rows } } });
  assert.equal((await repository.resolveEffective({ key: "execution.enabled", platform: "META", connectionId: IDS.connection })).scope, "GLOBAL");
});

test("policy optimistic updates reject stale versions", async () => {
  const repository = new PolicyRepository({ client: { marketingExecutionPolicy: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) } } });
  await assert.rejects(repository.update({ id: IDS.plan, expectedVersion: 1, actorId: IDS.actor, valueType: "BOOLEAN", value: false, enabled: false }), (error) => error.code === "PLAN_VERSION_CONFLICT");
});

test("creative repository rejects arbitrary controller metadata", async () => {
  const repository = new CreativePublicationRepository({ client: {} });
  await assert.rejects(repository.createRevision({ creativeAssetId: "asset-1", platform: "META", connectionId: IDS.connection, publicationMetadata: { headline: "unsafe direct write" } }), (error) => error.errors[0].reasonCode === "UNVALIDATED_PUBLICATION_REPOSITORY_WRITE");
});

test("importing durable repositories does not start the worker", () => {
  assert.equal(require("../jobs/execution-worker").isStarted(), false);
});
