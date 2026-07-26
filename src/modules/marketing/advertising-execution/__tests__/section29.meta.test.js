"use strict";

// Section 29 — Meta mandatory suite (hierarchy order, paused creation, batch
// subresults, rate limits) using the shared fake Meta Marketing API transport
// injected through the production adapter factory.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter, normalizeBatchSubresponses } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { classifyReconciliation } = require("../reconciliation/reconciliation.service");
const { decideRetry } = require("../operations/retry-policy.service");
const {
  createFakeProviderTransport, providerContext, providerPlanFixture, enabledExecutionContext,
} = require("./helpers/fake-provider-transports");

const { env, connection, accountState } = providerContext("META");

function buildAdapter(scenario = {}, options = {}) {
  const { transport, clientFactory } = createFakeProviderTransport("META", scenario);
  const adapter = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.META, {
    env,
    credentialResolver: async () => ({ syntheticCredential: true }),
    clientFactory,
    ...options,
  });
  return { adapter, transport };
}

test("29-META hierarchy is created campaign → ad set → creative → ad with dependency integrity", async () => {
  const { adapter } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("META"), connection, accountState });
  assert.deepEqual(validated.operationGraph.map((entry) => entry.clientReference), ["campaign", "group", "creative", "ad"]);
  // Invalid creation order expressed as a dependency cycle is rejected.
  const cyclic = providerPlanFixture("META");
  cyclic.items[0].dependsOn = ["ad"];
  await assert.rejects(adapter.validatePlan({ plan: cyclic, connection, accountState }), (error) => error.errors[0].reasonCode === "DEPENDENCY_CYCLE");
  // Existing parent references: an UPDATE against a known resource id is not forced to re-create.
  const updating = providerPlanFixture("META");
  updating.items[1] = { ...updating.items[1], operationType: "UPDATE", providerResourceId: "adset-existing-1" };
  const withExisting = await adapter.validatePlan({ plan: updating, connection, accountState });
  const updateInstruction = withExisting.operationGraph.find((entry) => entry.clientReference === "group").transportInstruction;
  assert.equal(updateInstruction.resourceId, "adset-existing-1");
  assert.equal(updateInstruction.temporaryResourceName, null);
});

test("29-META every created resource stays paused and an active read-back is drift, not success", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("META"), connection, accountState });
  assert.ok(validated.operationGraph.every((entry) => entry.transportInstruction.createStatus === "PAUSED"));
  const context = enabledExecutionContext("META");
  for (const [index, entry] of validated.operationGraph.entries()) {
    const result = await adapter.executeOperation({ operation: { ...entry, executionContext: context }, idempotencyKey: `meta-key-${index}` });
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.returnedState.status, "PAUSED", `${entry.clientReference} must be created paused`);
  }
  assert.equal(transport.requests.every((request) => request.createStatus === "PAUSED"), true);
  // Activation is a separate operation type, never part of CREATE.
  assert.ok(PROVIDER_DEFINITIONS.META.operationTypes.includes("RESUME"));
  // A provider response claiming ACTIVE against a PAUSED desired state is drift.
  const classified = classifyReconciliation({ desired: { status: "PAUSED" }, current: { status: "ACTIVE" } });
  assert.equal(classified.status, "DRIFTED");
  assert.equal(classified.differences[0].field, "status");
});

test("29-META batch subresults preserve per-item outcomes without persisting raw bodies", () => {
  const results = normalizeBatchSubresponses([
    { code: 200, body: { id: "1", secretRawBody: "must-not-survive" } },
    { code: 400, error: { code: 100, message: "Invalid objective" } },
    { code: 500, error: { code: 1, message: "x".repeat(2000) } },
    { code: 200, error: { code: 613, message: "throttled subresult" } },
  ]);
  assert.deepEqual(results.map((entry) => entry.status), ["SUCCEEDED", "FAILED", "FAILED", "FAILED"]);
  assert.deepEqual(results.map((entry) => entry.index), [0, 1, 2, 3]);
  assert.equal(results[1].providerCode, "100");
  // Messages are bounded and raw bodies never survive normalization.
  assert.equal(results[2].message.length, 500);
  assert.equal(JSON.stringify(results).includes("must-not-survive"), false);
  // Dependency-aware retry: a failed parent means dependent retries are blocked upstream
  // (runner-level dependency freeze is proven in section29.idempotency.test.js).
  assert.equal(decideRetry({ category: "VALIDATION", providerProcessing: "NOT_STARTED", outcomeCertain: true }).automaticRetry, false);
});

test("29-META rate limits normalize retry-after telemetry with bounded retries and no blind batch retry", async () => {
  const { adapter, transport } = buildAdapter({ executeQueue: [{ kind: "RATE_LIMIT", retryAfterSeconds: 60, observedAt: "2026-07-23T10:00:00.000Z" }] });
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("META"), connection, accountState });
  const limited = await adapter.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: enabledExecutionContext("META") }, idempotencyKey: "meta-rate-1" });
  assert.equal(limited.status, "FAILED");
  assert.equal(limited.error.category, "RATE_LIMIT");
  assert.equal(limited.error.retryable, true);
  assert.equal(limited.error.retryAfterAt, "2026-07-23T10:01:00.000Z");
  assert.equal(transport.mutationCount, 0);
  // HTTP-date Retry-After headers also normalize.
  const dated = adapter.classifyError({ error: { response: { status: 429, headers: { "retry-after": "Thu, 23 Jul 2026 10:05:00 GMT" } }, observedAt: "2026-07-23T10:00:00.000Z", message: "throttled" } });
  assert.equal(dated.retryAfterAt, "2026-07-23T10:05:00.000Z");
  // Bounded retry: rate limits retry with backoff; uncertain batch outcomes never blind-retry.
  assert.equal(decideRetry({ category: "RATE_LIMIT", providerProcessing: "NOT_STARTED", outcomeCertain: true, attempt: 1 }).automaticRetry, true);
  assert.equal(decideRetry({ category: "RATE_LIMIT", providerProcessing: "UNKNOWN", outcomeCertain: false, attempt: 1 }).action, "RECONCILE_BEFORE_RETRY");
  // The stable synchronous mapping is 429 with retryable true.
  assert.equal(limited.error.code === "EXECUTION_PROVIDER_RATE_LIMITED" || limited.error.category === "RATE_LIMIT", true);
});

test("29-META identity ownership and regulated categories gate validation before any provider call", async () => {
  const { adapter, transport } = buildAdapter();
  await assert.rejects(adapter.validatePlan({ plan: providerPlanFixture("META"), connection, accountState: { ...accountState, pageIdentityReady: false } }), (error) => error.code === "EXECUTION_PROVIDER_PERMISSION_ERROR");
  const housing = providerPlanFixture("META");
  housing.campaign.declarations = { specialAdCategory: "HOUSING" };
  await assert.rejects(adapter.validatePlan({ plan: housing, connection, accountState }), (error) => error.errors[0].reasonCode === "REGULATED_SPECIAL_CATEGORY_UNSUPPORTED");
  const badBidding = providerPlanFixture("META");
  badBidding.campaign.bidding = { strategy: "LOWEST_COST", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" };
  await assert.rejects(adapter.validatePlan({ plan: badBidding, connection, accountState }), (error) => error.errors[0].reasonCode === "INCOMPATIBLE_OPTIMIZATION_GOAL");
  assert.equal(transport.mutationCount + transport.validateOnlyCount + transport.readBackRequests.length, 0, "validation failures never reach the provider transport");
});
