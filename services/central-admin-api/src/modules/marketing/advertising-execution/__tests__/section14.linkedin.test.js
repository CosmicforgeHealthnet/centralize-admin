const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");

const CONNECTION = "99999999-9999-4999-8999-999999999999";
const ACCOUNT = "urn:li:sponsoredAccount:123";
const ENV = { MARKETING_AD_EXECUTION_LINKEDIN_API_VERSION: "202607" };
const connection = { id: CONNECTION, accountId: ACCOUNT, currency: "USD" };
const accountState = { oauthScopes: ["rw_ads"], accountRole: "CAMPAIGN_MANAGER", accessTier: "STANDARD", editReady: true };

function campaign(overrides = {}) {
  return { name: "LinkedIn sponsored content", objective: "LEAD_GENERATION", campaignType: "SPONSORED_CONTENT", startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "campaign-group", bidding: { strategy: "MAXIMUM_DELIVERY", optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS" }, networkOrPlacements: ["LINKEDIN_FEED"], declarations: {}, tracking: { utmTemplate: "utm_source=linkedin" }, ...overrides };
}

function item(clientReference, resourceType, dependsOn, intent) {
  return { provider: "LINKEDIN", connectionId: CONNECTION, accountExternalId: ACCOUNT, clientReference, resourceType, operationType: "CREATE", dependsOn, intent };
}

function plan(overrides = {}) {
  return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", planNumber: "MEP-LINKEDIN-1", provider: "LINKEDIN", connectionId: CONNECTION, accountExternalId: ACCOUNT, currencyCode: "USD", campaign: campaign(), items: [item("campaign-group", "CAMPAIGN_GROUP", [], { name: "Health group" }), item("campaign", "CAMPAIGN", ["campaign-group"], { name: "Lead campaign" }), item("creative", "CREATIVE", ["campaign"], { organization: "urn:li:organization:456" })], ...overrides };
}

function adapter() {
  return createProviderExecutionAdapter(PROVIDER_DEFINITIONS.LINKEDIN, { env: ENV, credentialResolver: async () => ({ token: "not-exposed" }), clientFactory: () => ({ execute: async () => ({ requestId: "li-request", resourceId: "urn:li:sponsoredCampaign:1" }), readBack: async () => ({ name: "Lead campaign" }) }) });
}

test("LinkedIn capability enforces rw_ads, eligible roles and configured monthly version", () => {
  const capable = adapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState, campaignType: "SPONSORED_CONTENT", operationType: "CREATE", resourceType: "CAMPAIGN" });
  assert.equal(capable.apiVersion, "202607");
  assert.equal(capable.permissionReady, true);
  assert.equal(capable.writeReady, false);
  assert.equal(capable.providerDetails.restBase, "/rest/");
  const missingScope = adapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState: { ...accountState, oauthScopes: [] } });
  assert.equal(missingScope.permissionReady, false);
  assert.ok(missingScope.accountRestrictions.includes("REQUIRED_OAUTH_SCOPE_MISSING"));
});

test("LinkedIn operation graph uses /rest version headers and PAUSED creates", async () => {
  const validated = await adapter().validatePlan({ plan: plan(), connection, accountState });
  assert.deepEqual(validated.operationGraph.map((operation) => operation.clientReference), ["campaign-group", "campaign", "creative"]);
  for (const operation of validated.operationGraph) {
    assert.deepEqual(operation.transportInstruction.headers, { "Linkedin-Version": "202607", "X-Restli-Protocol-Version": "2.0.0" });
    assert.equal(operation.transportInstruction.createStatus, "PAUSED");
  }
});

test("LinkedIn Development tier and protected-characteristic targeting fail closed", async () => {
  await assert.rejects(adapter().validatePlan({ plan: plan(), connection, accountState: { ...accountState, accessTier: "DEVELOPMENT", editReady: false } }), (error) => error.code === "EXECUTION_PROVIDER_PERMISSION_ERROR");
  await assert.rejects(adapter().validatePlan({ plan: plan({ targeting: [{ field: "age", protectedCharacteristic: true }] }), connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && error.errors[0].reasonCode === "DISCRIMINATORY_TARGETING_FORBIDDEN");
  await assert.rejects(adapter().validatePlan({ plan: plan({ campaignFormat: "VIDEO", items: [item("campaign-group", "CAMPAIGN_GROUP", [], {}), item("campaign", "CAMPAIGN", ["campaign-group"], {}), item("creative", "CREATIVE", ["campaign"], { format: "SINGLE_IMAGE" })] }), connection, accountState }), (error) => error.errors[0].reasonCode === "CAMPAIGN_CREATIVE_FORMAT_MISMATCH");
});

test("LinkedIn provider errors preserve permission and retry classification", () => {
  const permission = adapter().classifyError({ error: { statusCode: 403, providerCode: "ACCESS_DENIED", message: "Not permitted" } });
  assert.equal(permission.category, "PERMISSION");
  assert.equal(permission.retryable, false);
  const limited = adapter().classifyError({ error: { statusCode: 429, retryAfterAt: "2026-07-22T10:01:00.000Z" } });
  assert.equal(limited.category, "RATE_LIMIT");
  assert.equal(limited.retryable, true);
});
