const { Prisma } = require("../../../../generated/admin-client");
const { decimal, serializeMetrics } = require("./creative-metrics.service");

const COMPONENTS = Object.freeze([
  { name: "ctr", weight: "creativeCtrWeight", target: "creativeCtrTarget", direction: "higher" },
  { name: "cpc", weight: "creativeCpcWeight", target: "creativeCpcTarget", direction: "lower", monetary: true },
  { name: "conversionRate", weight: "creativeConversionRateWeight", target: "creativeConversionRateTarget", direction: "higher" },
  { name: "cpa", weight: "creativeCpaWeight", target: "creativeCpaTarget", direction: "lower", monetary: true },
  { name: "roas", weight: "creativeRoasWeight", target: "creativeRoasTarget", direction: "higher", monetary: true },
]);

function median(values) {
  const sorted = values.filter((value) => value !== null && value !== undefined).map(decimal).sort((a, b) => a.comparedTo(b));
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1].plus(sorted[middle]).div(2);
}

function grain(asset) {
  return asset.metadata?.scoredUnit || asset.metadata?.providerGrain || "UNSPECIFIED";
}

function buildPeerGroup(target, candidates) {
  const compatible = candidates.filter((candidate) => candidate.asset.id !== target.asset.id
    && candidate.asset.platform === target.asset.platform
    && candidate.asset.type === target.asset.type
    && grain(candidate.asset) === grain(target.asset));
  const campaign = compatible.filter((candidate) => candidate.asset.campaignExternalId === target.asset.campaignExternalId);
  if (campaign.length) return { peers: campaign, basis: "SAME_CAMPAIGN_TYPE_GRAIN" };
  const account = compatible.filter((candidate) => candidate.asset.connectionId === target.asset.connectionId || candidate.asset.accountExternalId === target.asset.accountExternalId);
  if (account.length) return { peers: account, basis: "SAME_ACCOUNT_TYPE_GRAIN" };
  if (compatible.length) return { peers: compatible, basis: "SAME_PLATFORM_TYPE_GRAIN" };
  return { peers: [], basis: "CONFIGURED_TARGET" };
}

// Transparent bounded normalization: relative performance is capped to [0,2]
// and mapped linearly to [0,100]. Matching the target scores 50, double-or-
// better scores 100, and zero relative performance scores 0.
function normalizeComponent(metric, target, direction) {
  if (metric === null || metric === undefined || target === null || target === undefined) return null;
  const actual = decimal(metric);
  const benchmark = decimal(target);
  if (benchmark.lte(0) || actual.lt(0)) return null;
  let ratio;
  if (direction === "lower") {
    if (actual.isZero()) ratio = new Prisma.Decimal(2);
    else ratio = benchmark.div(actual);
  } else {
    ratio = actual.div(benchmark);
  }
  const capped = Prisma.Decimal.max(0, Prisma.Decimal.min(2, ratio));
  return { score: capped.mul(50), ratio, cappedRatio: capped, method: `${direction}_relative_ratio_linear_cap_2` };
}

function targetFor(component, target, peerGroup, settings) {
  const compatiblePeers = component.monetary
    ? peerGroup.peers.filter((peer) => peer.metrics.currencyCode && peer.metrics.currencyCode === target.metrics.currencyCode)
    : peerGroup.peers;
  const peerMedian = median(compatiblePeers.map((peer) => peer.metrics[component.name]));
  if (peerMedian?.gt(0)) return { value: peerMedian, source: "PEER_MEDIAN", peerCount: compatiblePeers.length };
  const configured = decimal(settings[component.target]);
  return configured?.gt(0)
    ? { value: configured, source: "CONFIGURED_TARGET", peerCount: compatiblePeers.length }
    : { value: null, source: "UNAVAILABLE", peerCount: compatiblePeers.length };
}

function trendComponent(current, previous) {
  if (!previous || current.activeDays < 2 || previous.activeDays < 2) return null;
  const definitions = [
    ["ctr", "higher"], ["cpc", "lower"], ["conversionRate", "higher"], ["cpa", "lower"], ["roas", "higher"],
  ];
  const changes = [];
  for (const [name, direction] of definitions) {
    const now = current[name]; const before = previous[name];
    if (now === null || before === null || decimal(before).isZero()) continue;
    let change = decimal(now).minus(before).div(before);
    if (direction === "lower") change = change.negated();
    changes.push({ metric: name, change: change.toDecimalPlaces(6), favorableDirection: direction });
  }
  if (!changes.length) return null;
  const average = changes.reduce((sum, item) => sum.plus(item.change), new Prisma.Decimal(0)).div(changes.length);
  const capped = Prisma.Decimal.max(-1, Prisma.Decimal.min(1, average));
  return { score: new Prisma.Decimal(50).plus(capped.mul(50)), changes, activeDays: { current: current.activeDays, comparison: previous.activeDays }, method: "mean_directional_change_linear_cap_1" };
}

