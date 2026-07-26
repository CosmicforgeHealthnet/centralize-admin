"use strict";

// Section 29 — Policy mandatory suite (currency, caps, shared budgets,
// approvals, regulated categories) driving the production budget guard,
// money primitives, policy repository resolution and server-side regulated
// category enforcement.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BUDGET_POLICY_DEFAULTS, assertCurrencyMatch, evaluateBudgetChange, assertBudgetWithinPolicy,
} = require("../policy/budget-guard.service");
const { decimal, toMicroUnits, fromMicroUnits, normalizeCurrency } = require("../budgets/money");
const { convertProviderBudget } = require("../budgets/provider-budget-units");
const { PolicyRepository, POLICY_RULES, validatePolicyKey } = require("../policy/policy.repository");
const { assertApprovalEligibility } = require("../policy/execution-policy.service");
const { resolveTargetingCriteria, FORBIDDEN_CATEGORIES } = require("../targeting/targeting.validator");
const { STABLE_ERROR_DEFINITIONS } = require("../execution.errors");

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-23T10:10:00.000Z");

function enabledPolicy(overrides = {}) {
  return {
    ...BUDGET_POLICY_DEFAULTS,
    budgetIncreaseEnabled: true,
    budgetDecreaseEnabled: true,
    maximumBudgetIncreasePct: "100",
    maximumBudgetDecreasePct: "100",
    maximumPlanSpendExposure: { amount: "1000", currency: "USD" },
    ...overrides,
  };
}

function budgetInput(overrides = {}) {
  return {
    provider: "META", connectionId: CONNECTION, accountExternalId: "act_123",
    connectionPolicyConfigured: true, currency: "USD", accountCurrency: "USD",
    snapshotAt: "2026-07-23T10:05:00.000Z", existingBudget: "100", requestedBudget: "150",
    spendToDate: "10", semantics: "DAILY",
    ...overrides,
  };
}

test("29-POLICY currency: supported pass, unsupported and account mismatch fail, no float money", () => {
  assert.equal(assertCurrencyMatch("usd", "USD"), "USD");
  assert.throws(() => assertCurrencyMatch("USD", "EUR"), (error) => error.errors[0].reasonCode === "ACCOUNT_CURRENCY_MISMATCH");
  assert.throws(() => normalizeCurrency("DOLLAR"), (error) => error.errors[0].reasonCode === "INVALID_OR_MISSING_CURRENCY");
  // Binary floats are rejected outright: no precision loss is possible.
  assert.throws(() => decimal(10.1, { currency: "USD" }), (error) => error.errors[0].reasonCode === "BINARY_FLOAT_MONEY_FORBIDDEN");
  assert.throws(() => decimal("10.999", { currency: "USD" }), (error) => error.errors[0].reasonCode === "CURRENCY_PRECISION_EXCEEDED");
  assert.equal(decimal("10.105", { currency: "TND" }).toFixed(), "10.105");
  assert.throws(() => decimal("10.5", { currency: "JPY" }), (error) => error.errors[0].reasonCode === "CURRENCY_PRECISION_EXCEEDED");
  // Decimal-safe round trip through micros preserves the exact value.
  assert.equal(fromMicroUnits(toMicroUnits("10.10", { currency: "USD" }).value).toFixed(), "10.1");
  // A cross-currency cap can never silently apply.
  const cross = evaluateBudgetChange(budgetInput(), enabledPolicy({ maximumPlanSpendExposure: { amount: "1000", currency: "EUR" } }), { now: NOW });
  assert.ok(cross.blockingViolations.includes("CROSS_CURRENCY_CAP"));
});

