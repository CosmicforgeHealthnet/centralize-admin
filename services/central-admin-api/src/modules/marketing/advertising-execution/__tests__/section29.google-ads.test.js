"use strict";

// Section 29 — Google Ads mandatory suite (validate-only, temporary resource
// graph, micros, partial failure, required declarations, immutable fields).
// Uses the shared fake Google transport injected through the production
// adapter factory and the real provider network policy; no live call exists.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { toMicroUnits } = require("../budgets/money");
const { assertImmutableFields, IMMUTABLE_FIELDS } = require("../campaigns/immutable-field-policy");
const {
  createFakeProviderTransport, providerContext, providerPlanFixture, enabledExecutionContext,
} = require("./helpers/fake-provider-transports");

const { env, connection, accountState } = providerContext("GOOGLE_ADS");

function buildAdapter(scenario = {}, options = {}) {
  const { transport, clientFactory } = createFakeProviderTransport("GOOGLE_ADS", scenario);
  const adapter = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.GOOGLE_ADS, {
    env,
    allowProviderValidation: true,
    credentialResolver: async () => ({ syntheticCredential: true }),
    clientFactory,
    ...options,
  });
  return { adapter, transport };
}

test("29-GOOGLE validate-only requests never mutate and capture the provider version", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS", { providerValidationRequested: true }), connection, accountState, dryRun: true });
  assert.equal(transport.validateOnlyCount, 1);
  assert.equal(transport.mutationCount, 0, "validate-only performs zero mutations");
  assert.equal(transport.validationRequests[0].validateOnly, true);
  assert.equal(transport.validationRequests[0].partialFailure, false);
  assert.equal(validated.apiVersion, "v24");
  assert.ok(validated.operationGraph.every((entry) => entry.transportInstruction.validateOnly === true));
  // Capability errors map when the configured version is missing.
  const { adapter: unversioned } = buildAdapter({}, { env: {} });
  await assert.rejects(unversioned.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS"), connection, accountState }), (error) => error.errors[0].reasonCode === "PROVIDER_API_VERSION_REQUIRED");
});

test("29-GOOGLE temporary resource graph orders budget before campaign and never leaks temp names as final ids", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS"), connection, accountState });
  const graph = adapter.buildOperations({ validatedPlan: validated });
  assert.deepEqual(graph.map((entry) => entry.clientReference), ["budget", "campaign", "group", "ad"]);
  assert.equal(graph[0].transportInstruction.temporaryResourceName, "customers/1234567890/campaignBudgets/-1");
  assert.equal(graph[1].transportInstruction.temporaryResourceName, "customers/1234567890/campaigns/-2");
  // Executing the create returns a real native id, never the temporary name.
  const result = await adapter.executeOperation({ operation: { ...graph[1], executionContext: enabledExecutionContext("GOOGLE_ADS") }, idempotencyKey: "google-key-1" });
  assert.equal(result.status, "SUCCEEDED");
  assert.notEqual(result.nativeResourceId, graph[1].transportInstruction.temporaryResourceName);
  assert.equal(transport.requests[0].createStatus, "PAUSED");
  // Invalid dependencies are rejected before any graph is produced.
  const broken = providerPlanFixture("GOOGLE_ADS");
  broken.items[1].dependsOn = ["missing-reference"];
  await assert.rejects(adapter.validatePlan({ plan: broken, connection, accountState }), (error) => error.errors[0].reasonCode === "UNRESOLVED_CLIENT_REFERENCE");
  const cyclic = providerPlanFixture("GOOGLE_ADS");
  cyclic.items[0].dependsOn = ["campaign"];
  await assert.rejects(adapter.validatePlan({ plan: cyclic, connection, accountState }), (error) => error.errors[0].reasonCode === "DEPENDENCY_CYCLE");
});

