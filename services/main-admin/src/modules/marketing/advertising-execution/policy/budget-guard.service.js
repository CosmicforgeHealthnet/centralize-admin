const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { hashExecutionJson } = require("../execution-json.validator");
const { decimal, normalizeCurrency, percentageDelta } = require("../budgets/money");

const BUDGET_POLICY_DEFAULTS = Object.freeze({
  budgetIncreaseEnabled: false,
  budgetDecreaseEnabled: false,
  maximumBudgetIncreasePct: null,
  maximumBudgetDecreasePct: null,
  maximumPlanSpendExposure: null,
  minimumApprovalsForSpendIncrease: 2,
  requireFreshSpendSnapshotMinutes: 15,
  allowSharedBudgetMutation: false,
});

function moneyString(value, options) { return decimal(value, options).toFixed(); }

function assertCurrencyMatch(planCurrency, accountCurrency) {
  const plan = normalizeCurrency(planCurrency);
  const account = normalizeCurrency(accountCurrency);
  if (plan !== account) throw executionError("INVALID_EXECUTION_PLAN", { field: "currencyCode", reasonCode: "ACCOUNT_CURRENCY_MISMATCH", planCurrency: plan, accountCurrency: account });
  return account;
}

function isFreshSnapshot(snapshotAt, now, minutes) {
  const timestamp = new Date(snapshotAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= now.getTime() && now.getTime() - timestamp <= minutes * 60 * 1000;
}

function comparablePreconditionHash(value) {
  if (value == null) return null;
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  return hashExecutionJson(value, "beforeState").hash;
}

function capAmount(cap, currency) {
  if (cap == null) return null;
  if (typeof cap === "object" && !Array.isArray(cap)) {
    if (normalizeCurrency(cap.currency) !== currency) return { currencyMismatch: true, amount: null };
    return { currencyMismatch: false, amount: decimal(cap.amount, { currency }) };
  }
  return { currencyMismatch: false, amount: decimal(cap, { currency }) };
}

function evaluateBudgetChange(input, policy = {}, { now = new Date() } = {}) {
  const effective = { ...BUDGET_POLICY_DEFAULTS, ...policy };
  if (!input.connectionPolicyConfigured) throw executionError("BUDGET_POLICY_REQUIRED", { connectionId: input.connectionId });
  const currency = assertCurrencyMatch(input.currency, input.accountCurrency);
  const snapshotTime = new Date(input.snapshotAt);
  if (!Number.isFinite(snapshotTime.getTime())) throw executionError("INVALID_EXECUTION_PLAN", { field: "snapshotAt", reasonCode: "INVALID_SPEND_SNAPSHOT_TIMESTAMP" });
  const current = decimal(input.existingBudget, { currency });
  const requested = decimal(input.requestedBudget, { currency, allowZero: false });
  const spent = decimal(input.spendToDate || "0", { currency });
  const minimum = input.providerMinimum == null ? null : decimal(input.providerMinimum, { currency });
  const maximum = input.providerMaximum == null ? null : decimal(input.providerMaximum, { currency });
  const delta = requested.minus(current);
  const pct = percentageDelta(current, requested);
  const violations = [];
  const warnings = [];

  const approvedPreconditionHash = comparablePreconditionHash(input.approvedPreconditionHash || input.approvedProviderState);
  const currentPreconditionHash = comparablePreconditionHash(input.currentPreconditionHash || input.currentProviderState);
  if ((approvedPreconditionHash || currentPreconditionHash) && approvedPreconditionHash !== currentPreconditionHash) violations.push("MATERIAL_PRECONDITION_CHANGED");

  if (!isFreshSnapshot(input.snapshotAt, now, effective.requireFreshSpendSnapshotMinutes)) violations.push("STALE_SPEND_SNAPSHOT");
  if (minimum && requested.lessThan(minimum)) violations.push("BELOW_PROVIDER_MINIMUM");
  if (maximum && requested.greaterThan(maximum)) violations.push("ABOVE_PROVIDER_MAXIMUM");
  if (requested.lessThan(spent)) violations.push("BELOW_SPEND_TO_DATE");
  if (input.committedSpend != null && requested.lessThan(decimal(input.committedSpend, { currency }))) violations.push("BELOW_COMMITTED_SPEND");
  if (input.minimumRemainingBudget != null && requested.lessThan(decimal(input.minimumRemainingBudget, { currency }))) violations.push("REMAINING_SCHEDULE_REQUIREMENT_VIOLATED");
  if (input.childRequiredBudget != null && requested.lessThan(decimal(input.childRequiredBudget, { currency }))) violations.push("CHILD_BUDGET_CONSTRAINT_VIOLATED");
  if (delta.isPositive()) {
    if (!effective.budgetIncreaseEnabled) violations.push("BUDGET_INCREASE_DISABLED");
    if (effective.maximumBudgetIncreasePct == null) violations.push("MAXIMUM_INCREASE_NOT_CONFIGURED");
    else if (pct && pct.greaterThan(decimal(effective.maximumBudgetIncreasePct))) violations.push("MAXIMUM_INCREASE_EXCEEDED");
  }
  if (delta.isNegative()) {
    if (!effective.budgetDecreaseEnabled) violations.push("BUDGET_DECREASE_DISABLED");
    if (effective.maximumBudgetDecreasePct == null) violations.push("MAXIMUM_DECREASE_NOT_CONFIGURED");
    else if (pct && pct.abs().greaterThan(decimal(effective.maximumBudgetDecreasePct))) violations.push("MAXIMUM_DECREASE_EXCEEDED");
  }
  if (effective.maximumPlanSpendExposure == null) violations.push("MAXIMUM_EXPOSURE_NOT_CONFIGURED");
  else {
    const cap = effective.maximumPlanSpendExposure;
    if (normalizeCurrency(cap.currency) !== currency) violations.push("CROSS_CURRENCY_CAP");
    else if (requested.greaterThan(decimal(cap.amount, { currency }))) violations.push("PLAN_EXPOSURE_CAP_EXCEEDED");
  }
  const configuredCaps = [
    ["ACCOUNT_CAP_EXCEEDED", effective.absoluteAccountCap, input.accountSpendExposure ?? requested],
    ["CAMPAIGN_CAP_EXCEEDED", effective.absoluteCampaignCap, input.campaignSpendExposure ?? requested],
    ["PLAN_CAP_EXCEEDED", effective.absolutePlanCap, input.planSpendExposure ?? requested],
    ["DAILY_CAP_EXCEEDED", effective.dailyCap, input.dailyExposure ?? (input.semantics === "DAILY" ? requested : null)],
    ["LIFETIME_CAP_EXCEEDED", effective.lifetimeCap, input.lifetimeExposure ?? (["LIFETIME", "TOTAL"].includes(input.semantics) ? requested : null)],
    ["PARENT_BUDGET_LIMIT_EXCEEDED", input.parentBudgetLimit, requested],
    ["CHILD_BUDGET_LIMIT_EXCEEDED", input.childBudgetLimit, requested],
  ];
  for (const [code, cap, exposure] of configuredCaps) {
    if (cap == null || exposure == null) continue;
    const resolvedCap = capAmount(cap, currency);
    if (resolvedCap.currencyMismatch) violations.push("CROSS_CURRENCY_CAP");
    else if (decimal(exposure, { currency }).greaterThan(resolvedCap.amount)) violations.push(code);
  }
  const affected = input.sharedBudgetAffectedCampaigns || [];
  if (input.isSharedBudget && !affected.length) violations.push("SHARED_BUDGET_IMPACT_REQUIRED");
  if ((input.isSharedBudget || affected.length > 1) && !effective.allowSharedBudgetMutation) violations.push("SHARED_BUDGET_MUTATION_DISABLED");
  if (input.semantics === "BID") violations.push("BID_IS_NOT_BUDGET");
  if (input.semantics === "DAILY") warnings.push("DAILY_BUDGET_IS_NOT_GUARANTEED_DAILY_SPEND");

  const expiresAt = new Date(snapshotTime.getTime() + effective.requireFreshSpendSnapshotMinutes * 60 * 1000).toISOString();
  return sanitizeExecutionJson({
    provider: input.provider,
    connectionId: input.connectionId,
    accountExternalId: input.accountExternalId,
    currency,
    resourceType: input.resourceType || "BUDGET",
    budgetSemantics: input.semantics,
    existingBudget: current.toFixed(), requestedBudget: requested.toFixed(), absoluteDelta: delta.toFixed(),
    percentageDelta: pct?.toFixed() || null,
    dailyExposure: input.semantics === "DAILY" ? requested.toFixed() : null,
    totalExposure: ["LIFETIME", "TOTAL"].includes(input.semantics) ? requested.toFixed() : null,
    spendToDate: spent.toFixed(), remainingSchedule: input.remainingSchedule || null,
    sharedBudgetAffectedCampaigns: affected,
    providerMinimum: minimum?.toFixed() || null, providerMaximum: maximum?.toFixed() || null,
    applicableCaps: {
      maximumPlanSpendExposure: effective.maximumPlanSpendExposure,
      maximumBudgetIncreasePct: effective.maximumBudgetIncreasePct,
      maximumBudgetDecreasePct: effective.maximumBudgetDecreasePct,
      absoluteAccountCap: effective.absoluteAccountCap ?? null,
      absoluteCampaignCap: effective.absoluteCampaignCap ?? null,
      absolutePlanCap: effective.absolutePlanCap ?? null,
      dailyCap: effective.dailyCap ?? null,
      lifetimeCap: effective.lifetimeCap ?? null,
      parentBudgetLimit: input.parentBudgetLimit ?? null,
      childBudgetLimit: input.childBudgetLimit ?? null,
    },
    requiredApprovals: delta.isPositive() ? Math.max(2, effective.minimumApprovalsForSpendIncrease) : 1,
    requiredApproverTier: input.requiredApproverTier || "EXECUTIVE",
    snapshotTimestamp: snapshotTime.toISOString(), snapshotExpiry: expiresAt,
    approvedPreconditionHash, currentPreconditionHash,
    warnings, blockingViolations: [...new Set(violations)],
  }, "approvalScope");
}

function assertBudgetWithinPolicy(plan, policy, context = {}) {
  const packet = evaluateBudgetChange(plan, policy, context);
  if (packet.blockingViolations.length) {
    const precondition = packet.blockingViolations.some((code) => ["STALE_SPEND_SNAPSHOT", "BELOW_SPEND_TO_DATE", "MATERIAL_PRECONDITION_CHANGED"].includes(code));
    throw executionError(precondition ? "EXECUTION_PRECONDITION_CHANGED" : "EXECUTION_BUDGET_POLICY_VIOLATION", { reasonCode: "BUDGET_POLICY_EXCEEDED", violations: packet.blockingViolations });
  }
  return packet;
}

module.exports = { BUDGET_POLICY_DEFAULTS, assertCurrencyMatch, isFreshSnapshot, comparablePreconditionHash, evaluateBudgetChange, assertBudgetWithinPolicy, moneyString };