test("29-POLICY caps: per-operation, campaign, daily, monthly, zero, boundary and over-limit", () => {
  const capped = enabledPolicy({ absoluteAccountCap: "500", absoluteCampaignCap: "350", absolutePlanCap: "250", dailyCap: "200", lifetimeCap: "800" });
  // Exact-limit boundary passes for every layer.
  const boundary = evaluateBudgetChange(budgetInput({
    requestedBudget: "150",
    accountSpendExposure: "500", campaignSpendExposure: "350", planSpendExposure: "250",
    dailyExposure: "200", lifetimeExposure: "800",
  }), capped, { now: NOW });
  assert.deepEqual(boundary.blockingViolations, []);
  // Over-limit fails per layer with the specific violation code.
  const over = evaluateBudgetChange(budgetInput({
    requestedBudget: "150",
    accountSpendExposure: "500.01", campaignSpendExposure: "350.01", planSpendExposure: "250.01",
    dailyExposure: "200.01", lifetimeExposure: "800.01",
  }), capped, { now: NOW });
  for (const code of ["ACCOUNT_CAP_EXCEEDED", "CAMPAIGN_CAP_EXCEEDED", "PLAN_CAP_EXCEEDED", "DAILY_CAP_EXCEEDED", "LIFETIME_CAP_EXCEEDED"]) {
    assert.ok(over.blockingViolations.includes(code), `expected ${code}`);
  }
  // Zero cap blocks any positive exposure.
  const zero = evaluateBudgetChange(budgetInput({ dailyExposure: "1" }), enabledPolicy({ dailyCap: "0" }), { now: NOW });
  assert.ok(zero.blockingViolations.includes("DAILY_CAP_EXCEEDED"));
  // Negative caps are rejected as invalid money, never treated as unlimited.
  assert.throws(() => evaluateBudgetChange(budgetInput({ dailyExposure: "1" }), enabledPolicy({ dailyCap: "-5" }), { now: NOW }), (error) => error.errors[0].reasonCode === "MONEY_OUT_OF_RANGE");
  // Null caps mean "not configured": the mandatory exposure cap fails closed.
  const unconfigured = evaluateBudgetChange(budgetInput(), enabledPolicy({ maximumPlanSpendExposure: null }), { now: NOW });
  assert.ok(unconfigured.blockingViolations.includes("MAXIMUM_EXPOSURE_NOT_CONFIGURED"));
  // Per-operation parent/child limits are enforced from the operation input.
  const parent = evaluateBudgetChange(budgetInput({ parentBudgetLimit: "149" }), enabledPolicy(), { now: NOW });
  assert.ok(parent.blockingViolations.includes("PARENT_BUDGET_LIMIT_EXCEEDED"));
});

test("29-POLICY violations raise the stable EXECUTION_BUDGET_POLICY_VIOLATION with safe details", () => {
  assert.deepEqual(STABLE_ERROR_DEFINITIONS.EXECUTION_BUDGET_POLICY_VIOLATION, { status: 422, message: "Advertising spend guardrail was not satisfied" });
  try {
    assertBudgetWithinPolicy(budgetInput({ dailyExposure: "201" }), enabledPolicy({ dailyCap: "200" }), { now: NOW });
    assert.fail("expected a budget policy violation");
  } catch (error) {
    assert.equal(error.code, "EXECUTION_BUDGET_POLICY_VIOLATION");
    assert.equal(error.statusCode, 422);
    assert.equal(error.errors[0].reasonCode, "BUDGET_POLICY_EXCEEDED");
    assert.ok(error.errors[0].violations.includes("DAILY_CAP_EXCEEDED"));
    // Details are sanitized: no tokens, no raw provider payloads.
    assert.equal(JSON.stringify(error.errors).toLowerCase().includes("token"), false);
  }
  // Precondition-style failures stay EXECUTION_PRECONDITION_CHANGED.
  assert.throws(() => assertBudgetWithinPolicy(budgetInput(), enabledPolicy(), { now: new Date("2026-07-23T10:30:00.000Z") }), (error) => error.code === "EXECUTION_PRECONDITION_CHANGED");
  // The happy path returns a sanitized decimal evidence packet.
  const packet = assertBudgetWithinPolicy(budgetInput(), enabledPolicy(), { now: NOW });
  assert.equal(packet.requestedBudget, "150");
  assert.equal(packet.blockingViolations.length, 0);
});