test("29-GOOGLE micros conversion is exact with boundary, rounding and overflow protection", async () => {
  const { adapter } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS"), connection, accountState });
  assert.deepEqual(validated.operationGraph[0].transportInstruction.fields.providerAmount, { unit: "MICROS", value: "10000000", major: "10" });
  // Exact boundaries and no rounding: sub-micro precision is rejected, not rounded.
  assert.equal(toMicroUnits("0.000001", {}).value, "1");
  assert.throws(() => toMicroUnits("0.0000001", {}), (error) => error.errors[0].reasonCode === "MICRO_UNIT_OVERFLOW");
  // Currency consistency: USD allows 2 decimals for money amounts.
  assert.throws(() => toMicroUnits("10.001", { currency: "USD" }), (error) => error.errors[0].reasonCode === "CURRENCY_PRECISION_EXCEEDED");
  // 64-bit overflow protection.
  assert.throws(() => toMicroUnits("99999999999999", {}), (error) => ["MICRO_UNIT_OVERFLOW", "MONEY_OUT_OF_RANGE"].includes(error.errors[0].reasonCode));
  // Pre-converted micros in intents are raw provider payloads and are forbidden.
  const preconverted = providerPlanFixture("GOOGLE_ADS");
  preconverted.items[0].intent = { amountMicros: "10000000" };
  await assert.rejects(adapter.validatePlan({ plan: preconverted, connection, accountState }), (error) => error.errors[0].reasonCode === "PRECONVERTED_PROVIDER_UNITS_FORBIDDEN");
  // Shared budget intent is material and survives into the instruction fields.
  assert.equal(validated.operationGraph[0].transportInstruction.fields.explicitlyShared, false);
});

test("29-GOOGLE partial failure maps indexed provider errors without claiming global success", async () => {
  const { adapter, transport } = buildAdapter({ validationFailures: [{ index: 1, providerCode: "INVALID_CAMPAIGN", message: "campaign invalid" }] });
  await assert.rejects(
    adapter.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS", { providerValidationRequested: true }), connection, accountState }),
    (error) => error.statusCode === 400 || error.code === "EXECUTION_VALIDATION_FAILED" || error.errors?.[0],
  );
  assert.equal(transport.mutationCount, 0, "a failed validation never mutates");
  // Classification of an indexed partial failure stays VALIDATION and non-retryable.
  const classified = adapter.classifyError({ error: { statusCode: 400, kind: "validation", partialFailureError: { errors: [{ operationIndex: 1, providerCode: "INVALID_CAMPAIGN" }] }, message: "partial failure" } });
  assert.equal(classified.category, "VALIDATION");
  assert.equal(classified.retryable, false);
  // Independent transient failures classify as retryable without blind dependent retries.
  const transient = adapter.classifyError({ error: { statusCode: 503, kind: "transient", message: "backend unavailable" } });
  assert.equal(["TRANSIENT", "PROVIDER"].includes(transient.category), true);
  // A partial-failure execute run: first op succeeds, second fails, no global success.
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS"), connection, accountState });
  const { adapter: partial, transport: partialTransport } = buildAdapter({ executeQueue: [{ kind: "SUCCEED" }, { kind: "VALIDATION" }] });
  const context = enabledExecutionContext("GOOGLE_ADS");
  const ok = await partial.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: context }, idempotencyKey: "k1" });
  const failed = await partial.executeOperation({ operation: { ...validated.operationGraph[1], executionContext: context }, idempotencyKey: "k2" });
  assert.equal(ok.status, "SUCCEEDED");
  assert.equal(failed.status, "FAILED");
  assert.equal(partialTransport.mutationCount, 1, "the successful operation is preserved; the failed one wrote nothing");
});

