"use strict";

// Section 29 — X Ads mandatory suite (micro-units, parent budget limits,
// line-item targeting) using the shared fake X Ads API transport injected
// through the production adapter factory.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { toMicroUnits, fromMicroUnits } = require("../budgets/money");
const { resolveTargetingCriteria } = require("../targeting/targeting.validator");
const {
  createFakeProviderTransport, providerContext, providerPlanFixture, enabledExecutionContext,
} = require("./helpers/fake-provider-transports");

const { env, connection, accountState } = providerContext("X");

function buildAdapter(scenario = {}, options = {}) {
  const { transport, clientFactory } = createFakeProviderTransport("X", scenario);
  const adapter = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.X, {
    env,
    credentialResolver: async () => ({ syntheticCredential: true }),
    clientFactory,
    ...options,
  });
  return { adapter, transport };
}

test("29-X budgets and bids convert to exact local micro-units with boundary and overflow safety", async () => {
  const { adapter } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("X"), connection, accountState });
  const campaign = validated.operationGraph.find((entry) => entry.clientReference === "campaign").transportInstruction;
  const lineItem = validated.operationGraph.find((entry) => entry.clientReference === "line-item").transportInstruction;
  assert.deepEqual(campaign.fields.providerAmounts.dailyBudget, { unit: "MICROS", value: "20000000", major: "20" });
  assert.deepEqual(lineItem.fields.providerAmounts.bidAmount, { unit: "MICROS", value: "1500000", major: "1.5" });
  // Exact boundaries, unsupported precision and overflow.
  assert.equal(toMicroUnits("0.000001", {}).value, "1");
  assert.throws(() => toMicroUnits("0.0000005", {}), (error) => error.errors[0].reasonCode === "MICRO_UNIT_OVERFLOW");
  assert.throws(() => toMicroUnits("10.001", { currency: "USD" }), (error) => error.errors[0].reasonCode === "CURRENCY_PRECISION_EXCEEDED");
  assert.throws(() => toMicroUnits("99999999999999", {}), (error) => ["MICRO_UNIT_OVERFLOW", "MONEY_OUT_OF_RANGE"].includes(error.errors[0].reasonCode));
  // Round trip is loss-free (currency consistency).
  assert.equal(fromMicroUnits("1500000").toFixed(), "1.5");
});

test("29-X line-item budgets cannot exceed parent campaign or funding limits, with exact boundary pass", async () => {
  const { adapter } = buildAdapter();
  const limits = { campaignBudgetMaximum: "20.00", lineItemBudgetMaximum: "10.00", bidMaximum: "2.00" };
  // Exact boundary passes.
  const boundary = providerPlanFixture("X", { providerLimits: limits });
  boundary.items[1].intent.dailyBudget = "20.00";
  boundary.items[2].intent = { ...boundary.items[2].intent, budget: "10.00", bidAmount: "2.00" };
  const validated = await adapter.validatePlan({ plan: boundary, connection, accountState });
  assert.equal(validated.operationGraph.length, 4);
  // Over-limit failures per level with stable capability errors.
  const overCampaign = providerPlanFixture("X", { providerLimits: limits });
  overCampaign.items[1].intent.dailyBudget = "20.01";
  await assert.rejects(adapter.validatePlan({ plan: overCampaign, connection, accountState }), (error) => error.errors[0].reasonCode === "CAMPAIGN_BUDGET_LIMIT_EXCEEDED");
  const overLineItem = providerPlanFixture("X", { providerLimits: limits });
  overLineItem.items[2].intent = { ...overLineItem.items[2].intent, budget: "10.01" };
  await assert.rejects(adapter.validatePlan({ plan: overLineItem, connection, accountState }), (error) => error.errors[0].reasonCode === "LINE_ITEM_PARENT_BUDGET_EXCEEDED");
  const overBid = providerPlanFixture("X", { providerLimits: limits });
  overBid.items[2].intent = { ...overBid.items[2].intent, bidAmount: "2.01" };
  await assert.rejects(adapter.validatePlan({ plan: overBid, connection, accountState }), (error) => error.errors[0].reasonCode === "BID_LIMIT_EXCEEDED");
  // Shared funding source: the funding instrument is strictly read-only.
  const writingFunding = providerPlanFixture("X");
  writingFunding.items[0] = { ...writingFunding.items[0], operationType: "UPDATE" };
  await assert.rejects(adapter.validatePlan({ plan: writingFunding, connection, accountState }), (error) => error.errors[0].reasonCode === "FUNDING_INSTRUMENT_READ_ONLY");
});

