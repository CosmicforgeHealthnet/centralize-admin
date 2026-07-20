const { Prisma } = require("../../../../generated/admin-client");

const D = (value) => value === null || value === undefined ? null : new Prisma.Decimal(String(value));
const sumDecimal = (rows, field) => rows.reduce((sum, row) => sum.plus(String(row[field] ?? 0)), new Prisma.Decimal(0));
const sumInt = (rows, field) => rows.reduce((sum, row) => sum + BigInt(row[field] ?? 0), 0n);
const ratio = (top, bottom) => {
  if (top === null || bottom === null || D(bottom).isZero()) return null;
  return D(top).div(D(bottom));
};
const dateKey = (value) => new Date(value).toISOString().slice(0, 10);

function median(values) {
  if (!values.length) return null;
  const sorted = values.map(Number).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sufficiency({ impressions, clicks, spend, conversions, completeness }, settings) {
  if (Number(clicks) < Math.max(1, settings.minimumClicks / 2) || completeness < settings.recommendationMinimumDataCompletenessPct) return "INSUFFICIENT";
  if (Number(clicks) < settings.minimumClicks || (settings.minimumSpend !== null && settings.minimumSpend !== undefined && spend.lt(settings.minimumSpend))) return "LIMITED";
  return Number(conversions) >= settings.minimumConversions ? "STRONG" : "SUFFICIENT";
}

function campaignGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.platform, row.connectionId || "", row.accountId, row.campaignExternalId, row.currency].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function within(rows, from, to) {
  return rows.filter((row) => new Date(row.date) >= from && new Date(row.date) <= to);
}

function dailyConsistency(rows, settings) {
  const qualifying = rows.filter((row) => Number(row.clicks || 0) > 0);
  if (!qualifying.length) return { conditionDays: 0, trendConsistent: false };
  const cpas = qualifying.filter((row) => Number(row.payments || 0) > 0).map((row) => Number(row.spend || 0) / Number(row.payments));
  if (cpas.length < settings.recommendationMinimumConsistencyDays) return { conditionDays: qualifying.length, trendConsistent: false };
  const average = cpas.reduce((sum, value) => sum + value, 0) / cpas.length;
  const maxDeviation = Math.max(...cpas.map((value) => Math.abs(value - average) / Math.max(0.000001, average)));
  return { conditionDays: qualifying.length, trendConsistent: maxDeviation <= 0.75 };
}

async function creativeEvidence(db, group, settings) {
  const first = group[0];
  if (!db.marketing_creative_assets?.findMany) return { creativeCount: 0, eligibleCreativeCount: 0, averageCreativeScore: null, medianCreativeScore: null, weakCreativeCount: 0, weakCreativePct: 0, fatiguedCreativeCount: 0, fatiguedCreativeAssetIds: [], creativeTypes: [], missingFormats: [], campaignObjective: null };
  const assets = await db.marketing_creative_assets.findMany({ where: { platform: first.platform, connectionId: first.connectionId, accountExternalId: first.accountId, campaignExternalId: first.campaignExternalId } });
  const latest = [];
  for (const asset of assets) {
    const score = db.marketing_creative_score_snapshots?.findFirst
      ? await db.marketing_creative_score_snapshots.findFirst({ where: { creativeAssetId: asset.id }, orderBy: [{ generatedAt: "desc" }, { id: "desc" }] })
      : null;
    if (score) latest.push(score);
  }
  const values = latest.map((score) => Number(score.score));
  const weakCreativeCount = values.filter((score) => score < settings.weakCreativeScoreThreshold).length;
  const types = [...new Set(assets.map((asset) => asset.type).filter(Boolean))];
  const expectedFormats = ["IMAGE", "VIDEO"];
  const objectives = [...new Set(assets.map((asset) => asset.metadata?.campaignObjective || asset.metadata?.objective).filter(Boolean))];
  return {
    creativeCount: assets.length,
    eligibleCreativeCount: latest.filter((score) => score.dataSufficiency !== "INSUFFICIENT").length,
    averageCreativeScore: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    medianCreativeScore: median(values),
    weakCreativeCount,
    weakCreativePct: values.length ? weakCreativeCount / values.length : 0,
    fatiguedCreativeCount: latest.filter((score) => score.fatigueStatus === "FATIGUED").length,
    fatiguedCreativeAssetIds: latest.filter((score) => score.fatigueStatus === "FATIGUED").map((score) => score.creativeAssetId),
    creativeTypes: types,
    missingFormats: expectedFormats.filter((type) => !types.includes(type)),
    campaignObjective: objectives.length === 1 ? objectives[0] : null,
  };
}

