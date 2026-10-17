"use strict";

// Section 29 fake provider transports.
//
// These fakes stand in for the injected provider HTTP clients used by
// createProviderExecutionAdapter({ clientFactory }). They never open sockets:
// every "request" is an in-process function call that is still routed through
// the production network policy (host allowlist) so the wiring is proven
// without any live provider access. Only synthetic identifiers are stored and
// credentials are witnessed as a boolean, never retained.

const { PROVIDER_HOSTS } = require("../../adapters/provider-network.policy");
const { PROVIDER_DEFINITIONS } = require("../../adapters/provider-definitions");

const PROVIDER_ENDPOINTS = Object.freeze({
  GOOGLE_ADS: "https://googleads.googleapis.com/",
  META: "https://graph.facebook.com/",
  TIKTOK: "https://business-api.tiktok.com/open_api/",
  LINKEDIN: "https://api.linkedin.com/rest/adAccounts",
  X: "https://ads-api.x.com/12/accounts",
});

const REVIEW_STATES = Object.freeze(["PENDING_REVIEW", "APPROVED", "REJECTED", "LIMITED", "UNKNOWN"]);

const CREDENTIAL_KEY_PATTERN = /(access|refresh)?token|secret|password|authorization|credential|developer[-_]?token|api[-_]?key/i;

function assertNoCredentialShapedContent(value, path = "request") {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new Error(`FAKE_TRANSPORT_CREDENTIAL_SHAPED_FIELD:${path}.${key}`);
    }
    assertNoCredentialShapedContent(child, `${path}.${key}`);
  }
}

function sanitizedCapture(operation = {}) {
  return Object.freeze({
    provider: operation.provider || null,
    apiVersion: operation.apiVersion || null,
    sequence: operation.sequence ?? null,
    operationType: operation.operationType || null,
    resourceType: operation.resourceType || null,
    createStatus: operation.createStatus || null,
    validateOnly: operation.validateOnly === true,
    partialFailure: operation.partialFailure === true,
    headers: operation.headers ? { ...operation.headers } : null,
    monetaryUnits: operation.fields?.providerAmounts
      ? Object.fromEntries(Object.entries(operation.fields.providerAmounts).map(([field, amount]) => [field, amount.unit]))
      : null,
  });
}

function providerErrorFixture(provider, kind, { observedAt = "2026-07-23T10:00:00.000Z", retryAfterSeconds = 60 } = {}) {
  if (kind === "RATE_LIMIT") {
    return { statusCode: 429, kind: "rate", message: `${provider} rate limit reached`, observedAt, response: { status: 429, headers: { "retry-after": String(retryAfterSeconds) } } };
  }
  if (kind === "PERMISSION") {
    return { statusCode: 403, kind: "permission", message: `${provider} permission missing`, response: { status: 403 } };
  }
  if (kind === "VALIDATION") {
    return { statusCode: 400, kind: "validation", message: `${provider} rejected a required field`, response: { status: 400 } };
  }
  if (kind === "TRANSIENT") {
    return { statusCode: 503, kind: "transient", message: `${provider} temporarily unavailable`, response: { status: 503 } };
  }
  if (kind === "TIMEOUT_UNKNOWN") {
    const error = new Error(`${provider} socket ended after the request was submitted`);
    error.outcomeUnknown = true;
    return error;
  }
  throw new Error(`Unsupported provider error fixture: ${kind}`);
}

