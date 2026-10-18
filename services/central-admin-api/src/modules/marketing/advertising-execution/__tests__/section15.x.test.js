const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");

const CONNECTION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = "x-account-123";
const ENV = { MARKETING_AD_EXECUTION_X_API_VERSION: "12" };
const connection = { id: CONNECTION, accountId: ACCOUNT, currency: "USD" };
const accountState = { oauthScopes: ["ADS_API_WRITE"], accountRole: "ACCOUNT_ADMIN", editReady: true, fundingInstrumentReady: true };

function campaign(overrides = {}) {
  return { name: "X promoted posts", objective: "WEBSITE_CLICKS", campaignType: "PROMOTED_TWEETS", startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "funding", bidding: { strategy: "AUTO_BID", optimizationGoal: "LINK_CLICKS", billingEvent: "ENGAGEMENT" }, networkOrPlacements: ["ALL_ON_TWITTER"], declarations: {}, tracking: { utmTemplate: "utm_source=x" }, ...overrides };
}

function item(clientReference, resourceType, operationType, dependsOn, intent) {
  return { provider: "X", connectionId: CONNECTION, accountExternalId: ACCOUNT, clientReference, resourceType, operationType, dependsOn, intent };
}

function plan(overrides = {}) {
  return { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", planNumber: "MEP-X-1", provider: "X", connectionId: CONNECTION, accountExternalId: ACCOUNT, currencyCode: "USD", campaign: campaign(), items: [item("funding", "FUNDING_INSTRUMENT", "READ", [], { id: "fi-1" }), item("campaign", "CAMPAIGN", "CREATE", ["funding"], { name: "X promoted posts", dailyBudget: "20.00" }), item("line-item", "GROUP", "CREATE", ["campaign"], { bidAmount: "1.50" }), item("targeting", "TARGETING", "CREATE", ["line-item"], { location: "US" }), item("promoted", "ASSET_LINK", "CREATE", ["line-item"], { organicTweetId: "12345" })], ...overrides };
}

function adapter() {
  return createProviderExecutionAdapter(PROVIDER_DEFINITIONS.X, { env: ENV, credentialResolver: async () => ({ oauth: "not-exposed" }), clientFactory: () => ({ execute: async () => ({ requestId: "x-request", resourceId: "campaign-1" }), readBack: async () => ({ name: "X promoted posts" }) }) });
}

test("X capability requires Ads API access and never claims organic publishing", () => {
  const capable = adapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState, campaignType: "PROMOTED_TWEETS", operationType: "CREATE", resourceType: "CAMPAIGN" });
  assert.equal(capable.apiVersion, "12");
  assert.equal(capable.permissionReady, true);
  assert.equal(capable.writeReady, false);
  assert.equal(capable.providerDetails.adsApiAccessRequired, true);
  assert.equal(capable.providerDetails.organicPublishingSupported, false);
  const restricted = adapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState: { ...accountState, editReady: false } });
  assert.equal(restricted.permissionReady, false);
  assert.ok(restricted.accountRestrictions.includes("ACCOUNT_EDIT_PERMISSION_UNAVAILABLE"));
});

test("X funding instruments are preflight-only and hierarchy is deterministic", async () => {
  const validated = await adapter().validatePlan({ plan: plan(), connection, accountState });
  assert.deepEqual(validated.operationGraph.map((entry) => entry.clientReference), ["funding", "campaign", "line-item", "targeting", "promoted"]);
  assert.equal(validated.operationGraph[0].operationType, "READ");
  await assert.rejects(adapter().validatePlan({ plan: plan({ items: [item("funding", "FUNDING_INSTRUMENT", "UPDATE", [], { id: "fi-1" })] }), connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && error.errors[0].reasonCode === "FUNDING_INSTRUMENT_READ_ONLY");
});

test("X campaign and line-item budgets use exact local micro-units", async () => {
  const candidate = plan();
  candidate.items[1].resourceType = "BUDGET";
  candidate.items[1].intent = { amount: "20.00" };
  candidate.items[2].dependsOn = ["campaign"];
  const validated = await adapter().validatePlan({ plan: candidate, connection, accountState });
  const budget = validated.operationGraph.find((entry) => entry.clientReference === "campaign");
  assert.deepEqual(budget.transportInstruction.fields.providerAmount, { unit: "MICROS", value: "20000000", major: "20" });
  const regular = await adapter().validatePlan({ plan: plan(), connection, accountState });
  assert.deepEqual(regular.operationGraph.find((entry) => entry.clientReference === "campaign").transportInstruction.fields.providerAmounts.dailyBudget, { unit: "MICROS", value: "20000000", major: "20" });
});

test("X enforces provider campaign, line-item, and bid limits before approval", async () => {
  const limits = { campaignBudgetMaximum: "10", lineItemBudgetMaximum: "5", bidMaximum: "1" };
  const limitedState = { ...accountState, providerLimits: limits };
  await assert.rejects(adapter().validatePlan({ plan: plan(), connection, accountState: limitedState }), (error) => error.errors[0].reasonCode === "CAMPAIGN_BUDGET_LIMIT_EXCEEDED");
  const candidate = plan();
  candidate.items[1].intent.dailyBudget = "10";
  candidate.items[2].intent = { budget: "6", bidAmount: "0.50" };
  await assert.rejects(adapter().validatePlan({ plan: candidate, connection, accountState: limitedState }), (error) => error.errors[0].reasonCode === "LINE_ITEM_PARENT_BUDGET_EXCEEDED");
  candidate.items[2].intent = { budget: "5", bidAmount: "1.50" };
  await assert.rejects(adapter().validatePlan({ plan: candidate, connection, accountState: limitedState }), (error) => error.errors[0].reasonCode === "BID_LIMIT_EXCEEDED");
});

test("X access and rate-limit errors are normalized without leaking provider payloads", () => {
  const denied = adapter().classifyError({ error: { statusCode: 403, providerCode: "UNAUTHORIZED_ACCESS", message: "Ads API access required" } });
  assert.equal(denied.category, "PERMISSION");
  assert.equal(denied.retryable, false);
  const limited = adapter().classifyError({ error: { statusCode: 429, message: "Rate limited" } });
  assert.equal(limited.category, "RATE_LIMIT");
  assert.equal(limited.retryable, true);
});