async function buildCampaignInputs({ db, analysisStart, analysisEnd, comparisonStart, comparisonEnd, platform, connectionId, settings }) {
  const rows = await db.marketing_performance_snapshots.findMany({
    where: {
      date: { gte: comparisonStart, lte: analysisEnd },
      ...(platform && platform !== "all" ? { platform } : {}),
      ...(connectionId ? { connectionId } : {}),
    },
    orderBy: { date: "asc" },
  });
  const expectedDays = Math.floor((analysisEnd - analysisStart) / 86400000) + 1;
  const connectionIds = [...new Set(rows.map((row) => row.connectionId).filter(Boolean))];
  const connectionRows = connectionIds.length && db.marketing_ad_platform_connections?.findMany
    ? await db.marketing_ad_platform_connections.findMany({ where: { id: { in: connectionIds } }, select: { id: true, status: true } })
    : null;
  const connectionStatus = connectionRows ? new Map(connectionRows.map((row) => [row.id, row.status])) : null;
  const inputs = [];
  for (const group of campaignGroups(rows)) {
    const current = within(group, analysisStart, analysisEnd);
    if (!current.length) continue;
    const previous = within(group, comparisonStart, comparisonEnd);
    const first = current[0];
    const currencies = [...new Set(current.map((row) => row.currency).filter((currency) => currency && currency !== "UNSPECIFIED"))];
    const currencyCompatible = currencies.length === 1 && current.every((row) => row.currencyCompatibility !== false);
    const spend = sumDecimal(current, "spend");
    const netRevenue = sumDecimal(current, "netRevenue");
    const impressions = sumInt(current, "impressions");
    const clicks = sumInt(current, "clicks");
    const signups = sumInt(current, "signups");
    const payments = sumInt(current, "payments");
    const activeDataDays = new Set(current.map((row) => dateKey(row.date))).size;
    const dataCompleteness = Math.min(1, activeDataDays / expectedDays);
    const consistency = dailyConsistency(current, settings);
    const creative = await creativeEvidence(db, group, settings);
    const comparisonSpend = sumDecimal(previous, "spend");
    const comparisonPayments = sumInt(previous, "payments");
    const comparisonImpressions = sumInt(previous, "impressions");
    const comparisonClicks = sumInt(previous, "clicks");
    const comparisonNetRevenue = sumDecimal(previous, "netRevenue");
    const comparisonCpa = ratio(comparisonSpend, comparisonPayments);
    const cpa = ratio(spend, payments);
    const roas = currencyCompatible ? ratio(netRevenue, spend) : null;
    const performanceDeteriorating = cpa !== null && comparisonCpa !== null && cpa.gt(comparisonCpa.mul("1.2"));
    inputs.push({
      platform: first.platform,
      connectionId: first.connectionId,
      accountExternalId: first.accountId,
      campaignExternalId: first.campaignExternalId,
      campaignName: first.campaignName,
      campaignObjective: creative.campaignObjective,
      currencyCode: currencyCompatible ? currencies[0] : null,
      currencyCompatible,
      analysisWindowStart: dateKey(analysisStart), analysisWindowEnd: dateKey(analysisEnd),
      comparisonWindowStart: dateKey(comparisonStart), comparisonWindowEnd: dateKey(comparisonEnd),
      spend, impressions, clicks, attributedSignups: signups, attributedPayments: payments,
      internalConversions: payments, netRevenue,
      ctr: ratio(clicks, impressions), cpc: ratio(spend, clicks), conversionRate: ratio(payments, clicks), cpa, roas,
      comparisonCtr: ratio(comparisonClicks, comparisonImpressions),
      comparisonConversionRate: ratio(comparisonPayments, comparisonClicks),
      comparisonCpa,
      comparisonRoas: currencyCompatible ? ratio(comparisonNetRevenue, comparisonSpend) : null,
      comparisonClicks,
      comparisonConversions: comparisonPayments,
      activeDataDays, dataCompleteness,
      dataSufficiency: sufficiency({ impressions, clicks, spend, conversions: payments, completeness: dataCompleteness }, settings),
      conditionDays: consistency.conditionDays, trendConsistent: consistency.trendConsistent,
      persistenceEvaluations: Math.max(1, Math.floor(consistency.conditionDays / Math.max(1, settings.recommendationMinimumConsistencyDays))),
      performanceDeteriorating,
      connectionIssue: connectionStatus ? connectionStatus.get(first.connectionId) !== "ACTIVE" : false,
      attributionDefinition: "INTERNAL_LAST_TOUCH_PAYMENT",
      windowComplete: analysisEnd < new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())),
      ...creative,
    });
  }
  return inputs;
}

module.exports = { buildCampaignInputs, campaignGroups, dailyConsistency, sufficiency };
