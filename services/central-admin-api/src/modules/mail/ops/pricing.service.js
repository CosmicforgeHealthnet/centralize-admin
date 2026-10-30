"use strict";

// GAP 3 (spec 13.3): approved provider pricing and per-dispatch cost
// ESTIMATES. Nothing here is billed spend: Resend has no billing/spend API, so
// actual spend is always UNAVAILABLE and every amount is labelled
// "estimated (not billed)".
//
// - mail_provider_pricing rows are created only by a mail admin with a fresh
//   MFA step-up (purpose MAIL_PRICING_CHANGE) and carry their source
//   (CONTRACT | PRICE_LIST | INVOICE) and a reference. Effective periods are
//   [effective_from, effective_to) and never overlap per provider and scope
//   (organization_id, or NULL for the whole account).
// - marketing_dispatch_costs: one row per finished dispatch, computed once at
//   finalize as accepted recipients x the unit cost of the pricing effective
//   when the provider completed the send. A pricing change never rewrites a
//   stored estimate; only an audited re-estimate by a mail admin does. No
//   pricing -> status UNAVAILABLE (never zero).
// - an included monthly allowance is reported as a note and never subtracted
//   per campaign.

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");

const SOURCES = ["CONTRACT", "PRICE_LIST", "INVOICE"];
const MAX_UNIT_MICROS = 1_000_000_000_000n; // 1,000,000 currency units per email
const LABEL = "estimated (not billed)";

let CURRENCIES = null;
function knownCurrency(code) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  if (CURRENCIES === null) {
    try {
      CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      CURRENCIES = new Set();
    }
  }
  return CURRENCIES.size === 0 || CURRENCIES.has(code);
}

function invalid(field, reason) {
  return mailError("MAIL_VALIDATION_FAILED", { status: 422, field, reason });
}

