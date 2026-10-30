const { Prisma } = require("../../../../generated/admin-client");

function decimal(value) {
  return value === null || value === undefined ? null : new Prisma.Decimal(String(value));
}

function sumDecimals(values) {
  if (!values.length || values.some((value) => value === null || value === undefined)) return null;
  return values.reduce((sum, value) => sum.plus(String(value)), new Prisma.Decimal(0));
}

function sumCounts(values) {
  if (!values.length || values.some((value) => value === null || value === undefined)) return null;
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
}

function ratio(top, bottom, multiplier = 1) {
  if (top === null || top === undefined || bottom === null || bottom === undefined) return null;
  const denominator = decimal(bottom);
  if (denominator.isZero()) return null;
  return decimal(top).div(denominator).mul(multiplier);
}

function aggregateMetrics(rows, { primaryGoal = "PAYMENT" } = {}) {
  const monetaryRows = rows.filter((row) => row.spend !== null || row.revenue !== null);
  const currencies = [...new Set(monetaryRows.filter((row) => row.currencyCode).map((row) => row.currencyCode))];
  const currencyCompatible = monetaryRows.every((row) => Boolean(row.currencyCode)) && currencies.length <= 1;
  const impressions = sumCounts(rows.map((row) => row.impressions));
  const reach = sumCounts(rows.map((row) => row.reach));
  const clicks = sumCounts(rows.map((row) => row.clicks));
  const attributedSignups = sumCounts(rows.map((row) => row.attributedSignups));
  const attributedPayments = sumCounts(rows.map((row) => row.attributedPayments));
  const providerConversions = sumDecimals(rows.map((row) => row.providerConversions));
  const spend = currencyCompatible ? sumDecimals(rows.map((row) => row.spend)) : null;
  const internalRevenueRows = rows.filter((row) => row.metadata?.revenueSource === "INTERNAL_ATTRIBUTED");
  const internalRevenueCurrencies = [...new Set(internalRevenueRows.filter((row) => row.currencyCode && row.revenue !== null).map((row) => row.currencyCode))];
  const revenueCompatible = currencyCompatible && internalRevenueCurrencies.length <= 1 && (!currencies[0] || !internalRevenueCurrencies[0] || currencies[0] === internalRevenueCurrencies[0]);
  const netAttributedRevenue = revenueCompatible ? sumDecimals(internalRevenueRows.map((row) => row.revenue)) : null;
  const goalCount = primaryGoal === "SIGNUP" ? attributedSignups : attributedPayments;
  const dates = [...new Set(rows.map((row) => new Date(row.date).toISOString().slice(0, 10)))];
  return {
    currencyCode: currencyCompatible ? currencies[0] || null : null,
    currencyCompatible,
    revenueCurrencyCompatible: revenueCompatible,
    impressions,
    reach,
    clicks,
    attributedSignups,
    attributedPayments,
    providerConversions,
    spend,
    netAttributedRevenue,
    goalCount,
    activeDays: dates.length,
    ctr: ratio(clicks, impressions),
    cpc: ratio(spend, clicks),
    cpm: ratio(spend, impressions, 1000),
    conversionRate: ratio(attributedPayments, clicks),
    cpa: ratio(spend, goalCount),
    roas: revenueCompatible ? ratio(netAttributedRevenue, spend) : null,
    metricSources: {
      conversions: "INTERNAL_ATTRIBUTED_ONLY",
      providerConversions: "INFORMATIONAL_ONLY",
      revenue: "INTERNAL_ATTRIBUTED_NET_ONLY",
      spend: "PROVIDER",
    },
  };
}

function determineSufficiency(metrics, settings) {
  const impressions = metrics.impressions ?? 0n;
  const clicks = metrics.clicks ?? 0n;
  const conversions = metrics.goalCount ?? 0n;
  const spendAvailable = metrics.spend !== null;
  const spendEnough = spendAvailable
    ? metrics.spend.gte(settings.creativeMinimumSpendSufficient)
    : !settings.creativeSpendMandatory;
  const sufficient = impressions >= BigInt(settings.creativeMinimumImpressionsSufficient)
    && clicks >= BigInt(settings.creativeMinimumClicksSufficient)
    && spendEnough;
  if (sufficient && conversions >= BigInt(settings.creativeMinimumConversionsStrong)) return "STRONG";
  if (sufficient) return "SUFFICIENT";
  if (impressions < BigInt(settings.creativeMinimumImpressionsInsufficient)
    || clicks < BigInt(settings.creativeMinimumClicksInsufficient)) return "INSUFFICIENT";
  if (impressions >= BigInt(settings.creativeMinimumImpressionsLimited) && clicks >= BigInt(settings.creativeMinimumClicksLimited)) return "LIMITED";
  return "INSUFFICIENT";
}

function serializeMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => {
    if (typeof value === "bigint") return [key, value.toString()];
    if (value instanceof Prisma.Decimal) return [key, value.toString()];
    return [key, value];
  }));
}

module.exports = { decimal, ratio, aggregateMetrics, determineSufficiency, serializeMetrics };
