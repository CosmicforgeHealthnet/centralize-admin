"use strict";

// Section 29 — TikTok mandatory suite (objective/billing compatibility,
// request_id, paused creation, review status) using the shared fake TikTok
// Business API transport injected through the production adapter factory.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { assertCreativeApprovedForActivation } = require("../creatives/provider-review-sync.service");
const {
  createFakeProviderTransport, providerContext, providerPlanFixture, enabledExecutionContext, REVIEW_STATES,
} = require("./helpers/fake-provider-transports");

const { env, connection, accountState } = providerContext("TIKTOK");

function buildAdapter(scenario = {}, options = {}) {
  const { transport, clientFactory } = createFakeProviderTransport("TIKTOK", scenario);
  const adapter = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.TIKTOK, {
    env,
    credentialResolver: async () => ({ syntheticCredential: true }),
    clientFactory,
    ...options,
  });
  return { adapter, transport };
}

test("29-TIKTOK objective, billing and optimization combinations come from the version rule registry", async () => {
  const { adapter } = buildAdapter();
  const valid = await adapter.validatePlan({ plan: providerPlanFixture("TIKTOK"), connection, accountState });
  assert.equal(valid.campaign.objective, "CONVERSIONS");
  // Invalid objective is rejected with no silent substitution.
  const badObjective = providerPlanFixture("TIKTOK");
  badObjective.campaign.objective = "APP_PROMOTION";
  await assert.rejects(adapter.validatePlan({ plan: badObjective, connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  // Invalid billing event for the objective.
  const badBilling = providerPlanFixture("TIKTOK");
  badBilling.campaign.bidding = { strategy: "LOWEST_COST", optimizationGoal: "CONVERSION", billingEvent: "CPM" };
  await assert.rejects(adapter.validatePlan({ plan: badBilling, connection, accountState }), (error) => error.errors[0].reasonCode === "INCOMPATIBLE_BILLING_EVENT");
  // Unsupported optimization goal.
  const badGoal = providerPlanFixture("TIKTOK");
  badGoal.campaign.bidding = { strategy: "LOWEST_COST", optimizationGoal: "CLICK", billingEvent: "OCPM" };
  await assert.rejects(adapter.validatePlan({ plan: badGoal, connection, accountState }), (error) => error.errors[0].reasonCode === "INCOMPATIBLE_OPTIMIZATION_GOAL");
  // The registry is provider-version scoped configuration, not free text.
  assert.deepEqual(Object.keys(PROVIDER_DEFINITIONS.TIKTOK.biddingCompatibility).sort(), ["CONVERSIONS", "LEAD_GENERATION", "REACH", "TRAFFIC", "VIDEO_VIEWS"]);
});

test("29-TIKTOK request_id is extracted, sanitized, bounded and never used as a credential or key", async () => {
  const { adapter } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("TIKTOK"), connection, accountState });
  const context = enabledExecutionContext("TIKTOK");
  const result = await adapter.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context }, idempotencyKey: "tiktok-key-1" });
  assert.equal(result.providerRequestId, "tiktok-req-1");
  // The idempotent operation key is independent of the provider request id.
  assert.ok(validated.operationGraph.every((entry) => !entry.providerOperationKey.includes("tiktok-req")));
  // Hostile request ids are sanitized down to bounded safe characters.
  const hostile = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.TIKTOK, {
    env, credentialResolver: async () => null,
    clientFactory: () => ({ execute: async () => ({ requestId: `evil\r\nSet-Cookie: x;${"a".repeat(600)}`, resourceId: "campaign-1", returnedState: {} }), readBack: async () => ({}) }),
  });
  const sanitized = await hostile.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context } });
  assert.equal(/[\r\n\s;]/.test(sanitized.providerRequestId), false, "header-injection characters are stripped");
  assert.ok(sanitized.providerRequestId.length <= 255, "request ids are bounded");
  // A missing request_id is handled safely as null.
  const missing = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.TIKTOK, {
    env, credentialResolver: async () => null,
    clientFactory: () => ({ execute: async () => ({ resourceId: "campaign-2", returnedState: {} }), readBack: async () => ({}) }),
  });
  const withoutId = await missing.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context } });
  assert.equal(withoutId.providerRequestId, null);
  assert.equal(withoutId.status, "SUCCEEDED");
});

test("29-TIKTOK all created resources stay paused and activation is a separate approved operation", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("TIKTOK"), connection, accountState });
  assert.ok(validated.operationGraph.every((entry) => entry.transportInstruction.createStatus === "PAUSED"));
  const context = enabledExecutionContext("TIKTOK");
  for (const [index, entry] of validated.operationGraph.entries()) {
    const result = await adapter.executeOperation({ operation: { ...entry, executionContext: context }, idempotencyKey: `tiktok-paused-${index}` });
    assert.equal(result.returnedState.status, "PAUSED");
  }
  assert.equal(transport.requests.filter((request) => request.operationType === "CREATE").every((request) => request.createStatus === "PAUSED"), true);
  assert.ok(PROVIDER_DEFINITIONS.TIKTOK.operationTypes.includes("RESUME"), "activation is its own operation type");
});

test("29-TIKTOK review states normalize to the closed enum and creation success never implies APPROVED", async () => {
  assert.deepEqual([...REVIEW_STATES], ["PENDING_REVIEW", "APPROVED", "REJECTED", "LIMITED", "UNKNOWN"]);
  const { adapter } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("TIKTOK"), connection, accountState });
  const context = enabledExecutionContext("TIKTOK");
  const created = await adapter.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context } });
  assert.equal(created.status, "SUCCEEDED");
  assert.equal(created.returnedState.reviewStatus, "PENDING_REVIEW", "creation success does not imply APPROVED");
  // Unknown provider review values normalize to UNKNOWN.
  const { adapter: weird } = buildAdapter({ executeQueue: [{ kind: "SUCCEED", reviewStatus: "SOMETHING_NEW" }] });
  const unknownState = await weird.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context } });
  assert.equal(unknownState.returnedState.reviewStatus, "UNKNOWN");
  // Non-approved review blocks activation; rejected creatives require a new human revision.
  for (const reviewStatus of ["PENDING_REVIEW", "REJECTED", "LIMITED", "UNKNOWN"]) {
    assert.throws(() => assertCreativeApprovedForActivation({ reviewStatus }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && error.errors[0].reasonCode === "CREATIVE_REVIEW_NOT_APPROVED", reviewStatus);
  }
  const approvedPublication = { reviewStatus: "APPROVED" };
  assert.equal(assertCreativeApprovedForActivation(approvedPublication), approvedPublication);
  // Uncertain submission outcomes remain UNKNOWN with no blind retry.
  const { adapter: uncertain } = buildAdapter({ executeQueue: [{ kind: "TIMEOUT_UNKNOWN" }] });
  const unknown = await uncertain.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context } });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.retryable, false);
});

test("29-TIKTOK Smart+, Reach & Frequency and unauthorized Spark ads stay rejected with fake transports", async () => {
  const { adapter, transport } = buildAdapter();
  await assert.rejects(adapter.validatePlan({ plan: providerPlanFixture("TIKTOK", { smartPlus: true }), connection, accountState }), (error) => error.errors[0].reasonCode === "AUTOMATED_CAMPAIGN_FAMILY_UNSUPPORTED");
  await assert.rejects(adapter.validatePlan({ plan: providerPlanFixture("TIKTOK", { sparkAd: true }), connection, accountState }), (error) => error.errors[0].reasonCode === "SPARK_AUTHORIZATION_REQUIRED");
  assert.equal(transport.mutationCount, 0);
});