// Creates a provider-specific fake transport plus the clientFactory to inject
// into createProviderExecutionAdapter. `scenario` scripts behavior:
//   endpoint          override the URL the fake asks the network policy to approve
//   executeQueue      array of per-call behaviors: {kind: "SUCCEED"|"RATE_LIMIT"|
//                     "PERMISSION"|"VALIDATION"|"TRANSIENT"|"TIMEOUT_UNKNOWN",
//                     reviewStatus, resourceId, warnings}
//   validationFailures array of {index, providerCode, message} returned by validateGraph
//   readBackState     explicit state map keyed by resourceId (null => missing)
//   drift             object merged over read-back state to simulate external change
//   latencyMs         recorded (never slept) simulated latency
function createFakeProviderTransport(provider, scenario = {}) {
  if (!PROVIDER_DEFINITIONS[provider]) throw new Error(`Unknown provider: ${provider}`);
  const endpoint = scenario.endpoint || PROVIDER_ENDPOINTS[provider];
  const state = {
    provider,
    requests: [],
    validationRequests: [],
    readBackRequests: [],
    resources: new Map(),
    resultsByIdempotencyKey: new Map(),
    mutationCount: 0,
    validateOnlyCount: 0,
    credentialWitness: { provided: false, stored: null },
    policyRejections: [],
    simulatedLatencyMs: Number(scenario.latencyMs || 0),
    executeCalls: 0,
  };
  const executeQueue = [...(scenario.executeQueue || [])];

  function approveEndpoint(networkPolicy) {
    if (!networkPolicy || typeof networkPolicy.assertUrl !== "function") {
      throw new Error("FAKE_TRANSPORT_NETWORK_POLICY_REQUIRED");
    }
    try {
      networkPolicy.assertUrl(endpoint);
    } catch (error) {
      state.policyRejections.push({ endpoint, code: error.code || error.message });
      throw error;
    }
  }

  function clientFactory({ provider: requestedProvider, apiVersion, accountExternalId, credentials, networkPolicy }) {
    if (requestedProvider !== provider) throw new Error("FAKE_TRANSPORT_PROVIDER_MISMATCH");
    state.credentialWitness.provided = state.credentialWitness.provided || credentials != null;
    // Never retain the credential value; the witness stays null forever.
    return {
      async validateGraph({ operations = [], validateOnly, partialFailure, networkPolicy: callPolicy }) {
        approveEndpoint(callPolicy || networkPolicy);
        if (provider === "GOOGLE_ADS" && validateOnly !== true) throw new Error("FAKE_GOOGLE_VALIDATE_ONLY_REQUIRED");
        for (const operation of operations) assertNoCredentialShapedContent(operation.fields, "validateGraph.fields");
        state.validateOnlyCount += 1;
        state.validationRequests.push({ count: operations.length, validateOnly: validateOnly === true, partialFailure: partialFailure === true, captured: operations.map(sanitizedCapture) });
        const failures = scenario.validationFailures || [];
        if (failures.length) {
          const error = providerErrorFixture(provider, "VALIDATION");
          error.partialFailureError = { errors: failures.map((failure) => ({ operationIndex: failure.index, providerCode: String(failure.providerCode || "INVALID"), message: String(failure.message || "invalid operation") })) };
          throw error;
        }
      },
      async execute({ operation, idempotencyKey, networkPolicy: callPolicy }) {
        approveEndpoint(callPolicy || networkPolicy);
        assertNoCredentialShapedContent(operation.fields, "execute.fields");
        if (provider === "LINKEDIN") {
          const header = operation.headers?.["Linkedin-Version"];
          if (!header || header !== apiVersion) {
            throw providerErrorFixture(provider, "VALIDATION");
          }
        }
        if (operation.operationType === "CREATE" && operation.createStatus !== "PAUSED") {
          throw new Error("FAKE_TRANSPORT_ACTIVE_CREATE_FORBIDDEN");
        }
        state.executeCalls += 1;
        if (idempotencyKey && state.resultsByIdempotencyKey.has(idempotencyKey)) {
          state.requests.push({ ...sanitizedCapture(operation), idempotencyKey, replayed: true });
          return state.resultsByIdempotencyKey.get(idempotencyKey);
        }
        const behavior = executeQueue.length ? executeQueue.shift() : { kind: "SUCCEED" };
        state.requests.push({ ...sanitizedCapture(operation), idempotencyKey: idempotencyKey || null, replayed: false, behavior: behavior.kind });
        if (behavior.kind !== "SUCCEED") throw providerErrorFixture(provider, behavior.kind, behavior);
        state.mutationCount += 1;
        const sequence = state.mutationCount;
        const resourceId = behavior.resourceId || `${provider.toLowerCase()}-resource-${sequence}`;
        const requestId = `${provider.toLowerCase()}-req-${state.executeCalls}`;
        const returnedState = {
          name: operation.fields?.name || `${provider} resource ${sequence}`,
          status: operation.operationType === "CREATE" ? "PAUSED" : operation.fields?.status || "PAUSED",
          ...(behavior.reviewStatus ? { reviewStatus: REVIEW_STATES.includes(behavior.reviewStatus) ? behavior.reviewStatus : "UNKNOWN" } : provider === "TIKTOK" ? { reviewStatus: "PENDING_REVIEW" } : {}),
        };
        state.resources.set(resourceId, { ...returnedState, resourceType: operation.resourceType, accountExternalId });
        const result = { requestId, resourceId, resourceName: `${provider.toLowerCase()}:${operation.resourceType}:${resourceId}`, returnedState, warnings: behavior.warnings || [], outcomeCertain: true };
        if (idempotencyKey) state.resultsByIdempotencyKey.set(idempotencyKey, result);
        return result;
      },
      async readBack({ operation, providerResult, networkPolicy: callPolicy }) {
        approveEndpoint(callPolicy || networkPolicy);
        state.readBackRequests.push({ resourceId: providerResult?.nativeResourceId || providerResult?.resourceId || null });
        if (scenario.readBackState !== undefined) return scenario.readBackState;
        const stored = state.resources.get(providerResult?.nativeResourceId || providerResult?.resourceId);
        if (!stored) return null;
        const { resourceType, accountExternalId: _scope, ...material } = stored;
        return scenario.drift ? { ...material, ...scenario.drift } : material;
      },
    };
  }

  return { transport: state, clientFactory, endpoint };
}

