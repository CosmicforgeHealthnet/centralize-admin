"use strict";

// Section 29 — LinkedIn mandatory suite (version headers, permissions, format
// limits, budgets) using the shared fake LinkedIn Marketing API transport
// injected through the production adapter factory.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderExecutionAdapter } = require("../adapters/provider-execution-adapter.factory");
const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { isProviderVersionSupported } = require("../execution.config");
const { evaluateBudgetChange, BUDGET_POLICY_DEFAULTS } = require("../policy/budget-guard.service");
const { convertProviderBudget } = require("../budgets/provider-budget-units");
const {
  createFakeProviderTransport, providerContext, providerPlanFixture, enabledExecutionContext,
} = require("./helpers/fake-provider-transports");

const { env, connection, accountState } = providerContext("LINKEDIN");

function buildAdapter(scenario = {}, options = {}) {
  const { transport, clientFactory } = createFakeProviderTransport("LINKEDIN", scenario);
  const adapter = createProviderExecutionAdapter(PROVIDER_DEFINITIONS.LINKEDIN, {
    env,
    credentialResolver: async () => ({ syntheticCredential: true }),
    clientFactory,
    ...options,
  });
  return { adapter, transport };
}

test("29-LINKEDIN every instruction carries the configured monthly version header and Restli protocol", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN"), connection, accountState });
  for (const entry of validated.operationGraph) {
    assert.equal(entry.transportInstruction.headers["Linkedin-Version"], "202607");
    assert.equal(entry.transportInstruction.headers["X-Restli-Protocol-Version"], "2.0.0");
  }
  // The fake provider rejects an execute whose version header was stripped.
  const context = enabledExecutionContext("LINKEDIN");
  const stripped = { ...validated.operationGraph[0], transportInstruction: { ...validated.operationGraph[0].transportInstruction, headers: {} } };
  const rejected = await adapter.executeOperation({ operation: { ...stripped, executionContext: context } });
  assert.equal(rejected.status, "FAILED");
  assert.equal(rejected.error.category, "VALIDATION");
  assert.equal(transport.mutationCount, 0);
  // The version is recorded in evidence via the validated plan.
  assert.equal(validated.apiVersion, "202607");
});