test("29-X line-item targeting is typed, normalized, conflict-checked and regulated-category blocked", async () => {
  const context = { provider: "X", apiVersion: "12", connectionId: connection.id, accountExternalId: connection.accountId, resolver: async ({ criterion }) => ({ normalizedId: `x:${criterion.type.toLowerCase()}`, nativeId: `native-${criterion.type.toLowerCase()}`, displayName: criterion.query || criterion.value }) };
  const resolved = await resolveTargetingCriteria([
    { clientReference: "loc", type: "LOCATION", query: "United States", locationType: "COUNTRY", radius: null, excluded: false },
    { clientReference: "lang", type: "LANGUAGE", query: "en", excluded: false },
    { clientReference: "kw", type: "KEYWORD", value: "healthcare software", matchType: "BROAD", negative: false, scope: "GROUP", excluded: false },
    { clientReference: "device", type: "PLACEMENT", placement: "ALL_ON_TWITTER", mode: "MANUAL", device: "MOBILE", excluded: false },
  ], context);
  assert.equal(resolved[0].nativeId, "native-location");
  assert.equal(resolved[1].nativeId, "native-language");
  assert.equal(resolved[2].nativeId, null, "keywords are material values, not discovery ids");
  assert.equal(resolved[3].device, "MOBILE");
  // Include/exclude conflicts are surfaced, not silently rewritten.
  await assert.rejects(resolveTargetingCriteria([
    { clientReference: "a", type: "KEYWORD", value: "Care", matchType: "EXACT", negative: false, scope: "CAMPAIGN", excluded: false },
    { clientReference: "b", type: "KEYWORD", value: "care", matchType: "EXACT", negative: true, scope: "CAMPAIGN", excluded: false },
  ], context), (error) => error.errors[0].reasonCode === "TARGETING_INCLUDE_EXCLUDE_CONFLICT");
  // Unsupported targeting types fail the typed schema.
  await assert.rejects(resolveTargetingCriteria([{ clientReference: "bad", type: "CUSTOM_AUDIENCE", audienceId: "aud-1" }], context), (error) => error.errors[0].reasonCode === "INVALID_TYPED_TARGETING");
  // Provider capability: discovery is mandatory for resolvable types.
  await assert.rejects(resolveTargetingCriteria([{ clientReference: "loc", type: "LOCATION", query: "US", locationType: "COUNTRY", radius: null, excluded: false }], { ...context, resolver: undefined }), (error) => error.errors[0].reasonCode === "TARGETING_DISCOVERY_REQUIRED");
  // Regulated categories block X line items exactly like every other provider.
  await assert.rejects(resolveTargetingCriteria([], { ...context, advertisingCategory: "POLITICAL" }), (error) => error.errors[0].reasonCode === "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN");
});

test("29-X hierarchy stays deterministic, paused, and the fake transport witnesses micro units end-to-end", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("X"), connection, accountState });
  assert.deepEqual(validated.operationGraph.map((entry) => entry.clientReference), ["funding", "campaign", "line-item", "targeting"]);
  const executionContext = enabledExecutionContext("X");
  const created = await adapter.executeOperation({ operation: { ...validated.operationGraph[1], executionContext }, idempotencyKey: "x-key-1" });
  assert.equal(created.status, "SUCCEEDED");
  assert.equal(created.returnedState.status, "PAUSED");
  // The transport observed MICROS units, never floats or major-unit strings.
  const campaignRequest = transport.requests.find((request) => request.resourceType === "CAMPAIGN");
  assert.deepEqual(campaignRequest.monetaryUnits, { dailyBudget: "MICROS" });
  // Access and rate-limit errors normalize without leaking payloads.
  const { adapter: limited } = buildAdapter({ executeQueue: [{ kind: "RATE_LIMIT", retryAfterSeconds: 120, observedAt: "2026-07-23T10:00:00.000Z" }] });
  const throttled = await limited.executeOperation({ operation: { ...validated.operationGraph[1], executionContext }, idempotencyKey: "x-key-2" });
  assert.equal(throttled.error.category, "RATE_LIMIT");
  assert.equal(throttled.error.retryAfterAt, "2026-07-23T10:02:00.000Z");
});