test("29-GOOGLE required declarations: missing or political EU declaration fails validation", async () => {
  const { adapter } = buildAdapter();
  const missing = providerPlanFixture("GOOGLE_ADS");
  missing.campaign.declarations = {};
  await assert.rejects(adapter.validatePlan({ plan: missing, connection, accountState }), (error) => error.errors[0].reasonCode === "EU_POLITICAL_DECLARATION_REQUIRED");
  const political = providerPlanFixture("GOOGLE_ADS");
  political.campaign.declarations = { euPoliticalAdvertising: "CONTAINS_EU_POLITICAL_ADVERTISING" };
  await assert.rejects(adapter.validatePlan({ plan: political, connection, accountState }), (error) => error.errors[0].reasonCode === "POLITICAL_ADVERTISING_UNSUPPORTED");
  // Final URLs flow through ad intents; unsupported placements fail closed.
  const badPlacement = providerPlanFixture("GOOGLE_ADS");
  badPlacement.campaign.networkOrPlacements = ["DISPLAY_NETWORK"];
  await assert.rejects(adapter.validatePlan({ plan: badPlacement, connection, accountState }), (error) => error.errors[0].reasonCode === "UNSUPPORTED_PLACEMENT");
});

test("29-GOOGLE immutable campaign type and ownership changes require replacement plans", async () => {
  const { adapter } = buildAdapter();
  assert.deepEqual(IMMUTABLE_FIELDS.GOOGLE_ADS, ["platform", "accountExternalId", "currencyCode", "campaignType", "channelType", "channelSubtype"]);
  const plan = providerPlanFixture("GOOGLE_ADS", {
    currentState: { campaignType: "SEARCH", accountExternalId: "1234567890" },
    requestedState: { campaignType: "PERFORMANCE_MAX", accountExternalId: "1234567890" },
  });
  await assert.rejects(adapter.validatePlan({ plan, connection, accountState }), (error) => error.code === "IMMUTABLE_FIELD_CHANGE" && error.errors[0].requiredAction === "CREATE_REPLACEMENT_PLAN_AND_EXPLICITLY_RETIRE_OLD_RESOURCE");
  assert.throws(() => assertImmutableFields({ provider: "GOOGLE_ADS", current: { accountExternalId: "1234567890" }, requested: { accountExternalId: "999" } }), (error) => error.code === "IMMUTABLE_FIELD_CHANGE");
  // Unchanged immutable values pass: the existing resource is never overwritten implicitly.
  assert.equal(assertImmutableFields({ provider: "GOOGLE_ADS", current: { campaignType: "SEARCH" }, requested: { campaignType: "SEARCH" } }), true);
});

test("29-GOOGLE the production host allowlist blocks non-Google endpoints and idempotent replays never re-mutate", async () => {
  // An attacker-controlled endpoint is rejected by the production network policy.
  const { adapter: evil, transport: evilTransport } = buildAdapter({ endpoint: "https://evil.example/googleads" });
  const validated = await evil.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS"), connection, accountState });
  const blocked = await evil.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: enabledExecutionContext("GOOGLE_ADS") }, idempotencyKey: "evil-key" });
  assert.equal(blocked.status, "FAILED");
  assert.equal(evilTransport.mutationCount, 0);
  assert.equal(evilTransport.policyRejections.length, 1);
  assert.equal(evilTransport.policyRejections[0].code, "PROVIDER_CAPABILITY_UNAVAILABLE");
  // Same idempotency key replays the stored result without a second mutation.
  const { adapter, transport } = buildAdapter();
  const good = await adapter.validatePlan({ plan: providerPlanFixture("GOOGLE_ADS"), connection, accountState });
  const context = enabledExecutionContext("GOOGLE_ADS");
  const first = await adapter.executeOperation({ operation: { ...good.operationGraph[0], executionContext: context }, idempotencyKey: "replay-key" });
  const second = await adapter.executeOperation({ operation: { ...good.operationGraph[0], executionContext: context }, idempotencyKey: "replay-key" });
  assert.equal(first.nativeResourceId, second.nativeResourceId);
  assert.equal(transport.mutationCount, 1, "no duplicate provider mutation for the same idempotency key");
  // Credentials were provided to the factory but never stored by the transport.
  assert.equal(transport.credentialWitness.provided, true);
  assert.equal(transport.credentialWitness.stored, null);
});
