const test = require("node:test");
const assert = require("node:assert/strict");
const { validateCampaignDto } = require("../campaigns/campaign.validator");
const { validateHierarchy } = require("../campaigns/hierarchy.validator");
const { assertImmutableFields } = require("../campaigns/immutable-field-policy");
const { createReplacementPlanDraft } = require("../campaigns/replacement-plan.service");
const { createStatusOperation } = require("../campaigns/status-operation.service");
const { decimal, toMicroUnits, fromMicroUnits, percentageDelta } = require("../budgets/money");
const { convertProviderBudget } = require("../budgets/provider-budget-units");
const { BUDGET_POLICY_DEFAULTS, assertCurrencyMatch, evaluateBudgetChange, assertBudgetWithinPolicy } = require("../policy/budget-guard.service");
const { createPolicyService } = require("../policy/policy.service");
const { assertProviderUrl, safeRedirectPolicy } = require("../adapters/provider-network.policy");
const { createExecutionMetrics, sanitizeExecutionEvent } = require("../execution.observability");

const CONNECTION = "22222222-2222-4222-8222-222222222222";
function campaign(overrides = {}) {
  return { name: "Safe search", objective: "leads", campaignType: "SEARCH", startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-08-31T00:00:00.000Z", budgetRef: "budget", bidding: { strategy: "MANUAL_CPC", bidAmount: "1.25" }, networkOrPlacements: ["SEARCH", "SEARCH"], declarations: { euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" }, tracking: { utmTemplate: "utm_source=admin" }, ...overrides };
}
function budgetInput(overrides = {}) {
  return { provider: "GOOGLE_ADS", connectionId: CONNECTION, accountExternalId: "1234567890", connectionPolicyConfigured: true, currency: "USD", accountCurrency: "USD", existingBudget: "100.00", requestedBudget: "110.00", spendToDate: "20.00", semantics: "DAILY", snapshotAt: "2026-07-22T10:00:00.000Z", providerMinimum: "1.00", providerMaximum: "1000.00", sharedBudgetAffectedCampaigns: [], ...overrides };
}
const enabledPolicy = { budgetIncreaseEnabled: true, budgetDecreaseEnabled: true, maximumBudgetIncreasePct: "20", maximumBudgetDecreasePct: "20", maximumPlanSpendExposure: { amount: "500.00", currency: "USD" }, minimumApprovalsForSpendIncrease: 2, requireFreshSpendSnapshotMinutes: 15, allowSharedBudgetMutation: false };

function expectCode(code, fn) { assert.throws(fn, (error) => error.code === code); }

test("normalized campaign DTO is strict, UTC, paused and material-safe", () => {
  const value = validateCampaignDto(campaign(), { provider: "GOOGLE_ADS", resolvedReferences: ["budget"], supportedPlacements: ["SEARCH"] });
  assert.equal(value.status, "PAUSED");
  assert.equal(value.objective, "LEADS");
  assert.deepEqual(value.networkOrPlacements, ["SEARCH"]);
  expectCode("INVALID_EXECUTION_PLAN", () => validateCampaignDto(campaign({ unknown: true }), { provider: "GOOGLE_ADS" }));
  expectCode("INVALID_EXECUTION_PLAN", () => validateCampaignDto(campaign({ authorization: "secret" }), { provider: "GOOGLE_ADS" }));
  expectCode("INVALID_EXECUTION_PLAN", () => validateCampaignDto(campaign({ status: "ACTIVE" }), { provider: "GOOGLE_ADS" }));
  expectCode("INVALID_EXECUTION_PLAN", () => validateCampaignDto(campaign({ endAt: "2026-07-01T00:00:00.000Z" }), { provider: "GOOGLE_ADS" }));
  expectCode("PROVIDER_CAPABILITY_UNAVAILABLE", () => validateCampaignDto(campaign({ campaignType: "AUCTION" }), { provider: "GOOGLE_ADS" }));
});

test("hierarchy rejects unresolved, cyclic, cross-account and cross-provider parents", () => {
  const base = { provider: "GOOGLE_ADS", connectionId: CONNECTION, accountExternalId: "1234567890" };
  const valid = validateHierarchy([{ ...base, clientReference: "budget", resourceType: "BUDGET", sequence: 0 }, { ...base, clientReference: "campaign", resourceType: "CAMPAIGN", dependsOn: ["budget"], sequence: 1 }], base);
  assert.deepEqual(valid.map((item) => item.clientReference), ["budget", "campaign"]);
  expectCode("INVALID_EXECUTION_PLAN", () => validateHierarchy([{ ...base, clientReference: "a", dependsOn: ["missing"] }], base));
  expectCode("INVALID_EXECUTION_PLAN", () => validateHierarchy([{ ...base, clientReference: "a", dependsOn: ["b"] }, { ...base, clientReference: "b", dependsOn: ["a"] }], base));
  expectCode("INVALID_EXECUTION_PLAN", () => validateHierarchy([{ ...base, clientReference: "a", accountExternalId: "other" }], base));
  expectCode("INVALID_EXECUTION_PLAN", () => validateHierarchy([{ ...base, clientReference: "a", provider: "META" }], base));
});