test("29-POLICY shared budgets: forbidden by default, allowed explicitly, impact always required", () => {
  // Shared-budget mutation is disabled by default.
  assert.equal(BUDGET_POLICY_DEFAULTS.allowSharedBudgetMutation, false);
  const undiscovered = evaluateBudgetChange(budgetInput({ isSharedBudget: true }), enabledPolicy(), { now: NOW });
  assert.ok(undiscovered.blockingViolations.includes("SHARED_BUDGET_IMPACT_REQUIRED"));
  const affected = [{ id: "campaign-1" }, { id: "campaign-2" }];
  const forbidden = evaluateBudgetChange(budgetInput({ isSharedBudget: true, sharedBudgetAffectedCampaigns: affected }), enabledPolicy(), { now: NOW });
  assert.ok(forbidden.blockingViolations.includes("SHARED_BUDGET_MUTATION_DISABLED"));
  const allowed = evaluateBudgetChange(budgetInput({ isSharedBudget: true, sharedBudgetAffectedCampaigns: affected }), enabledPolicy({ allowSharedBudgetMutation: true }), { now: NOW });
  assert.equal(allowed.blockingViolations.includes("SHARED_BUDGET_MUTATION_DISABLED"), false);
  // Linked-campaign exposure is preserved in the evidence packet.
  assert.equal(allowed.sharedBudgetAffectedCampaigns.length, 2);
  // Aggregate spend exposure across the shared pool still honors caps.
  const aggregate = evaluateBudgetChange(budgetInput({ isSharedBudget: true, sharedBudgetAffectedCampaigns: affected, accountSpendExposure: "1200" }), enabledPolicy({ allowSharedBudgetMutation: true, absoluteAccountCap: "1000" }), { now: NOW });
  assert.ok(aggregate.blockingViolations.includes("ACCOUNT_CAP_EXCEEDED"));
});

test("29-POLICY spend increases demand quorum and bids are never treated as budgets", () => {
  const increase = evaluateBudgetChange(budgetInput({ requestedBudget: "150" }), enabledPolicy(), { now: NOW });
  assert.equal(increase.requiredApprovals, 2);
  const decrease = evaluateBudgetChange(budgetInput({ requestedBudget: "90", spendToDate: "10" }), enabledPolicy(), { now: NOW });
  assert.equal(decrease.requiredApprovals, 1);
  const bid = evaluateBudgetChange(budgetInput({ semantics: "BID" }), enabledPolicy(), { now: NOW });
  assert.ok(bid.blockingViolations.includes("BID_IS_NOT_BUDGET"));
});

test("29-POLICY approval policy precedence resolves connection over platform over restrictive global", async () => {
  const rows = {
    "approval.required.count": [
      { id: "g", scope: "GLOBAL", platform: null, connectionId: null, key: "approval.required.count", value: 2, enabled: true },
      { id: "p", scope: "PLATFORM", platform: "META", connectionId: null, key: "approval.required.count", value: 3, enabled: true },
      { id: "c", scope: "CONNECTION", platform: "META", connectionId: CONNECTION, key: "approval.required.count", value: 4, enabled: true },
    ],
    "execution.enabled": [
      { id: "global-off", scope: "GLOBAL", platform: null, connectionId: null, key: "execution.enabled", value: false, enabled: true },
      { id: "conn-on", scope: "CONNECTION", platform: "META", connectionId: CONNECTION, key: "execution.enabled", value: true, enabled: true },
    ],
  };
  const repository = new PolicyRepository({ client: { marketingExecutionPolicy: { findMany: async ({ where }) => rows[where.key].filter((row) => where.OR.some((clause) => Object.entries(clause).every(([field, expected]) => row[field] === expected))) } } });
  const specific = await repository.resolveEffective({ key: "approval.required.count", platform: "META", connectionId: CONNECTION });
  assert.equal(specific.value, 4);
  assert.equal(specific.effectiveSource, "CONNECTION");
  const platformLevel = await repository.resolveEffective({ key: "approval.required.count", platform: "META" });
  assert.equal(platformLevel.value, 3);
  // A more specific policy can never bypass a restrictive global kill policy.
  const restrictive = await repository.resolveEffective({ key: "execution.enabled", platform: "META", connectionId: CONNECTION });
  assert.equal(restrictive.effectiveSource, "GLOBAL_RESTRICTIVE");
  assert.equal(restrictive.value, false);
  // Approval policy keys validate count and tier strictly.
  assert.equal(POLICY_RULES["approval.required.count"].max, 10);
  assert.throws(() => validatePolicyKey("approval.required.count", "INTEGER", 0), (error) => error.errors[0].reasonCode === "POLICY_INTEGER_OUT_OF_RANGE");
  assert.throws(() => validatePolicyKey("approval.required.tier", "STRING", "INTERN"), (error) => error.errors[0].reasonCode === "POLICY_ENUM_VALUE_INVALID");
  assert.equal(validatePolicyKey("approval.required.tier", "STRING", "executive"), "EXECUTIVE");
});

