"use strict";

// Section 29 — Plans mandatory suite (CRUD, version conflicts, immutable
// states, fingerprint invalidation). Every test drives production plan code
// (service, validator, repository, fingerprint, mappers) with injected fakes;
// no provider transport exists anywhere in these flows.

const test = require("node:test");
const assert = require("node:assert/strict");
const networkGuard = require("../../../../../tests/helpers/network-guard");
const { createPlanService, assertEditable, transitionPlan } = require("../plans/plan.service");
const { validatePlanInput } = require("../plans/plan.validator");
const { fingerprintPlan, NON_MATERIAL_ROOT_FIELDS } = require("../plans/plan-fingerprint");
const { PlanRepository, validateItemSet } = require("../plans/plan.repository");
const { validateHierarchy } = require("../campaigns/hierarchy.validator");
const { assertImmutableFields } = require("../campaigns/immutable-field-policy");
const { pagination } = require("../execution.query-validator");
const { mapPlanSummary, mapPlanDetail } = require("../execution.response");
const { PLAN_STATES } = require("../execution.constants");

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const AUTHOR = { id: "author-1" };

function draftInput(overrides = {}) {
  return {
    provider: "META",
    connectionId: CONNECTION,
    accountId: "act_123",
    currencyCode: "USD",
    objective: "OUTCOME_LEADS",
    budgetLimit: 100,
    operations: [{ type: "CREATE_CAMPAIGN", targetId: "campaign-1", sequence: 0, parameters: { dailyBudget: "25.00" } }],
    labels: ["b", "a"],
    name: "Section 29 plan",
    ...overrides,
  };
}

function fakePlanRepository() {
  const calls = { created: [], saved: [] };
  return {
    calls,
    create: async (input) => { calls.created.push(input); return { id: "plan-1", state: "DRAFT", version: 1, ...input }; },
    save: async (plan) => { calls.saved.push(plan); return plan; },
  };
}

test("29-PLAN create accepts a valid manual DRAFT and makes zero provider or network calls", async () => {
  networkGuard.resetStats();
  const repository = fakePlanRepository();
  const service = createPlanService({ repository, approvalRepository: { invalidateForPlan: async () => ({ count: 0 }) } });
  const created = await service.createDraft({ input: draftInput(), actor: AUTHOR });
  assert.equal(created.state, "DRAFT");
  assert.equal(created.version, 1);
  assert.equal(created.authorId, AUTHOR.id);
  assert.equal(repository.calls.created.length, 1);
  // Labels are preserved as provided (canonicalization happens in the fingerprint).
  assert.deepEqual(repository.calls.created[0].intent.labels, ["b", "a"]);
  assert.equal(networkGuard.stats().blocked, 0);
  assert.equal(networkGuard.stats().allowedLocal, 0);
});