test("immutable changes require explicit replacement and replacement stays paused", () => {
  expectCode("IMMUTABLE_FIELD_CHANGE", () => assertImmutableFields({ provider: "GOOGLE_ADS", current: { campaignType: "SEARCH" }, requested: { campaignType: "PERFORMANCE_MAX" } }));
  const replacement = createReplacementPlanDraft({ oldResource: { id: "old" }, desiredResource: { id: "new", status: "ACTIVE" }, retirementStrategy: "PAUSE_AFTER_VERIFIED", spendExposure: {}, activationPlan: {} });
  assert.equal(replacement.desiredResource.status, "PAUSED");
  assert.equal(replacement.activationPlan.separateApprovalRequired, true);
});

test("PAUSE and RESUME are independent and activation requires exposure and approval", () => {
  const paused = createStatusOperation({ type: "PAUSE", resourceType: "CAMPAIGN", resourceId: "campaign-1", beforeState: { status: "ACTIVE" } });
  assert.equal(paused.desiredStatus, "PAUSED");
  expectCode("APPROVAL_NOT_ELIGIBLE", () => createStatusOperation({ type: "RESUME", resourceType: "CAMPAIGN", resourceId: "campaign-1", beforeState: { status: "PAUSED" } }));
  const resumed = createStatusOperation({ type: "RESUME", resourceType: "CAMPAIGN", resourceId: "campaign-1", beforeState: { status: "PAUSED" }, exposure: { blockingViolations: [] }, approvalFingerprint: "a".repeat(64) });
  assert.equal(resumed.readBackRequired, true);
  expectCode("EXECUTION_PRECONDITION_CHANGED", () => createStatusOperation({ type: "RESUME", resourceType: "CAMPAIGN", resourceId: "campaign-1", beforeState: { status: "PAUSED", capturedAt: "2026-07-22T09:00:00.000Z" }, exposure: { blockingViolations: [] }, approvalFingerprint: "a".repeat(64), now: new Date("2026-07-22T10:00:00.000Z") }));
});

test("money rejects Number arithmetic and converts micros exactly and reversibly", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => decimal(0.1, { currency: "USD" }));
  expectCode("INVALID_EXECUTION_PLAN", () => decimal("1.001", { currency: "USD" }));
  assert.deepEqual(toMicroUnits("1.25", { currency: "USD" }), { unit: "MICROS", value: "1250000", major: "1.25" });
  assert.equal(fromMicroUnits("1250000").toFixed(), "1.25");
  assert.equal(percentageDelta("100", "125").toFixed(), "25");
  assert.equal(convertProviderBudget("X", "2.50", { currency: "USD" }).value, "2500000");
  expectCode("INVALID_EXECUTION_PLAN", () => toMicroUnits("999999999999999.99", { currency: "USD" }));
});