test("29-POLICY approval eligibility enforces provider, connection, currency, tier and threshold", () => {
  const plan = { id: "plan-1", provider: "META", connectionId: CONNECTION, currencyCode: "USD", budgetLimit: 100, authorId: "author-1", version: 1, validationFingerprint: "a".repeat(64), approvalTier: "EXECUTIVE" };
  const approver = {
    id: "approver-1", status: "ACTIVE", executionRoles: ["APPROVER"], hasEditPermission: true,
    eligibleProviders: ["META"], eligibleConnectionIds: [CONNECTION], eligibleCurrencies: ["USD"],
    eligibleApprovalTiers: ["EXECUTIVE"], maximumApprovalAmount: 1000,
  };
  const approval = { planVersion: 1, validationFingerprint: "a".repeat(64) };
  assert.equal(assertApprovalEligibility({ actor: approver, plan, policy: {}, approval }), true);
  const failures = [
    [{ ...approver, eligibleProviders: ["TIKTOK"] }, "PROVIDER_NOT_ELIGIBLE"],
    [{ ...approver, eligibleConnectionIds: [] }, "CONNECTION_NOT_ELIGIBLE"],
    [{ ...approver, eligibleCurrencies: ["EUR"] }, "CURRENCY_NOT_ELIGIBLE"],
    [{ ...approver, eligibleApprovalTiers: ["ADMIN"] }, "APPROVAL_TIER_NOT_ELIGIBLE"],
    [{ ...approver, maximumApprovalAmount: 50 }, "THRESHOLD_EXCEEDED"],
  ];
  for (const [actor, reasonCode] of failures) {
    assert.throws(() => assertApprovalEligibility({ actor, plan, policy: {}, approval }), (error) => error.errors[0].reasonCode === reasonCode, reasonCode);
  }
});

test("29-POLICY all regulated categories fail closed from server-derived policy, not client flags", async () => {
  assert.deepEqual([...FORBIDDEN_CATEGORIES].sort(), [
    "CREDIT", "CRM_CUSTOMER_LIST", "CUSTOM_AUDIENCE_PII", "DATA_BROKER", "EMPLOYMENT",
    "HEALTHCARE", "HOUSING", "POLITICAL", "PROTECTED_CHARACTERISTIC", "SENSITIVE_TRAIT",
  ].sort());
  for (const advertisingCategory of FORBIDDEN_CATEGORIES) {
    await assert.rejects(
      resolveTargetingCriteria([], { provider: "META", advertisingCategory }),
      (error) => error.errors[0].reasonCode === "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN",
      advertisingCategory,
    );
  }
  // Lower-case client flags cannot dodge the server normalization.
  await assert.rejects(resolveTargetingCriteria([], { provider: "META", advertisingCategory: "healthcare" }), (error) => error.errors[0].reasonCode === "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN");
  // Server-side provider metadata blocks sensitive traits even when the client
  // claims a GENERAL category.
  await assert.rejects(resolveTargetingCriteria([], { provider: "META", advertisingCategory: "GENERAL", providerMetadata: { sensitive: true } }), (error) => error.errors[0].reasonCode === "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN");
  await assert.rejects(resolveTargetingCriteria([], { provider: "LINKEDIN", advertisingCategory: "GENERAL", providerMetadata: { protectedCharacteristic: true } }), (error) => error.errors[0].reasonCode === "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN");
});

test("29-POLICY provider budget conversion is decimal-exact for micro and major unit providers", () => {
  assert.deepEqual(convertProviderBudget("GOOGLE_ADS", "10.50", { currency: "USD" }), { unit: "MICROS", value: "10500000", major: "10.5" });
  assert.deepEqual(convertProviderBudget("X", "0.01", { currency: "USD" }), { unit: "MICROS", value: "10000", major: "0.01" });
  assert.deepEqual(convertProviderBudget("META", "25.00", { currency: "USD" }), { unit: "MAJOR_CURRENCY", value: "25", currency: "USD" });
  assert.throws(() => convertProviderBudget("GOOGLE_ADS", 10.5, { currency: "USD" }), (error) => error.errors[0].reasonCode === "BINARY_FLOAT_MONEY_FORBIDDEN");
  assert.throws(() => convertProviderBudget("BING", "10", { currency: "USD" }), TypeError);
});