function metadataModifier(asset, sufficiency, settings) {
  const reasons = [];
  if (sufficiency === "INSUFFICIENT") return { value: new Prisma.Decimal(0), reasons: ["INSUFFICIENT_PERFORMANCE_EVIDENCE"] };
  if (asset.type && asset.type !== "UNKNOWN") reasons.push({ code: "KNOWN_FORMAT", points: 0.5 });
  if (asset.ctaType) reasons.push({ code: "CTA_AVAILABLE", points: 1 });
  if (asset.headline && asset.bodyText) reasons.push({ code: "COPY_COMPLETE", points: 0.5 });
  if (asset.type === "VIDEO" && asset.durationSeconds >= 6 && asset.durationSeconds <= 30) reasons.push({ code: "VIDEO_DURATION_6_30_SECONDS", points: 1 });
  if (asset.hasHumanPresence === true) reasons.push({ code: "PROVIDER_CONFIRMED_HUMAN_PRESENCE", points: 1 });
  const productCap = Math.min(5, Number(settings.creativeMetadataModifierMaximum));
  const total = reasons.reduce((sum, reason) => sum + reason.points, 0);
  return { value: new Prisma.Decimal(Math.max(-productCap, Math.min(productCap, total))), reasons, cap: productCap };
}

function computeScore({ asset, metrics, comparisonMetrics, candidates, sufficiency, settings }) {
  const target = { asset, metrics };
  const peerGroup = buildPeerGroup(target, candidates);
  const details = {};
  let weighted = new Prisma.Decimal(0);
  let availableWeight = new Prisma.Decimal(0);
  for (const component of COMPONENTS) {
    const benchmark = targetFor(component, target, peerGroup, settings);
    const normalized = normalizeComponent(metrics[component.name], benchmark.value, component.direction);
    if (!normalized || Number(settings[component.weight]) <= 0) {
      details[component.name] = { excluded: true, reason: normalized ? "ZERO_WEIGHT" : "MISSING_METRIC_OR_TARGET", weight: settings[component.weight], benchmarkSource: benchmark.source };
      continue;
    }
    const weight = decimal(settings[component.weight]);
    weighted = weighted.plus(normalized.score.mul(weight));
    availableWeight = availableWeight.plus(weight);
    details[component.name] = {
      excluded: false,
      rawValue: metrics[component.name].toString(),
      normalizedScore: normalized.score.toDecimalPlaces(4).toString(),
      ratio: normalized.ratio.toDecimalPlaces(6).toString(),
      cappedRatio: normalized.cappedRatio.toString(),
      normalizationMethod: normalized.method,
      target: benchmark.value.toString(),
      targetSource: benchmark.source,
      peerCount: benchmark.peerCount,
      originalWeight: settings[component.weight],
    };
  }
  const trend = trendComponent(metrics, comparisonMetrics);
  if (trend && settings.creativeTrendWeight > 0) {
    const weight = decimal(settings.creativeTrendWeight);
    weighted = weighted.plus(trend.score.mul(weight));
    availableWeight = availableWeight.plus(weight);
    details.trend = { excluded: false, normalizedScore: trend.score.toDecimalPlaces(4).toString(), originalWeight: settings.creativeTrendWeight, method: trend.method, changes: trend.changes.map((item) => ({ ...item, change: item.change.toString() })), activeDays: trend.activeDays };
  } else {
    details.trend = { excluded: true, reason: "MISSING_COMPARISON_DATA", originalWeight: settings.creativeTrendWeight };
  }
  const base = availableWeight.gt(0) ? weighted.div(availableWeight) : new Prisma.Decimal(0);
  const modifier = metadataModifier(asset, sufficiency, settings);
  const finalScore = Prisma.Decimal.max(0, Prisma.Decimal.min(100, base.plus(modifier.value))).toDecimalPlaces(2);
  return {
    score: finalScore,
    components: details,
    peerBasis: peerGroup.basis,
    peerCount: peerGroup.peers.length,
    availableWeight: availableWeight.toString(),
    weightsRenormalized: availableWeight.gt(0) && !availableWeight.eq(1),
    metadataModifier: { ...modifier, value: modifier.value.toString() },
    evidenceStrength: Object.values(details).filter((item) => !item.excluded).length <= 1 ? "LIMITED_COMPONENT_EVIDENCE" : sufficiency,
    rawMetrics: serializeMetrics(metrics),
  };
}

module.exports = { COMPONENTS, median, buildPeerGroup, normalizeComponent, trendComponent, metadataModifier, computeScore };
