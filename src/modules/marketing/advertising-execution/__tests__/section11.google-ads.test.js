const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { normalizeGoogleCustomerId, createLazyGoogleAdsClientFactory } = require("../adapters/google-ads/google-ads.auth");
const { GAQL_PREFLIGHT_FIELDS, buildGaqlPreflightQuery, runGaqlPreflight } = require("../adapters/google-ads/google-ads.preflight");

const CONNECTION = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "1234567890";
const ENV = { MARKETING_AD_EXECUTION_GOOGLE_ADS_API_VERSION: "v24" };

function campaign(overrides = {}) {
  return {
    name: "Phase 3 search",
    objective: "LEADS",
    campaignType: "SEARCH",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-09-01T00:00:00.000Z",
    budgetRef: "budget",
    bidding: { strategy: "MANUAL_CPC", bidAmount: "1.25" },
    networkOrPlacements: ["SEARCH"],
    declarations: { euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" },
    tracking: { utmTemplate: "utm_source=google" },
    ...overrides,
  };
}

function item(clientReference, resourceType, dependsOn = [], intent = {}) {
  return { provider: "GOOGLE_ADS", connectionId: CONNECTION, accountExternalId: ACCOUNT, clientReference, resourceType, operationType: "CREATE", dependsOn, intent };
}

function plan(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    planNumber: "MEP-GOOGLE-1",
    provider: "GOOGLE_ADS",
    connectionId: CONNECTION,
    accountExternalId: ACCOUNT,
    currencyCode: "USD",
    campaign: campaign(),
    items: [
      item("budget", "BUDGET", [], { amount: "10.00", explicitlyShared: false }),
      item("campaign", "CAMPAIGN", ["budget"], { name: "Phase 3 search" }),
      item("language", "TARGETING", ["campaign"], { scope: "CAMPAIGN", criterionKind: "LANGUAGE", language: "en" }),
      item("location", "TARGETING", ["campaign"], { scope: "CAMPAIGN", criterionKind: "LOCATION", location: "US" }),
      item("negative", "TARGETING", ["campaign"], { scope: "CAMPAIGN", criterionKind: "NEGATIVE", keyword: "free" }),
      item("group", "GROUP", ["campaign"], { name: "Main group" }),
      item("group-target", "TARGETING", ["group"], { scope: "AD_GROUP", criterionKind: "KEYWORD", keyword: "health network" }),
      item("asset", "CREATIVE", ["campaign"], { text: "Trusted care" }),
      item("ad", "AD", ["group", "asset"], { finalUrl: "https://example.test/health" }),
      item("link", "ASSET_LINK", ["campaign", "asset"], { fieldType: "CALLOUT" }),
    ],
    ...overrides,
  };
}

const accountState = { oauthScopes: ["https://www.googleapis.com/auth/adwords"], accountRole: "ADMIN", editReady: true };
const connection = { id: CONNECTION, accountId: ACCOUNT, currency: "USD" };

function createAdapter(client = {}) {
  return createProviderExecutionAdapter(PROVIDER_DEFINITIONS.GOOGLE_ADS, {
    env: ENV,
    allowProviderValidation: true,
    credentialResolver: async () => ({ refreshToken: "not-returned" }),
    clientFactory: () => ({ validateGraph: async () => undefined, execute: async () => ({ requestId: "req-1", resourceId: "1", resourceName: "customers/1234567890/campaigns/1", returnedState: { name: "Phase 3 search" } }), readBack: async () => ({ name: "Phase 3 search" }), ...client }),
  });
}

test("Google identifiers are normalized and credentials remain lazy", async () => {
  assert.equal(normalizeGoogleCustomerId("123-456-7890"), ACCOUNT);
  assert.throws(() => normalizeGoogleCustomerId("123"), (error) => error.code === "INVALID_EXECUTION_PLAN");
  let resolved = 0;
  const forExecution = createLazyGoogleAdsClientFactory({
    credentialResolver: async () => { resolved += 1; return { refreshToken: "r", developerToken: "d", clientId: "c", clientSecret: "s" }; },
    transportFactory: (options) => options,
  });
  assert.equal(resolved, 0);
  const transport = await forExecution({ connection, customerId: "123-456-7890", loginCustomerId: "098-765-4321", apiVersion: "v24" });
  assert.equal(resolved, 1);
  assert.equal(transport.customerId, ACCOUNT);
  assert.equal(transport.loginCustomerId, "0987654321");
});

test("Google capability is structural, Search-only and write-disabled", () => {
  const capability = createAdapter().getCapabilities({ connection, accountExternalId: ACCOUNT, accountState, campaignType: "SEARCH", operationType: "CREATE", resourceType: "CAMPAIGN" });
  assert.equal(capability.apiVersion, "v24");
  assert.equal(capability.configurationReady, true);
  assert.equal(capability.permissionReady, true);
  assert.equal(capability.writeReady, false);
  assert.equal(capability.writeGateEnabled, false);
  assert.deepEqual(capability.supportedCampaignTypes, ["SEARCH"]);
  assert.equal(capability.providerDetails.batchJobSupported, false);
});