// "0.0009" -> 900n micros. Up to 6 decimals; no exponent, no negatives.
function decimalToMicros(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function microsToDecimal(micros) {
  if (micros === null || micros === undefined) return null;
  const value = BigInt(micros);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function parseDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(field, "INVALID_DATE");
  return date;
}

function serializePricing(row) {
  return {
    id: row.id,
    provider: row.provider,
    organizationId: row.organizationId,
    currency: row.currency,
    unitCostMicros: Number(row.unitCostMicros),
    unitCost: microsToDecimal(row.unitCostMicros),
    includedMonthly: row.includedMonthly,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    source: row.source,
    reference: row.reference,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    label: LABEL,
  };
}

function overlaps(fromA, toA, fromB, toB) {
  const endA = toA ? toA.getTime() : Infinity;
  const endB = toB ? toB.getTime() : Infinity;
  return fromA.getTime() < endB && fromB.getTime() < endA;
}

function createPricingService({ client, features = null, audit, stepUp, clock = () => new Date(), logger = null }) {
  const ready = async () => {
    if (!features) return false;
    try {
      return await features.isReady();
    } catch {
      return false;
    }
  };
  async function requireReady() {
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "provider_pricing" });
  }

  function validateInput(input) {
    const provider = String(input.provider || "resend").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(provider)) throw invalid("provider", "INVALID_PROVIDER");
    const currency = String(input.currency || "").trim();
    if (!knownCurrency(currency)) throw invalid("currency", "INVALID_CURRENCY");
    let micros;
    if (input.unitCostMicros !== undefined && input.unitCostMicros !== null && input.unitCostMicros !== "") {
      const text = String(input.unitCostMicros).trim();
      if (!/^\d{1,13}$/.test(text)) throw invalid("unitCostMicros", String(input.unitCostMicros).trim().startsWith("-") ? "NEGATIVE" : "INVALID_NUMBER");
      micros = BigInt(text);
    } else {
      if (String(input.unitCost ?? "").trim().startsWith("-")) throw invalid("unitCost", "NEGATIVE");
      micros = decimalToMicros(input.unitCost);
      if (micros === null) throw invalid("unitCost", "INVALID_NUMBER");
    }
    if (micros > MAX_UNIT_MICROS) throw invalid("unitCost", "TOO_LARGE");
    let includedMonthly = null;
    if (input.includedMonthly !== undefined && input.includedMonthly !== null && input.includedMonthly !== "") {
      const number = Number(input.includedMonthly);
      if (!Number.isInteger(number) || number < 0 || number > 2147483647) throw invalid("includedMonthly", number < 0 ? "NEGATIVE" : "INVALID_NUMBER");
      includedMonthly = number;
    }
    const effectiveFrom = parseDate(input.effectiveFrom, "effectiveFrom");
    if (!effectiveFrom) throw invalid("effectiveFrom", "REQUIRED");
    const effectiveTo = parseDate(input.effectiveTo, "effectiveTo");
    if (effectiveTo && effectiveTo <= effectiveFrom) throw invalid("effectiveTo", "NOT_AFTER_EFFECTIVE_FROM");
    const source = String(input.source || "").trim().toUpperCase();
    if (!SOURCES.includes(source)) throw invalid("source", "INVALID_SOURCE");
    const reference = String(input.reference || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!reference || reference.length > 200) throw invalid("reference", reference ? "TOO_LONG" : "REQUIRED");
    const organizationId = input.organizationId ? String(input.organizationId) : null;
    if (organizationId && !policy.isUuid(organizationId)) throw invalid("organizationId", "INVALID_ID");
    return { provider, organizationId, currency, unitCostMicros: micros, includedMonthly, effectiveFrom, effectiveTo, source, reference };
  }

  // One writer at a time per provider + scope (overlap check is race-free).
  async function lockScope(tx, provider, organizationId) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mail_pricing:${provider}:${organizationId || "account"}`}))`;
  }

  async function assertNoOverlap(tx, { provider, organizationId, effectiveFrom, effectiveTo }, exceptId = null) {
    const rows = await tx.mailProviderPricing.findMany({ where: { provider, organizationId, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    const clash = rows.find((row) => overlaps(effectiveFrom, effectiveTo, row.effectiveFrom, row.effectiveTo));
    if (clash) throw invalid("effectiveFrom", "PRICING_PERIOD_OVERLAP");
  }

  async function list(user, { provider, organizationId } = {}) {
    await policy.requireMailAdmin(client, user, "VIEW");
    await requireReady();
    const rows = await client.mailProviderPricing.findMany({
      where: { ...(provider ? { provider: String(provider) } : {}), ...(policy.isUuid(organizationId) ? { organizationId } : {}) },
      orderBy: [{ provider: "asc" }, { effectiveFrom: "desc" }],
      take: 500,
    });
    return { items: rows.map(serializePricing), label: LABEL, billed: { status: "UNAVAILABLE", reason: "No provider billing API exists; pricing rows produce estimates only." } };
  }

  async function create(user, input = {}, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    await requireReady();
    const data = validateInput(input);
    if (data.organizationId && !(await client.mailOrganization.findUnique({ where: { id: data.organizationId } }))) throw invalid("organizationId", "UNKNOWN_ORGANIZATION");
    const row = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, input.stepUpId, "MAIL_PRICING_CHANGE", context);
      await lockScope(tx, data.provider, data.organizationId);
      await assertNoOverlap(tx, data);
      const created = await tx.mailProviderPricing.create({ data: { ...data, createdBy: user.id } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_PROVIDER_PRICING_CREATED", targetType: "mail_provider_pricing", targetId: created.id, organizationId: data.organizationId, metadata: { provider: data.provider, currency: data.currency, unitCostMicros: Number(data.unitCostMicros), includedMonthly: data.includedMonthly, effectiveFrom: data.effectiveFrom.toISOString(), effectiveTo: data.effectiveTo?.toISOString() || null, source: data.source, reference: data.reference } }, context, tx);
      return created;
    });
    return serializePricing(row);
  }

  // Ends (or re-dates the end of) a pricing period. Stored dispatch estimates
  // are not recomputed.
  async function setEffectiveTo(user, pricingId, input = {}, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    await requireReady();
    if (!policy.isUuid(pricingId)) throw mailError("MAIL_NOT_FOUND", { resource: "pricing" });
    const effectiveTo = parseDate(input.effectiveTo, "effectiveTo");
    const row = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, input.stepUpId, "MAIL_PRICING_CHANGE", context);
      const current = await tx.mailProviderPricing.findUnique({ where: { id: pricingId } });
      if (!current) throw mailError("MAIL_NOT_FOUND", { resource: "pricing" });
      await lockScope(tx, current.provider, current.organizationId);
      if (effectiveTo && effectiveTo <= current.effectiveFrom) throw invalid("effectiveTo", "NOT_AFTER_EFFECTIVE_FROM");
      await assertNoOverlap(tx, { provider: current.provider, organizationId: current.organizationId, effectiveFrom: current.effectiveFrom, effectiveTo }, current.id);
      const updated = await tx.mailProviderPricing.update({ where: { id: pricingId }, data: { effectiveTo } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_PROVIDER_PRICING_PERIOD_CHANGED", targetType: "mail_provider_pricing", targetId: pricingId, organizationId: current.organizationId, metadata: { previousEffectiveTo: current.effectiveTo?.toISOString() || null, effectiveTo: effectiveTo?.toISOString() || null } }, context, tx);
      return updated;
    });
    return serializePricing(row);
  }

  // Deletes a mistaken row that no estimate uses yet.
  async function remove(user, pricingId, input = {}, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    await requireReady();
    if (!policy.isUuid(pricingId)) throw mailError("MAIL_NOT_FOUND", { resource: "pricing" });
    await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, input.stepUpId, "MAIL_PRICING_CHANGE", context);
      const current = await tx.mailProviderPricing.findUnique({ where: { id: pricingId } });
      if (!current) throw mailError("MAIL_NOT_FOUND", { resource: "pricing" });
      if (await tx.marketingDispatchCost.count({ where: { pricingId } })) throw mailError("MAIL_INVALID_TRANSITION", { reason: "PRICING_IN_USE_BY_ESTIMATES" });
      await tx.mailProviderPricing.delete({ where: { id: pricingId } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_PROVIDER_PRICING_DELETED", targetType: "mail_provider_pricing", targetId: pricingId, organizationId: current.organizationId, metadata: { provider: current.provider, currency: current.currency } }, context, tx);
    });
    return { deleted: true };
  }

  // Pricing effective at `at` for a brand: a brand-specific row wins over the
  // account-wide row. Periods are [from, to): a row starting exactly at `at`
  // applies, a row ending exactly at `at` does not.
  async function effectiveAt(db, provider, organizationId, at) {
    const where = (org) => ({ provider, organizationId: org, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] });
    return (organizationId ? await db.mailProviderPricing.findFirst({ where: where(organizationId), orderBy: { effectiveFrom: "desc" } }) : null)
      || (await db.mailProviderPricing.findFirst({ where: where(null), orderBy: { effectiveFrom: "desc" } }));
  }

  function costData({ dispatchId, organizationId, basisCount, pricing, at }) {
    return {
      dispatchId,
      organizationId,
      basis: "ACCEPTED_RECIPIENTS",
      basisCount: Math.max(0, Math.trunc(basisCount)),
      pricingId: pricing?.id || null,
      estimatedCostMicros: pricing ? BigInt(Math.max(0, Math.trunc(basisCount))) * BigInt(pricing.unitCostMicros) : null,
      currency: pricing?.currency || null,
      status: pricing ? "ESTIMATED" : "UNAVAILABLE",
      computedAt: at,
    };
  }

  // Called once when a dispatch is finalized. Never throws (reporting must
  // not affect dispatch) and never overwrites an existing estimate.
  async function recordDispatchCost({ dispatchId, organizationId, provider, basisCount, sentAt }) {
    try {
      if (!(await ready())) return { recorded: false, reason: "FEATURE_NOT_READY" };
      if (await client.marketingDispatchCost.findUnique({ where: { dispatchId } })) return { recorded: false, reason: "ALREADY_ESTIMATED" };
      const at = sentAt ? new Date(sentAt) : clock();
      const pricing = await effectiveAt(client, provider, organizationId, at);
      const row = await client.marketingDispatchCost.create({ data: costData({ dispatchId, organizationId, basisCount, pricing, at: clock() }) });
      return { recorded: true, status: row.status };
    } catch (error) {
      if (error?.code === "P2002") return { recorded: false, reason: "ALREADY_ESTIMATED" };
      logger?.warn?.(`[Mail] dispatch cost estimate not recorded (${error?.code || "error"})`);
      return { recorded: false, reason: "ERROR" };
    }
  }

  // Explicit, audited re-estimate (e.g. pricing was entered late).
  async function reEstimate(user, dispatchId, input = {}, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    await requireReady();
    if (!policy.isUuid(dispatchId)) throw mailError("MAIL_NOT_FOUND", { resource: "dispatch" });
    const dispatch = await client.marketingBroadcastDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch) throw mailError("MAIL_NOT_FOUND", { resource: "dispatch" });
    const provider = String(input.provider || "resend").trim().toLowerCase();
    const result = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, input.stepUpId, "MAIL_PRICING_CHANGE", context);
      const previous = await tx.marketingDispatchCost.findUnique({ where: { dispatchId } });
      if (!previous) throw mailError("MAIL_INVALID_TRANSITION", { reason: "DISPATCH_NOT_ESTIMATED_YET" });
      const at = dispatch.providerSentAt || dispatch.completedAt || clock();
      const pricing = await effectiveAt(tx, provider, dispatch.organizationId, at);
      const data = costData({ dispatchId, organizationId: dispatch.organizationId, basisCount: previous.basisCount, pricing, at: clock() });
      const updated = await tx.marketingDispatchCost.update({ where: { dispatchId }, data });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_DISPATCH_COST_REESTIMATED", targetType: "marketing_broadcast", targetId: dispatchId, organizationId: dispatch.organizationId, metadata: { previousStatus: previous.status, previousPricingId: previous.pricingId, previousCostMicros: previous.estimatedCostMicros === null ? null : Number(previous.estimatedCostMicros), status: updated.status, pricingId: updated.pricingId, costMicros: updated.estimatedCostMicros === null ? null : Number(updated.estimatedCostMicros) } }, context, tx);
      return updated;
    });
    return serializeCost(result, await (result.pricingId ? client.mailProviderPricing.findUnique({ where: { id: result.pricingId } }) : null));
  }

  function serializeCost(cost, pricing) {
    return {
      status: cost.status,
      amount: cost.status === "ESTIMATED" ? microsToDecimal(cost.estimatedCostMicros) : null,
      amountMicros: cost.status === "ESTIMATED" ? Number(cost.estimatedCostMicros) : null,
      currency: cost.currency,
      basis: cost.basis,
      basisCount: cost.basisCount,
      pricingId: cost.pricingId,
      pricingSource: pricing?.source || null,
      pricingReference: pricing?.reference || null,
      pricingEffectiveFrom: pricing ? pricing.effectiveFrom.toISOString() : null,
      unitCost: pricing ? microsToDecimal(pricing.unitCostMicros) : null,
      computedAt: cost.computedAt.toISOString(),
      label: LABEL,
      reason: cost.status === "UNAVAILABLE" ? "No approved pricing was effective when the provider completed this send." : null,
      includedAllowanceNote: pricing?.includedMonthly ? `The plan includes ${pricing.includedMonthly} emails per month; the allowance is not subtracted per campaign, so this is an upper-bound estimate.` : null,
      billed: null,
      billedStatus: "UNAVAILABLE",
      billedReason: "The provider exposes no billing or spend API; actual billed spend is not available.",
    };
  }

  // Report view of a dispatch's spend (brand-scoped by the caller).
  async function dispatchSpend(dispatch) {
    const unavailable = (reason) => ({ status: "UNAVAILABLE", amount: null, amountMicros: null, currency: null, basis: "ACCEPTED_RECIPIENTS", basisCount: null, pricingId: null, pricingSource: null, pricingReference: null, pricingEffectiveFrom: null, unitCost: null, computedAt: null, label: LABEL, reason, includedAllowanceNote: null, billed: null, billedStatus: "UNAVAILABLE", billedReason: "The provider exposes no billing or spend API; actual billed spend is not available." });
    try {
      if (!(await ready())) return unavailable("Cost estimates are not available until the final gap-closure migration is applied.");
      const cost = await client.marketingDispatchCost.findUnique({ where: { dispatchId: dispatch.id } });
      if (!cost || cost.organizationId !== dispatch.organizationId) return unavailable("The estimate is computed when the provider completes the send.");
      const pricing = cost.pricingId ? await client.mailProviderPricing.findUnique({ where: { id: cost.pricingId } }) : null;
      return serializeCost(cost, pricing);
    } catch {
      return unavailable("The estimate could not be read.");
    }
  }

  // Brand overview: estimated spend of dispatches computed in the window.
  async function brandSpendSummary(organizationId, since) {
    try {
      if (!(await ready())) return { available: false, label: LABEL };
      const rows = await client.marketingDispatchCost.findMany({ where: { organizationId, computedAt: { gt: since } }, select: { status: true, currency: true, estimatedCostMicros: true, basisCount: true } });
      const byCurrency = new Map();
      let unavailable = 0;
      for (const row of rows) {
        if (row.status !== "ESTIMATED") { unavailable += 1; continue; }
        const entry = byCurrency.get(row.currency) || { currency: row.currency, micros: 0n, dispatches: 0, recipients: 0 };
        entry.micros += BigInt(row.estimatedCostMicros);
        entry.dispatches += 1;
        entry.recipients += row.basisCount;
        byCurrency.set(row.currency, entry);
      }
      return {
        available: true,
        label: LABEL,
        estimated: [...byCurrency.values()].map((entry) => ({ currency: entry.currency, amount: microsToDecimal(entry.micros), dispatches: entry.dispatches, acceptedRecipients: entry.recipients })),
        unavailableDispatches: unavailable,
        billed: null,
        billedStatus: "UNAVAILABLE",
        window: { from: since.toISOString(), to: clock().toISOString(), basis: "dispatch estimates computed in the window" },
      };
    } catch {
      return { available: false, label: LABEL };
    }
  }

  return { list, create, setEffectiveTo, remove, effectiveAt, recordDispatchCost, reEstimate, dispatchSpend, brandSpendSummary, LABEL };
}

module.exports = { createPricingService, decimalToMicros, microsToDecimal, PRICING_LABEL: LABEL };
