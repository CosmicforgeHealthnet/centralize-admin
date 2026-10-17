const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter, normalizeBatchSubresponses } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");

const CONNECTION = "55555555-5555-4555-8555-555555555555";
const ACCOUNT = "act_123456";
const ENV = { MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" };
const connection = { id: CONNECTION, accountId: ACCOUNT, currency: "USD" };
const accountState = { oauthScopes: ["ads_management"], accountRole: "ADMIN", editReady: true, pageIdentityReady: true, instagramIdentityReady: true };

function campaign(overrides = {}) {
  return { name: "Meta auction", objective: "OUTCOME_LEADS", campaignType: "AUCTION", startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "campaign", bidding: { strategy: "LOWEST_COST", optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS" }, networkOrPlacements: ["FACEBOOK_FEED", "INSTAGRAM_FEED"], declarations: { specialAdCategory: "NONE" }, tracking: { utmTemplate: "utm_source=meta" }, ...overrides };
}

function item(clientReference, resourceType, dependsOn, intent) {
  return { provider: "META", connectionId: CONNECTION, accountExternalId: ACCOUNT, clientReference, resourceType, operationType: "CREATE", dependsOn, intent };
}

function plan(overrides = {}) {
  return { id: "66666666-6666-4666-8666-666666666666", planNumber: "MEP-META-1", provider: "META", connectionId: CONNECTION, accountExternalId: ACCOUNT, currencyCode: "USD", campaign: campaign(), items: [item("campaign", "CAMPAIGN", [], { name: "Meta auction" }), item("group", "GROUP", ["campaign"], { dailyBudget: "25.00" }), item("creative", "CREATIVE", ["group"], { pageId: "page-1", message: "Trusted care" }), item("ad", "AD", ["creative"], { name: "Lead ad" })], ...overrides };
}

function adapter(client = {}, options = {}) {
  return createProviderExecutionAdapter(PROVIDER_DEFINITIONS.META, { env: ENV, credentialResolver: async () => ({ token: "not-exposed" }), clientFactory: () => ({ validateGraph: async () => undefined, execute: async () => ({ requestId: "meta-req", resourceId: "cmp-1", returnedState: { name: "Meta auction" } }), readBack: async () => ({ name: "Meta auction" }), ...client }), ...options });
}

test("Meta capability exposes hierarchy and remains structurally write-disabled", () => {
  const result = adapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState, campaignType: "AUCTION", operationType: "CREATE", resourceType: "CAMPAIGN" });
  assert.equal(result.apiVersion, "v25.0");
  assert.equal(result.permissionReady, true);
  assert.equal(result.writeReady, false);
  assert.equal(result.providerDetails.batchSubresponsesRequired, true);
  assert.deepEqual(result.supportedCampaignTypes, ["AUCTION"]);
});

test("Meta validates campaign/ad-set/creative/ad order and identity ownership", async () => {
  const validated = await adapter().validatePlan({ plan: plan(), connection, accountState });
  assert.deepEqual(validated.operationGraph.map((operation) => operation.clientReference), ["campaign", "group", "creative", "ad"]);
  assert.ok(validated.operationGraph.every((operation) => operation.transportInstruction.createStatus === "PAUSED"));
  await assert.rejects(adapter().validatePlan({ plan: plan(), connection, accountState: { ...accountState, pageIdentityReady: false } }), (error) => error.code === "EXECUTION_PROVIDER_PERMISSION_ERROR");
  await assert.rejects(adapter().validatePlan({ plan: plan(), connection, accountState: { ...accountState, instagramIdentityReady: false } }), (error) => error.code === "EXECUTION_PROVIDER_PERMISSION_ERROR");
});

test("Meta regulated special categories are rejected before provider execution", async () => {
  await assert.rejects(adapter().validatePlan({ plan: plan({ campaign: campaign({ declarations: { specialAdCategory: "HOUSING" } }) }), connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && error.errors[0].reasonCode === "REGULATED_SPECIAL_CATEGORY_UNSUPPORTED");
});

test("Meta rejects incompatible objective, optimization, and billing combinations", async () => {
  await assert.rejects(adapter().validatePlan({ plan: plan({ campaign: campaign({ bidding: { strategy: "LOWEST_COST", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" } }) }), connection, accountState }), (error) => error.errors[0].reasonCode === "INCOMPATIBLE_OPTIMIZATION_GOAL");
  await assert.rejects(adapter().validatePlan({ plan: plan({ campaign: campaign({ bidding: { strategy: "LOWEST_COST", optimizationGoal: "LEAD_GENERATION", billingEvent: "LINK_CLICKS" } }) }), connection, accountState }), (error) => error.errors[0].reasonCode === "INCOMPATIBLE_BILLING_EVENT");
});

test("Meta validation pins discovered targeting and an immutable creative publication revision", async () => {
  const contentHash = "c".repeat(64);
  const creativePlan = plan({
    targeting: [{ clientReference: "rome", type: "LOCATION", query: "Rome", locationType: "CITY", radius: null, excluded: false }],
    items: [
      item("campaign", "CAMPAIGN", [], { name: "Meta auction" }),
      item("group", "GROUP", ["campaign"], { dailyBudget: "25.00" }),
      item("creative", "CREATIVE", ["group"], { pageId: "page-1", message: "Trusted care", creativePublicationId: "publication-1", contentHash }),
      item("ad", "AD", ["creative"], { name: "Lead ad" }),
    ],
  });
  const instance = adapter({}, {
    targetingResolver: async () => ({ normalizedId: "location:rome", nativeId: "1021865", displayName: "Rome" }),
    creativePublicationResolver: async () => ({ id: "publication-1", platform: "META", connectionId: CONNECTION, accountExternalId: ACCOUNT, revision: 3, contentHash, reviewStatus: "APPROVED", publicationMetadata: { providerReusePolicy: "REUSE_NATIVE_ID" } }),
  });
  const validated = await instance.validatePlan({ plan: creativePlan, connection, accountState });
  assert.equal(validated.targeting[0].nativeId, "1021865");
  assert.deepEqual(validated.creativePublications, [{ id: "publication-1", revision: 3, contentHash, reviewStatus: "APPROVED", providerReusePolicy: "REUSE_NATIVE_ID" }]);
  await assert.rejects(adapter({}, { targetingResolver: async () => ({ normalizedId: "location:rome", nativeId: "1021865" }), creativePublicationResolver: async () => ({ id: "publication-1", platform: "META", connectionId: CONNECTION, accountExternalId: ACCOUNT, revision: 4, contentHash: "d".repeat(64), reviewStatus: "APPROVED" }) }).validatePlan({ plan: creativePlan, connection, accountState }), (error) => error.code === "EXECUTION_PRECONDITION_CHANGED");
});

test("Meta batch subresponses preserve individual outcomes", () => {
  const results = normalizeBatchSubresponses([{ code: 200, body: { id: "1" } }, { code: 400, error: { code: 100, message: "Invalid objective" } }]);
  assert.deepEqual(results.map((entry) => entry.status), ["SUCCEEDED", "FAILED"]);
  assert.equal(results[1].providerCode, "100");
  assert.equal(results[1].message, "Invalid objective");
});

test("Meta errors normalize and compensation only proposes a separately approved pause", () => {
  const instance = adapter();
  const permission = instance.classifyError({ error: { response: { status: 403 }, message: "Permission denied" } });
  assert.equal(permission.category, "PERMISSION");
  assert.equal(permission.retryable, false);
  const limited = instance.classifyError({ error: { response: { status: 429, headers: { "retry-after": "60" } }, observedAt: "2026-07-22T10:00:00.000Z", message: "Account throttled" } });
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterAt, "2026-07-22T10:01:00.000Z");
  const compensation = instance.compensateOperation({ operation: { resourceType: "CAMPAIGN", nativeResourceId: "cmp-1" }, beforeState: { status: "ACTIVE" }, reason: "Downstream ad failed" });
  assert.equal(compensation.action, "PAUSE");
  assert.equal(compensation.deletionPromised, false);
  assert.equal(compensation.separateApprovalRequired, true);
});