test("Google validation requires Search and the non-political EU declaration", async () => {
  const adapter = createAdapter();
  const validated = await adapter.validatePlan({ plan: plan(), connection, accountState });
  assert.equal(validated.campaign.status, "PAUSED");
  await assert.rejects(adapter.validatePlan({ plan: plan({ campaign: campaign({ campaignType: "AUCTION" }) }), connection, accountState }), (error) => error.code === "PROVIDER_CAPABILITY_UNAVAILABLE");
  await assert.rejects(adapter.validatePlan({ plan: plan({ campaign: campaign({ declarations: {} }) }), connection, accountState }), (error) => error.code === "INVALID_EXECUTION_PLAN" && error.errors[0].reasonCode === "EU_POLITICAL_DECLARATION_REQUIRED");
  await assert.rejects(adapter.validatePlan({ plan: plan({ campaign: campaign({ declarations: { euPoliticalAdvertising: "CONTAINS_EU_POLITICAL_ADVERTISING" } }) }), connection, accountState }), (error) => error.code === "INVALID_EXECUTION_PLAN" && error.errors[0].reasonCode === "POLITICAL_ADVERTISING_UNSUPPORTED");
});

test("Google builds deterministic mutate order with temporary names and strict validation flags", async () => {
  let validationRequest;
  const adapter = createAdapter({ validateGraph: async (request) => { validationRequest = request; } });
  const validated = await adapter.validatePlan({ plan: plan({ providerValidationRequested: true }), connection, accountState, dryRun: true });
  const graph = adapter.buildOperations({ validatedPlan: validated });
  assert.deepEqual(graph.map((entry) => entry.clientReference), ["budget", "campaign", "language", "location", "negative", "group", "group-target", "asset", "ad", "link"]);
  assert.equal(graph[0].transportInstruction.fields.providerAmount.value, "10000000");
  assert.equal(graph[0].transportInstruction.temporaryResourceName, "customers/1234567890/campaignBudgets/-1");
  assert.ok(graph.every((entry) => entry.transportInstruction.validateOnly === true && entry.transportInstruction.partialFailure === false));
  assert.equal(validationRequest.validateOnly, true);
  assert.equal(validationRequest.partialFailure, false);
  assert.equal(validated.operationGraphHash.length, 64);
  assert.equal(JSON.stringify(graph).includes("BatchJob"), false);
});

test("Google execution remains four-gate protected and returns normalized certainty", async () => {
  const adapter = createAdapter();
  const validated = await adapter.validatePlan({ plan: plan(), connection, accountState });
  const operation = validated.operationGraph[1];
  await assert.rejects(adapter.executeOperation({ operation }), (error) => error.code === "EXECUTION_DISABLED");
  const executable = { ...operation, executionContext: { globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true, connection, accountExternalId: ACCOUNT } };
  const result = await adapter.executeOperation({ operation: executable, idempotencyKey: "key-1" });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.providerRequestId, "req-1");
  assert.equal(result.nativeResourceId, "1");
  assert.equal(result.outcomeCertain, true);
});

test("Google verification reads back exact state and never retries unknown outcomes", async () => {
  const adapter = createAdapter({ readBack: async () => ({ name: "Phase 3 search" }) });
  const validated = await adapter.validatePlan({ plan: plan(), connection, accountState });
  const operation = validated.operationGraph[1];
  operation.executionContext = { connection, accountExternalId: ACCOUNT };
  assert.equal((await adapter.verifyOperation({ operation, providerResult: { status: "SUCCEEDED" } })).status, "VERIFIED");
  assert.deepEqual(await adapter.verifyOperation({ operation, providerResult: { status: "UNKNOWN" } }), { status: "UNKNOWN", readBackRequired: true, retryAllowed: false });
  const failed = await createAdapter({ execute: async () => { const error = new Error("timeout"); error.outcomeUnknown = true; throw error; } }).executeOperation({ operation: { ...operation, executionContext: { globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true, connection, accountExternalId: ACCOUNT } } });
  assert.equal(failed.status, "UNKNOWN");
  assert.equal(failed.retryable, false);
});

test("Google preflight GAQL is bounded and normalizes a reproducible snapshot", async () => {
  const query = buildGaqlPreflightQuery("customers/1234567890/campaigns/42");
  assert.match(query, /campaign\.id = 42 LIMIT 1$/);
  for (const field of GAQL_PREFLIGHT_FIELDS) assert.ok(query.includes(field));
  const result = await runGaqlPreflight({ client: { search: async () => [{ customer: { id: ACCOUNT, currencyCode: "USD", timeZone: "UTC" }, campaign: { id: "42", name: "Phase 3 search", status: "PAUSED", campaignBudget: "customers/1234567890/campaignBudgets/7" }, campaignBudget: { id: "7", amountMicros: "10000000", explicitlyShared: false } }] }, resourceName: "customers/1234567890/campaigns/42", capturedAt: new Date("2026-07-22T10:00:00.000Z") });
  assert.equal(result.campaign.id, "42");
  assert.equal(result.budget.amountMicros, "10000000");
  assert.equal(result.hash.length, 64);
});
