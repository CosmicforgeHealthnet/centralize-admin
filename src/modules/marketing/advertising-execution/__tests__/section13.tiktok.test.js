const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");

const CONNECTION = "77777777-7777-4777-8777-777777777777";
const ACCOUNT = "9876543210";
const ENV = { MARKETING_AD_EXECUTION_TIKTOK_API_VERSION: "v1.3" };
const connection = { id: CONNECTION, accountId: ACCOUNT, currency: "USD" };
const accountState = { oauthScopes: ["Ad Management"], accountRole: "ADMIN", editReady: true, sparkAuthorized: false };

function campaign(overrides = {}) {
  return { name: "TikTok manual", objective: "CONVERSIONS", campaignType: "MANUAL", startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "campaign", bidding: { strategy: "LOWEST_COST", optimizationGoal: "CONVERSION", billingEvent: "OCPM" }, networkOrPlacements: ["TIKTOK"], declarations: {}, tracking: { utmTemplate: "utm_source=tiktok" }, ...overrides };
}

function item(clientReference, resourceType, dependsOn, intent) {
  return { provider: "TIKTOK", connectionId: CONNECTION, accountExternalId: ACCOUNT, clientReference, resourceType, operationType: "CREATE", dependsOn, intent };
}

function plan(overrides = {}) {
  return { id: "88888888-8888-4888-8888-888888888888", planNumber: "MEP-TIKTOK-1", provider: "TIKTOK", connectionId: CONNECTION, accountExternalId: ACCOUNT, currencyCode: "USD", campaign: campaign(), items: [item("campaign", "CAMPAIGN", [], { name: "TikTok manual" }), item("group", "GROUP", ["campaign"], { budget: "50.00" }), item("creative", "CREATIVE", ["group"], { videoId: "video-1" }), item("ad", "AD", ["creative"], { name: "Manual ad" })], ...overrides };
}

function adapter(client = {}) {
  return createProviderExecutionAdapter(PROVIDER_DEFINITIONS.TIKTOK, { env: ENV, credentialResolver: async () => ({ token: "not-exposed" }), clientFactory: () => ({ execute: async () => ({ requestId: "tiktok-request", resourceId: "campaign-1", returnedState: { name: "TikTok manual", reviewStatus: "PENDING_REVIEW" } }), readBack: async () => ({ name: "TikTok manual" }), ...client }) });
}

test("TikTok capability is manual-only and reports Spark authorization requirements", () => {
  const result = adapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState, campaignType: "MANUAL", operationType: "CREATE", resourceType: "CAMPAIGN" });
  assert.equal(result.permissionReady, true);
  assert.equal(result.writeReady, false);
  assert.equal(result.providerDetails.manualCampaigns, true);
  assert.equal(result.providerDetails.smartPlus, false);
  assert.equal(result.providerDetails.sparkAdsRequireAuthorization, true);
});

test("TikTok rejects Smart+, Reach and Frequency, and unauthorized Spark ads", async () => {
  const instance = adapter();
  await assert.rejects(instance.validatePlan({ plan: plan({ smartPlus: true }), connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  await assert.rejects(instance.validatePlan({ plan: plan({ reachAndFrequency: true }), connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  await assert.rejects(instance.validatePlan({ plan: plan({ sparkAd: true }), connection, accountState }), (error) => error.errors[0].reasonCode === "SPARK_AUTHORIZATION_REQUIRED");
  await assert.rejects(instance.validatePlan({ plan: plan({ requiresAllowlistedPlacement: true }), connection, accountState }), (error) => error.errors[0].reasonCode === "PLACEMENT_ALLOWLIST_REQUIRED");
  await assert.rejects(instance.validatePlan({ plan: plan({ campaign: campaign({ bidding: { strategy: "LOWEST_COST", optimizationGoal: "CLICK", billingEvent: "OCPM" } }) }), connection, accountState }), (error) => error.errors[0].reasonCode === "INCOMPATIBLE_OPTIMIZATION_GOAL");
  const validated = await instance.validatePlan({ plan: plan({ sparkAd: true }), connection, accountState: { ...accountState, sparkAuthorized: true } });
  assert.equal(validated.campaign.status, "PAUSED");
});

test("TikTok operation keys are deterministic and independent of provider request IDs", async () => {
  const instance = adapter();
  const first = await instance.validatePlan({ plan: plan(), connection, accountState });
  const second = await instance.validatePlan({ plan: plan(), connection, accountState });
  assert.deepEqual(first.operationGraph.map((entry) => entry.providerOperationKey), second.operationGraph.map((entry) => entry.providerOperationKey));
  assert.ok(first.operationGraph.every((entry) => /^[a-f0-9]{64}$/.test(entry.providerOperationKey)));
  assert.ok(first.operationGraph.every((entry) => !entry.providerOperationKey.includes("tiktok-request")));
});

test("TikTok normalizes review state and preserves unknown-outcome no-retry semantics", async () => {
  const instance = adapter();
  const validated = await instance.validatePlan({ plan: plan(), connection, accountState });
  const executionContext = { globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true, connection, accountExternalId: ACCOUNT };
  const result = await instance.executeOperation({ operation: { ...validated.operationGraph[0], executionContext } });
  assert.equal(result.returnedState.reviewStatus, "PENDING_REVIEW");
  const uncertain = adapter({ execute: async () => { const error = new Error("network ended after submission"); error.outcomeUnknown = true; throw error; } });
  const unknown = await uncertain.executeOperation({ operation: { ...validated.operationGraph[0], executionContext } });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.retryable, false);
});