// Standard per-provider adapter fixtures reused across the Section 29 suites.
const PROVIDER_FIXTURES = Object.freeze({
  GOOGLE_ADS: {
    connectionId: "33333333-3333-4333-8333-333333333333",
    accountExternalId: "1234567890",
    env: { MARKETING_AD_EXECUTION_GOOGLE_ADS_API_VERSION: "v24" },
    accountState: { oauthScopes: ["https://www.googleapis.com/auth/adwords"], accountRole: "ADMIN", editReady: true },
    campaign: {
      name: "Phase 3 search", objective: "LEADS", campaignType: "SEARCH",
      startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "budget",
      bidding: { strategy: "MANUAL_CPC", bidAmount: "1.25" }, networkOrPlacements: ["SEARCH"],
      declarations: { euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" },
      tracking: { utmTemplate: "utm_source=google" },
    },
    items: [
      ["budget", "BUDGET", "CREATE", [], { amount: "10.00", explicitlyShared: false }],
      ["campaign", "CAMPAIGN", "CREATE", ["budget"], { name: "Phase 3 search" }],
      ["group", "GROUP", "CREATE", ["campaign"], { name: "Main group" }],
      ["ad", "AD", "CREATE", ["group"], { finalUrl: "https://example.test/health" }],
    ],
  },
  META: {
    connectionId: "55555555-5555-4555-8555-555555555555",
    accountExternalId: "act_123456",
    env: { MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" },
    accountState: { oauthScopes: ["ads_management"], accountRole: "ADMIN", editReady: true, pageIdentityReady: true, instagramIdentityReady: true },
    campaign: {
      name: "Meta auction", objective: "OUTCOME_LEADS", campaignType: "AUCTION",
      startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "campaign",
      bidding: { strategy: "LOWEST_COST", optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS" },
      networkOrPlacements: ["FACEBOOK_FEED"], declarations: { specialAdCategory: "NONE" },
      tracking: { utmTemplate: "utm_source=meta" },
    },
    items: [
      ["campaign", "CAMPAIGN", "CREATE", [], { name: "Meta auction" }],
      ["group", "GROUP", "CREATE", ["campaign"], { dailyBudget: "25.00" }],
      ["creative", "CREATIVE", "CREATE", ["group"], { pageId: "page-1", message: "Trusted care" }],
      ["ad", "AD", "CREATE", ["creative"], { name: "Lead ad" }],
    ],
  },
  TIKTOK: {
    connectionId: "77777777-7777-4777-8777-777777777777",
    accountExternalId: "9876543210",
    env: { MARKETING_AD_EXECUTION_TIKTOK_API_VERSION: "v1.3" },
    accountState: { oauthScopes: ["Ad Management"], accountRole: "ADMIN", editReady: true, sparkAuthorized: false },
    campaign: {
      name: "TikTok manual", objective: "CONVERSIONS", campaignType: "MANUAL",
      startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "campaign",
      bidding: { strategy: "LOWEST_COST", optimizationGoal: "CONVERSION", billingEvent: "OCPM" },
      networkOrPlacements: ["TIKTOK"], declarations: {}, tracking: { utmTemplate: "utm_source=tiktok" },
    },
    items: [
      ["campaign", "CAMPAIGN", "CREATE", [], { name: "TikTok manual" }],
      ["group", "GROUP", "CREATE", ["campaign"], { budget: "50.00" }],
      ["creative", "CREATIVE", "CREATE", ["group"], { videoId: "video-1" }],
      ["ad", "AD", "CREATE", ["creative"], { name: "Manual ad" }],
    ],
  },
  LINKEDIN: {
    connectionId: "99999999-9999-4999-8999-999999999999",
    accountExternalId: "urn:li:sponsoredAccount:123",
    env: { MARKETING_AD_EXECUTION_LINKEDIN_API_VERSION: "202607" },
    accountState: { oauthScopes: ["rw_ads"], accountRole: "CAMPAIGN_MANAGER", accessTier: "STANDARD", editReady: true },
    campaign: {
      name: "LinkedIn sponsored content", objective: "LEAD_GENERATION", campaignType: "SPONSORED_CONTENT",
      startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "campaign-group",
      bidding: { strategy: "MAXIMUM_DELIVERY", optimizationGoal: "LEAD_GENERATION", billingEvent: "IMPRESSIONS" },
      networkOrPlacements: ["LINKEDIN_FEED"], declarations: {}, tracking: { utmTemplate: "utm_source=linkedin" },
    },
    items: [
      ["campaign-group", "CAMPAIGN_GROUP", "CREATE", [], { name: "Health group" }],
      ["campaign", "CAMPAIGN", "CREATE", ["campaign-group"], { name: "Lead campaign", dailyBudget: "15.00" }],
      ["creative", "CREATIVE", "CREATE", ["campaign"], { organization: "urn:li:organization:456" }],
    ],
  },
  X: {
    connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    accountExternalId: "x-account-123",
    env: { MARKETING_AD_EXECUTION_X_API_VERSION: "12" },
    accountState: { oauthScopes: ["ADS_API_WRITE"], accountRole: "ACCOUNT_ADMIN", editReady: true, fundingInstrumentReady: true },
    campaign: {
      name: "X promoted posts", objective: "WEBSITE_CLICKS", campaignType: "PROMOTED_TWEETS",
      startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z", budgetRef: "funding",
      bidding: { strategy: "AUTO_BID", optimizationGoal: "LINK_CLICKS", billingEvent: "ENGAGEMENT" },
      networkOrPlacements: ["ALL_ON_TWITTER"], declarations: {}, tracking: { utmTemplate: "utm_source=x" },
    },
    items: [
      ["funding", "FUNDING_INSTRUMENT", "READ", [], { id: "fi-1" }],
      ["campaign", "CAMPAIGN", "CREATE", ["funding"], { name: "X promoted posts", dailyBudget: "20.00" }],
      ["line-item", "GROUP", "CREATE", ["campaign"], { bidAmount: "1.50" }],
      ["targeting", "TARGETING", "CREATE", ["line-item"], { location: "US" }],
    ],
  },
});

function providerContext(provider) {
  const fixture = PROVIDER_FIXTURES[provider];
  if (!fixture) throw new Error(`Unknown provider fixture: ${provider}`);
  return {
    env: { ...fixture.env },
    connection: { id: fixture.connectionId, accountId: fixture.accountExternalId, currency: "USD" },
    accountState: { ...fixture.accountState },
  };
}

function providerPlanFixture(provider, overrides = {}) {
  const fixture = PROVIDER_FIXTURES[provider];
  if (!fixture) throw new Error(`Unknown provider fixture: ${provider}`);
  return {
    id: `${provider.toLowerCase().replace(/_/g, "")}0000-0000-4000-8000-000000000001`.slice(0, 36),
    planNumber: `MEP-${provider}-S29`,
    provider,
    connectionId: fixture.connectionId,
    accountExternalId: fixture.accountExternalId,
    currencyCode: "USD",
    campaign: { ...fixture.campaign, ...(overrides.campaign || {}) },
    items: fixture.items.map(([clientReference, resourceType, operationType, dependsOn, intent]) => ({
      provider, connectionId: fixture.connectionId, accountExternalId: fixture.accountExternalId,
      clientReference, resourceType, operationType, dependsOn, intent: { ...intent },
    })),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "campaign")),
  };
}

function enabledExecutionContext(provider, extra = {}) {
  const fixture = PROVIDER_FIXTURES[provider];
  return {
    globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true,
    permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true,
    accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true,
    connection: { id: fixture.connectionId, accountId: fixture.accountExternalId, currency: "USD" },
    accountExternalId: fixture.accountExternalId,
    ...extra,
  };
}

module.exports = {
  PROVIDER_ENDPOINTS,
  PROVIDER_HOSTS,
  REVIEW_STATES,
  providerErrorFixture,
  createFakeProviderTransport,
  providerContext,
  providerPlanFixture,
  enabledExecutionContext,
};