test("29-PLAN create rejects invalid provider, connection, account, currency and empty operations", async () => {
  const service = createPlanService({ repository: fakePlanRepository() });
  await assert.rejects(service.createDraft({ input: draftInput({ provider: "BING" }), actor: AUTHOR }), (error) => error.code === "UNSUPPORTED_PROVIDER");
  await assert.rejects(service.createDraft({ input: draftInput({ connectionId: "not-a-uuid" }), actor: AUTHOR }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  await assert.rejects(service.createDraft({ input: draftInput({ accountId: "" }), actor: AUTHOR }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  await assert.rejects(service.createDraft({ input: draftInput({ currencyCode: "usd" }), actor: AUTHOR }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  await assert.rejects(service.createDraft({ input: draftInput({ currencyCode: "DOLLARS" }), actor: AUTHOR }), (error) => error.code === "INVALID_EXECUTION_PLAN");
  await assert.rejects(service.createDraft({ input: draftInput({ operations: [] }), actor: AUTHOR }), (error) => error.code === "INVALID_EXECUTION_PLAN");
});

test("29-PLAN create rejects raw provider payloads, credential fields, prototype keys and forged sources", () => {
  assert.throws(() => validatePlanInput(draftInput({ constraints: { rawPayload: { campaign: {} } } })), (error) => error.code === "RAW_PROVIDER_PAYLOAD_FORBIDDEN");
  assert.throws(() => validatePlanInput(draftInput({ constraints: { googleAdsPayload: {} } })), (error) => error.code === "RAW_PROVIDER_PAYLOAD_FORBIDDEN");
  assert.throws(() => validatePlanInput(draftInput({ constraints: { accessToken: "secret" } })), (error) => error.errors[0].reasonCode === "SECRET_FIELD_FORBIDDEN");
  assert.throws(() => validatePlanInput(draftInput({ constraints: { credentialEnvelope: { cipher: "x" } } })), (error) => error.errors[0].reasonCode === "SECRET_FIELD_FORBIDDEN");
  const prototypePoison = JSON.parse('{"constraints":{"__proto__":{"polluted":true}}}');
  assert.throws(() => validatePlanInput(draftInput({ constraints: prototypePoison.constraints })), (error) => error.code === "RAW_PROVIDER_PAYLOAD_FORBIDDEN");
  // Manual creation cannot forge a RECOMMENDATION or ROLLBACK source: the DTO is strict.
  assert.throws(() => validatePlanInput(draftInput({ sourceType: "RECOMMENDATION" })), (error) => error.code === "INVALID_EXECUTION_PLAN");
  assert.throws(() => validatePlanInput(draftInput({ sourceType: "ROLLBACK", sourceRecommendationId: "rec-1" })), (error) => error.code === "INVALID_EXECUTION_PLAN");
});

test("29-PLAN mixed provider, connection and account item scopes are rejected", () => {
  const base = { provider: "META", connectionId: CONNECTION, accountExternalId: "act_123" };
  const items = (mutation) => [
    { ...base, clientReference: "campaign", resourceType: "CAMPAIGN", operationType: "CREATE", dependsOn: [] },
    { ...base, ...mutation, clientReference: "group", resourceType: "GROUP", operationType: "CREATE", dependsOn: ["campaign"] },
  ];
  assert.throws(() => validateHierarchy(items({ provider: "TIKTOK" }), base), (error) => error.errors[0].reasonCode === "CROSS_PROVIDER_PARENT");
  assert.throws(() => validateHierarchy(items({ connectionId: "22222222-2222-4222-8222-222222222222" }), base), (error) => error.errors[0].reasonCode === "CROSS_CONNECTION_PARENT");
  assert.throws(() => validateHierarchy(items({ accountExternalId: "act_999" }), base), (error) => error.errors[0].reasonCode === "CROSS_ACCOUNT_PARENT");
  // A plan carries exactly one currencyCode, so multi-currency plans cannot be expressed.
  assert.throws(() => validatePlanInput(draftInput({ currencies: ["USD", "EUR"] })), (error) => error.code === "INVALID_EXECUTION_PLAN");
});

test("29-PLAN list pagination is bounded, filters are allowlisted and ordering is deterministic", async () => {
  const parsed = pagination({ page: "2", limit: "100", sortDirection: "asc" }, ["page", "limit", "sortDirection", "status"]);
  assert.deepEqual(parsed, { page: 2, limit: 100, skip: 100, sortDirection: "asc" });
  assert.throws(() => pagination({ limit: "101" }, ["limit"]), (error) => error.errors[0].reasonCode === "INVALID_INTEGER");
  assert.throws(() => pagination({ page: "0" }, ["page"]), (error) => error.errors[0].reasonCode === "INVALID_INTEGER");
  assert.throws(() => pagination({ unknownFilter: "x" }, ["page", "limit"]), (error) => error.code === "INVALID_EXECUTION_PLAN");
  assert.throws(() => pagination({ sortDirection: "RANDOM" }, ["sortDirection"]), (error) => error.errors[0].reasonCode === "UNSUPPORTED_VALUE");
  // Deterministic ordering: repository always appends the unique id tiebreaker.
  let captured;
  const repository = new PlanRepository({ client: { marketingExecutionPlan: { findMany: async (query) => { captured = query; return []; }, count: async () => 0 } } });
  await repository.list({});
  assert.deepEqual(captured.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
});

test("29-PLAN read mappers expose no secrets and separate current from historical validation", () => {
  const plan = {
    id: "plan-1", planNumber: "MEP-1", sourceType: "MANUAL", platform: "META", connectionId: CONNECTION,
    accountExternalId: "act_123", name: "Plan", status: "VALIDATED", version: 3, currencyCode: "USD",
    validationFingerprint: "a".repeat(64),
    desiredState: { provider: "META", accessToken: "must-not-appear", nested: { authorization: "Bearer x" } },
    items: [{ id: "item-1", sequence: 0, operationType: "CREATE", resourceType: "CAMPAIGN", clientReference: "campaign", dependsOnItemIds: [], intent: { refreshToken: "secret-intent" }, beforeState: null, materialHash: "b".repeat(64), status: "PENDING" }],
    validationIssues: [
      { id: "issue-current", planVersion: 3, validationFingerprint: "a".repeat(64), severity: "WARNING", code: "W1", fieldPath: "plan", message: "current" },
      { id: "issue-old", planVersion: 2, validationFingerprint: "c".repeat(64), severity: "ERROR", code: "E1", fieldPath: "plan", message: "historical" },
    ],
    validationPackets: [], approvals: [], runs: [],
    originalCompensations: [{ id: "link-1", originalPlanId: "orig-1", originalRunId: "run-1", originalOperationId: "op-1" }],
    compensationLinks: [{ id: "link-2", compensationPlanId: "comp-1", compensationRunId: null }],
  };
  const detail = mapPlanDetail(plan);
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("secret-intent"), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(detail.currentValidationIssues.length, 1);
  assert.equal(detail.currentValidationIssues[0].id, "issue-current");
  assert.equal(detail.historicalValidationIssueCount, 1);
  assert.equal(detail.compensation.originals[0].originalPlanId, "orig-1");
  assert.equal(detail.compensation.links[0].compensationPlanId, "comp-1");
  assert.equal(mapPlanSummary(plan).status, "VALIDATED");
});

test("29-PLAN update requires expectedVersion, detects stale versions and increments atomically", async () => {
  const invalidations = [];
  const repository = fakePlanRepository();
  const service = createPlanService({ repository, approvalRepository: { invalidateForPlan: async (id, reason) => { invalidations.push({ id, reason }); return { count: 0 }; } } });
  const plan = { id: "plan-1", state: "DRAFT", version: 2, intent: draftInput(), validationFingerprint: "a".repeat(64), validationSnapshot: {}, validatedAt: "2026-07-01T00:00:00.000Z" };
  await assert.rejects(service.editDraft({ plan, input: draftInput(), expectedVersion: 1 }), (error) => error.code === "PLAN_VERSION_CONFLICT");
  const edited = await service.editDraft({ plan, input: draftInput({ budgetLimit: 200 }), expectedVersion: 2 });
  assert.equal(edited.version, 3);
  assert.equal(edited.validationFingerprint, null);
  assert.equal(edited.validationSnapshot, null);
  assert.equal(edited.validatedAt, null);
  // Approvals are invalidated by versioned staleness, never deleted.
  assert.deepEqual(invalidations, [{ id: "plan-1", reason: "PLAN_MATERIAL_EDIT" }]);
});

test("29-PLAN concurrent durable updates produce exactly one winner via the optimistic predicate", async () => {
  let updates = 0;
  const client = {
    $transaction: (handler) => handler(client),
    marketingExecutionPlan: {
      // First transaction matches the (id, version, DRAFT) predicate; the
      // second arrives after the version increment and matches zero rows.
      updateMany: async () => ({ count: updates++ === 0 ? 1 : 0 }),
      findUnique: async () => ({ id: "plan-1", version: 3, status: "DRAFT", items: [] }),
    },
    marketingExecutionPlanItem: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
  };
  const repository = new PlanRepository({ client });
  const first = await repository.updateMaterial({ id: "plan-1", expectedVersion: 2, actorId: AUTHOR.id, desiredState: draftInput() });
  assert.equal(first.version, 3);
  await assert.rejects(
    repository.updateMaterial({ id: "plan-1", expectedVersion: 2, actorId: AUTHOR.id, desiredState: draftInput() }),
    (error) => error.code === "PLAN_VERSION_CONFLICT",
  );
});

test("29-PLAN every non-DRAFT state rejects edits and immutable scope changes require replacement", async () => {
  const service = createPlanService({ repository: fakePlanRepository(), approvalRepository: { invalidateForPlan: async () => ({ count: 0 }) } });
  for (const state of PLAN_STATES.filter((value) => value !== "DRAFT")) {
    assert.throws(() => assertEditable({ state }), (error) => error.code === "PLAN_NOT_EDITABLE", `state ${state} must not be editable`);
    await assert.rejects(service.editDraft({ plan: { id: "plan-1", state, version: 1 }, input: draftInput(), expectedVersion: 1 }), (error) => error.code === "PLAN_NOT_EDITABLE");
  }
  // Immutable provider/account/type changes are rejected as replacements, not edits.
  assert.throws(() => assertImmutableFields({ provider: "GOOGLE_ADS", current: { channelType: "SEARCH" }, requested: { channelType: "DISPLAY" } }), (error) => error.code === "IMMUTABLE_FIELD_CHANGE");
  assert.throws(() => assertImmutableFields({ provider: "GOOGLE_ADS", current: { accountExternalId: "111" }, requested: { accountExternalId: "222" } }), (error) => error.code === "IMMUTABLE_FIELD_CHANGE");
  assert.throws(() => assertImmutableFields({ provider: "META", current: { objective: "OUTCOME_LEADS" }, requested: { objective: "OUTCOME_SALES" } }), (error) => error.code === "IMMUTABLE_FIELD_CHANGE");
  assert.throws(() => assertImmutableFields({ provider: "X", current: { currencyCode: "USD" }, requested: { currencyCode: "EUR" } }), (error) => error.code === "IMMUTABLE_FIELD_CHANGE");
});

test("29-PLAN cancel is DRAFT-scoped, rejects submitted/approved/queued/running plans and preserves evidence", async () => {
  const service = createPlanService({ repository: fakePlanRepository(), approvalRepository: { invalidateForPlan: async () => ({ count: 0 }) } });
  assert.equal(service.cancel({ id: "plan-1", state: "DRAFT", version: 1 }).state, "CANCELLED");
  for (const state of ["APPROVED", "QUEUED", "SUCCEEDED", "CANCELLED"]) {
    assert.throws(() => service.cancel({ id: "plan-1", state }), (error) => error.code === "INVALID_PLAN_TRANSITION", `state ${state} cannot cancel`);
  }
  assert.throws(() => service.cancel({ id: "plan-1", state: "EXECUTING" }), (error) => error.errors[0].reconciliationRequired === true);

  // Durable cancel: non-eligible states match zero rows and nothing is deleted.
  const deletions = [];
  const client = {
    marketingExecutionPlan: {
      updateMany: async ({ where }) => ({ count: where.status.in.includes("DRAFT") && where.version === 1 ? 1 : 0 }),
      findUnique: async () => ({ id: "plan-1", status: "CANCELLED", items: [{ id: "item-1" }], approvals: [{ id: "approval-1" }] }),
    },
    marketingExecutionPlanItem: { deleteMany: async (...args) => { deletions.push(args); return { count: 0 }; } },
  };
  const repository = new PlanRepository({ client });
  const cancelled = await repository.cancel({ id: "plan-1", expectedVersion: 1, actorId: AUTHOR.id });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.items.length, 1, "items survive cancellation");
  assert.equal(cancelled.approvals.length, 1, "approval evidence survives cancellation");
  assert.equal(deletions.length, 0, "no destructive cascade runs on cancel");
  await assert.rejects(repository.cancel({ id: "plan-1", expectedVersion: 2, actorId: AUTHOR.id }), (error) => error.errors[0].reasonCode === "PLAN_NOT_CANCELLABLE");
});

test("29-PLAN validation lifecycle produces a version-bound fingerprint and queue demands a current packet", async () => {
  const service = createPlanService({ repository: fakePlanRepository(), approvalRepository: { invalidateForPlan: async () => ({ count: 0 }) } });
  const draft = { id: "plan-1", state: "DRAFT", version: 1, intent: draftInput() };
  const validating = service.beginValidation(draft);
  assert.equal(validating.state, "VALIDATING");
  const validated = service.completeValidation(validating);
  assert.equal(validated.state, "VALIDATED");
  assert.match(validated.validationFingerprint, /^[a-f0-9]{64}$/);
  // Reopening for material edit clears the packet and bumps the version.
  const reopened = service.reopenValidatedForMaterialEdit(validated, draftInput({ budgetLimit: 500 }));
  assert.equal(reopened.state, "DRAFT");
  assert.equal(reopened.version, 2);
  assert.equal(reopened.validationFingerprint, null);
  assert.deepEqual(reopened.approvals, []);
  // QUEUED requires a current approval packet.
  assert.throws(() => transitionPlan({ state: "APPROVED" }, "QUEUED", { approvalPacketCurrent: false }), (error) => error.code === "STALE_VALIDATION_FINGERPRINT");
  assert.equal(transitionPlan({ state: "APPROVED" }, "QUEUED", { approvalPacketCurrent: true }).state, "QUEUED");
});

test("29-PLAN fingerprint invalidation covers every material dimension and ignores non-material fields", () => {
  const base = draftInput({
    constraints: {
      destinationUrl: "https://example.test/landing?utm_source=meta&utm_campaign=summer",
      targeting: [{ type: "LOCATION", value: "US" }],
      placements: ["FACEBOOK_FEED"],
      bidding: { strategy: "LOWEST_COST", optimizationGoal: "LEAD_GENERATION" },
      schedule: { startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" },
      activationStatus: "PAUSED",
      creativeRevision: 3,
      dependencies: { ad: ["creative"] },
    },
  });
  const baseline = fingerprintPlan(base, 1).fingerprint;
  const materialMutations = {
    budget: { budgetLimit: 999 },
    currency: { currencyCode: "EUR" },
    provider: { provider: "TIKTOK" },
    accountScope: { accountId: "act_999" },
    connectionScope: { connectionId: "22222222-2222-4222-8222-222222222222" },
    operationOrder: { operations: [{ type: "CREATE_CAMPAIGN", targetId: "campaign-1", sequence: 1, parameters: { dailyBudget: "25.00" } }] },
    creativeRevision: { constraints: { ...base.constraints, creativeRevision: 4 } },
    destinationUrl: { constraints: { ...base.constraints, destinationUrl: "https://example.test/other" } },
    utm: { constraints: { ...base.constraints, destinationUrl: "https://example.test/landing?utm_source=meta&utm_campaign=winter" } },
    targeting: { constraints: { ...base.constraints, targeting: [{ type: "LOCATION", value: "IT" }] } },
    placements: { constraints: { ...base.constraints, placements: ["INSTAGRAM_FEED"] } },
    bidding: { constraints: { ...base.constraints, bidding: { strategy: "LOWEST_COST", optimizationGoal: "LINK_CLICKS" } } },
    schedule: { constraints: { ...base.constraints, schedule: { startAt: "2026-08-02T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" } } },
    activationStatus: { constraints: { ...base.constraints, activationStatus: "ACTIVE" } },
    dependencyGraph: { constraints: { ...base.constraints, dependencies: { ad: ["creative", "group"] } } },
  };
  for (const [dimension, mutation] of Object.entries(materialMutations)) {
    assert.notEqual(fingerprintPlan({ ...base, ...mutation }, 1).fingerprint, baseline, `material change to ${dimension} must invalidate the fingerprint`);
  }
  // Non-material changes never move the fingerprint.
  assert.ok(NON_MATERIAL_ROOT_FIELDS.has("displayMetadata"));
  const nonMaterial = { name: "Renamed", title: "Title", description: "New words", notes: "Reviewer notes", displayMetadata: { color: "blue" }, uiMetadata: { column: 2 } };
  assert.equal(fingerprintPlan({ ...base, ...nonMaterial }, 1).fingerprint, baseline);
  // Unordered labels canonicalize identically.
  assert.equal(fingerprintPlan({ ...base, labels: ["a", "b"] }, 1).fingerprint, fingerprintPlan({ ...base, labels: ["b", "a"] }, 1).fingerprint);
});

test("29-PLAN item sets reject duplicate sequences, references and forward dependencies before persistence", () => {
  assert.throws(() => validateItemSet([{ sequence: 0, clientReference: "a" }, { sequence: 0, clientReference: "b" }]), (error) => error.errors[0].reasonCode === "INVALID_OR_DUPLICATE_ITEM_SEQUENCE");
  assert.throws(() => validateItemSet([{ sequence: 0, clientReference: "a" }, { sequence: 1, clientReference: "a" }]), (error) => error.errors[0].reasonCode === "MISSING_OR_DUPLICATE_CLIENT_REFERENCE");
  const forward = [
    { id: "d1111111-1111-4111-8111-111111111111", sequence: 0, clientReference: "a", dependsOnItemIds: ["d2222222-2222-4222-8222-222222222222"] },
    { id: "d2222222-2222-4222-8222-222222222222", sequence: 1, clientReference: "b" },
  ];
  assert.throws(() => validateItemSet(forward), (error) => error.errors[0].reasonCode === "INVALID_ITEM_DEPENDENCY");
});