test("budget guard enforces currency, caps, freshness, approvals and null-is-disabled defaults", () => {
  assert.equal(assertCurrencyMatch("usd", "USD"), "USD");
  expectCode("INVALID_EXECUTION_PLAN", () => assertCurrencyMatch("EUR", "USD"));
  expectCode("INVALID_EXECUTION_PLAN", () => assertCurrencyMatch("USD", null));
  const packet = evaluateBudgetChange(budgetInput(), enabledPolicy, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.deepEqual(packet.blockingViolations, []);
  assert.equal(packet.requiredApprovals, 2);
  assert.equal(packet.percentageDelta, "10");
  assert.ok(packet.warnings.includes("DAILY_BUDGET_IS_NOT_GUARANTEED_DAILY_SPEND"));
  const defaults = evaluateBudgetChange(budgetInput(), BUDGET_POLICY_DEFAULTS, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.ok(defaults.blockingViolations.includes("BUDGET_INCREASE_DISABLED"));
  assert.ok(defaults.blockingViolations.includes("MAXIMUM_EXPOSURE_NOT_CONFIGURED"));
  expectCode("BUDGET_POLICY_REQUIRED", () => evaluateBudgetChange(budgetInput({ connectionPolicyConfigured: false }), enabledPolicy));
});

test("budget guard blocks stale state, shared impact, cross-currency caps and changed preconditions", () => {
  const stale = evaluateBudgetChange(budgetInput(), enabledPolicy, { now: new Date("2026-07-22T10:16:00.000Z") });
  assert.ok(stale.blockingViolations.includes("STALE_SPEND_SNAPSHOT"));
  const shared = evaluateBudgetChange(budgetInput({ sharedBudgetAffectedCampaigns: [{ id: "c1" }, { id: "c2" }] }), enabledPolicy, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.ok(shared.blockingViolations.includes("SHARED_BUDGET_MUTATION_DISABLED"));
  const allowed = evaluateBudgetChange(budgetInput({ sharedBudgetAffectedCampaigns: [{ id: "c1" }, { id: "c2" }] }), { ...enabledPolicy, allowSharedBudgetMutation: true }, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.equal(allowed.sharedBudgetAffectedCampaigns.length, 2);
  const cross = evaluateBudgetChange(budgetInput(), { ...enabledPolicy, maximumPlanSpendExposure: { amount: "500", currency: "EUR" } }, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.ok(cross.blockingViolations.includes("CROSS_CURRENCY_CAP"));
  expectCode("EXECUTION_PRECONDITION_CHANGED", () => assertBudgetWithinPolicy(budgetInput(), enabledPolicy, { now: new Date("2026-07-22T10:16:00.000Z") }));
});

test("budget guard evaluates all cap layers, decrease commitments and exact precondition state", () => {
  const caps = evaluateBudgetChange(budgetInput({ accountSpendExposure: "600", campaignSpendExposure: "400", planSpendExposure: "300", dailyExposure: "250", parentBudgetLimit: "105", childBudgetLimit: "109" }), { ...enabledPolicy, absoluteAccountCap: "500", absoluteCampaignCap: "350", absolutePlanCap: "250", dailyCap: "200" }, { now: new Date("2026-07-22T10:10:00.000Z") });
  for (const code of ["ACCOUNT_CAP_EXCEEDED", "CAMPAIGN_CAP_EXCEEDED", "PLAN_CAP_EXCEEDED", "DAILY_CAP_EXCEEDED", "PARENT_BUDGET_LIMIT_EXCEEDED", "CHILD_BUDGET_LIMIT_EXCEEDED"]) assert.ok(caps.blockingViolations.includes(code));
  const decrease = evaluateBudgetChange(budgetInput({ requestedBudget: "50", committedSpend: "60", minimumRemainingBudget: "70", childRequiredBudget: "80" }), enabledPolicy, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.ok(decrease.blockingViolations.includes("BELOW_COMMITTED_SPEND"));
  assert.ok(decrease.blockingViolations.includes("REMAINING_SCHEDULE_REQUIREMENT_VIOLATED"));
  assert.ok(decrease.blockingViolations.includes("CHILD_BUDGET_CONSTRAINT_VIOLATED"));
  const changed = budgetInput({ approvedProviderState: { budget: "100", status: "PAUSED" }, currentProviderState: { budget: "101", status: "PAUSED" } });
  expectCode("EXECUTION_PRECONDITION_CHANGED", () => assertBudgetWithinPolicy(changed, enabledPolicy, { now: new Date("2026-07-22T10:10:00.000Z") }));
  const undiscovered = evaluateBudgetChange(budgetInput({ isSharedBudget: true }), enabledPolicy, { now: new Date("2026-07-22T10:10:00.000Z") });
  assert.ok(undiscovered.blockingViolations.includes("SHARED_BUDGET_IMPACT_REQUIRED"));
});

test("policy update requires elevated actor and writes immutable audit evidence", async () => {
  let audited;
  const service = createPolicyService({ repository: { update: async (data) => ({ ...data, version: 2 }) }, audit: { writeImmutable: async (data) => { audited = data; } } });
  await assert.rejects(service.update({ actor: { id: "a", tier: "EMPLOYEE" }, policy: { id: "p" }, expectedVersion: 1, valueType: "BOOLEAN", value: true, enabled: true, reason: "x" }), (error) => error.code === "APPROVAL_NOT_ELIGIBLE");
  const updated = await service.update({ actor: { id: "a", tier: "EXECUTIVE" }, policy: { id: "p", connectionId: CONNECTION }, expectedVersion: 1, valueType: "BOOLEAN", value: true, enabled: true, reason: "Approved guardrail" });
  assert.equal(updated.version, 2);
  assert.equal(audited.action, "MARKETING_EXECUTION_POLICY_UPDATED");
});

test("provider host policy is exact and observability remains secret-safe", () => {
  assert.equal(assertProviderUrl("GOOGLE_ADS", "https://googleads.googleapis.com/v24/customers/1").hostname, "googleads.googleapis.com");
  expectCode("PROVIDER_CAPABILITY_UNAVAILABLE", () => assertProviderUrl("GOOGLE_ADS", "https://googleads.googleapis.com.evil.test/v24"));
  expectCode("PROVIDER_CAPABILITY_UNAVAILABLE", () => safeRedirectPolicy("META", "https://graph.facebook.com/v25.0/me", "https://evil.test/steal"));
  assert.deepEqual(sanitizeExecutionEvent({ provider: "META", accessToken: "secret" }), { provider: "META" });
  const metrics = createExecutionMetrics(); metrics.increment("permissionFailures");
  assert.equal(metrics.snapshot().permissionFailures, 1);
});