test("29-LINKEDIN sunset or malformed versions map to capability unavailable and never hardcode a fallback", async () => {
  // A version older than 12 months is unsupported at 2026-07.
  assert.equal(isProviderVersionSupported("LINKEDIN", "202401", new Date("2026-07-23T00:00:00Z")), false);
  assert.equal(isProviderVersionSupported("LINKEDIN", "202607", new Date("2026-07-23T00:00:00Z")), true);
  assert.equal(isProviderVersionSupported("LINKEDIN", "2026-07", new Date("2026-07-23T00:00:00Z")), false);
  const sunset = buildAdapter({}, { env: { MARKETING_AD_EXECUTION_LINKEDIN_API_VERSION: "202401" } });
  assert.equal(sunset.adapter.getCapabilities({ connection, accountExternalId: connection.accountId, accountState }).apiVersion, "CONFIG_REQUIRED");
  await assert.rejects(sunset.adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN"), connection, accountState }), (error) => error.errors[0].reasonCode === "PROVIDER_API_VERSION_REQUIRED");
  // No hardcoded fallback version exists outside configuration.
  const unversioned = buildAdapter({}, { env: {} });
  assert.equal(unversioned.adapter.metadata.apiVersion, "CONFIG_REQUIRED");
});

test("29-LINKEDIN permissions demand rw_ads scope and an eligible account role, with stable errors and no token leakage", async () => {
  const { adapter, transport } = buildAdapter({ executeQueue: [{ kind: "PERMISSION" }] });
  // Read-style capability separates from write readiness.
  const missingScope = adapter.getCapabilities({ connection, accountExternalId: connection.accountId, accountState: { ...accountState, oauthScopes: [] } });
  assert.equal(missingScope.permissionReady, false);
  assert.ok(missingScope.accountRestrictions.includes("REQUIRED_OAUTH_SCOPE_MISSING"));
  const badRole = adapter.getCapabilities({ connection, accountExternalId: connection.accountId, accountState: { ...accountState, accountRole: "VIEWER" } });
  assert.ok(badRole.accountRestrictions.includes("ACCOUNT_ROLE_INELIGIBLE"));
  // Development-tier accounts without allowlisting fail closed at validation.
  await assert.rejects(
    adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN"), connection, accountState: { ...accountState, accessTier: "DEVELOPMENT", editReady: false } }),
    (error) => error.errors[0].reasonCode === "DEVELOPMENT_TIER_ACCOUNT_NOT_ALLOWLISTED",
  );
  // A live permission failure normalizes with no secret material in the message.
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN"), connection, accountState });
  const denied = await adapter.executeOperation({ operation: { ...validated.operationGraph[0], executionContext: enabledExecutionContext("LINKEDIN") } });
  assert.equal(denied.status, "FAILED");
  assert.equal(denied.error.category, "PERMISSION");
  assert.equal(denied.error.retryable, false);
  assert.equal(JSON.stringify(denied).toLowerCase().includes("synthetic"), false, "credential values never leak into results");
  assert.equal(transport.credentialWitness.stored, null);
});

test("29-LINKEDIN unsupported creative formats and campaign/creative mismatches fail closed", async () => {
  const { adapter } = buildAdapter();
  assert.deepEqual(PROVIDER_DEFINITIONS.LINKEDIN.details.supportedFormats, ["SINGLE_IMAGE", "VIDEO"]);
  await assert.rejects(
    adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN", { campaignFormat: "CAROUSEL" }), connection, accountState }),
    (error) => error.errors[0].reasonCode === "UNSUPPORTED_CREATIVE_FORMAT",
  );
  const mismatched = providerPlanFixture("LINKEDIN", { campaignFormat: "SINGLE_IMAGE" });
  mismatched.items[2].intent.format = "VIDEO";
  await assert.rejects(adapter.validatePlan({ plan: mismatched, connection, accountState }), (error) => error.errors[0].reasonCode === "CAMPAIGN_CREATIVE_FORMAT_MISMATCH");
  // Protected-characteristic targeting is discrimination and always rejected.
  await assert.rejects(
    adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN", { targeting: [{ protectedCharacteristic: true }] }), connection, accountState }),
    (error) => error.errors[0].reasonCode === "DISCRIMINATORY_TARGETING_FORBIDDEN",
  );
});

test("29-LINKEDIN budgets convert as decimal currency amounts with provider minimum and cap enforcement", async () => {
  const { adapter } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN"), connection, accountState });
  const campaignInstruction = validated.operationGraph.find((entry) => entry.clientReference === "campaign").transportInstruction;
  assert.deepEqual(campaignInstruction.fields.providerAmounts.dailyBudget, { unit: "MAJOR_CURRENCY", value: "15", currency: "USD" });
  assert.throws(() => convertProviderBudget("LINKEDIN", 15.0, { currency: "USD" }), (error) => error.errors[0].reasonCode === "BINARY_FLOAT_MONEY_FORBIDDEN");
  // Provider-reported minimums and maximum policy caps flow through the budget guard.
  const policy = { ...BUDGET_POLICY_DEFAULTS, budgetIncreaseEnabled: true, maximumBudgetIncreasePct: "100", maximumPlanSpendExposure: { amount: "1000", currency: "USD" } };
  const input = {
    provider: "LINKEDIN", connectionId: connection.id, accountExternalId: connection.accountId,
    connectionPolicyConfigured: true, currency: "USD", accountCurrency: "USD",
    snapshotAt: "2026-07-23T10:05:00.000Z", existingBudget: "10", requestedBudget: "12", spendToDate: "0",
    semantics: "DAILY", providerMinimum: "15",
  };
  const belowMinimum = evaluateBudgetChange(input, policy, { now: new Date("2026-07-23T10:10:00.000Z") });
  assert.ok(belowMinimum.blockingViolations.includes("BELOW_PROVIDER_MINIMUM"));
  const aboveMaximum = evaluateBudgetChange({ ...input, requestedBudget: "2000", providerMinimum: null, providerMaximum: "1500" }, policy, { now: new Date("2026-07-23T10:10:00.000Z") });
  assert.ok(aboveMaximum.blockingViolations.includes("ABOVE_PROVIDER_MAXIMUM"));
  assert.ok(aboveMaximum.blockingViolations.includes("PLAN_EXPOSURE_CAP_EXCEEDED"));
  // Lifetime/daily semantics stay distinct in the evidence packet.
  assert.equal(belowMinimum.budgetSemantics, "DAILY");
  const lifetime = evaluateBudgetChange({ ...input, requestedBudget: "12", providerMinimum: null, semantics: "LIFETIME" }, policy, { now: new Date("2026-07-23T10:10:00.000Z") });
  assert.equal(lifetime.totalExposure, "12");
  assert.equal(lifetime.dailyExposure, null);
  // Shared budgets are not mutable by default for LinkedIn either.
  const shared = evaluateBudgetChange({ ...input, providerMinimum: null, isSharedBudget: true, sharedBudgetAffectedCampaigns: [{ id: "a" }, { id: "b" }] }, policy, { now: new Date("2026-07-23T10:10:00.000Z") });
  assert.ok(shared.blockingViolations.includes("SHARED_BUDGET_MUTATION_DISABLED"));
});

test("29-LINKEDIN paused creation and campaign-group ordering hold through the fake transport", async () => {
  const { adapter, transport } = buildAdapter();
  const validated = await adapter.validatePlan({ plan: providerPlanFixture("LINKEDIN"), connection, accountState });
  assert.deepEqual(validated.operationGraph.map((entry) => entry.clientReference), ["campaign-group", "campaign", "creative"]);
  const context = enabledExecutionContext("LINKEDIN");
  for (const [index, entry] of validated.operationGraph.entries()) {
    const result = await adapter.executeOperation({ operation: { ...entry, executionContext: context }, idempotencyKey: `li-key-${index}` });
    assert.equal(result.returnedState.status, "PAUSED");
  }
  assert.equal(transport.mutationCount, 3);
  assert.ok(transport.requests.every((request) => request.headers["Linkedin-Version"] === "202607"));
});
