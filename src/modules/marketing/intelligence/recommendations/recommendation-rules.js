const { Prisma } = require("../../../../generated/admin-client");
const { canonicalJson, stableHash } = require("../creative/creative.connector.interface");
const { calculateConfidence } = require("./recommendation-confidence");

const RULE_VERSION = "recommendation-v1";
const D = (value) => value === null || value === undefined ? null : new Prisma.Decimal(String(value));

function materialFingerprint(ruleCode, evidence) {
  return stableHash(canonicalJson({
    ruleCode,
    observed: evidence.observed,
    target: evidence.target,
    boundary: evidence.boundary,
    spend: evidence.spend,
    conversions: evidence.conversions,
    currencyCode: evidence.currencyCode,
    compatibility: evidence.compatibility,
    creative: evidence.creative,
    sourceCampaignExternalId: evidence.sourceCampaignExternalId,
    destinationCampaignExternalId: evidence.destinationCampaignExternalId,
  }));
}

function recommendationKey({ ruleCode, input, periodBucket, sourceCampaignExternalId, destinationCampaignExternalId }) {
  return stableHash(canonicalJson({
    ruleCode,
    ruleVersion: RULE_VERSION,
    platform: input.platform,
    connectionId: input.connectionId,
    targetCampaignExternalId: input.campaignExternalId,
    sourceCampaignExternalId: sourceCampaignExternalId || null,
    destinationCampaignExternalId: destinationCampaignExternalId || null,
    currencyCode: input.currencyCode || null,
    periodBucket,
  }));
}

function eligible(input, { allowLimited = false, monetary = false } = {}) {
  if (!input.connectionId || !input.accountExternalId || !input.campaignExternalId) return false;
  if (input.connectionIssue) return false;
  if (!input.windowComplete || input.dataCompleteness === null || input.dataCompleteness === undefined) return false;
  if (input.dataSufficiency === "INSUFFICIENT") return false;
  if (!allowLimited && input.dataSufficiency === "LIMITED") return false;
  if (monetary && (!input.currencyCode || input.currencyCompatible === false)) return false;
  return true;
}

function reasoning(input, label, observed, target, distance, action) {
  const campaign = input.campaignName || input.campaignExternalId;
  const currency = input.currencyCode ? `${input.currencyCode} ` : "";
  return `Campaign "${campaign}" ${label} ${currency}${observed} against target ${currency}${target} during ${input.analysisWindowStart}/${input.analysisWindowEnd}; the material distance was ${(Number(distance) * 100).toFixed(1)}% across ${input.activeDataDays} reporting days. ${action}`.slice(0, 2000);
}

function result({ type, ruleCode, input, periodBucket, settings, targetDistance, evidence, reasoningText, suggestedAction, persistenceEvaluations = 1, sourceCampaignExternalId, destinationCampaignExternalId }) {
  const confidence = calculateConfidence({ input, settings, targetDistance, persistenceEvaluations });
  const fullEvidence = {
    ...evidence,
    confidenceComponents: confidence.components,
    dataSufficiency: input.dataSufficiency,
    dataCompleteness: input.dataCompleteness,
    analysisWindow: { from: input.analysisWindowStart, to: input.analysisWindowEnd },
    comparisonWindow: { from: input.comparisonWindowStart, to: input.comparisonWindowEnd },
    attributionDefinition: input.attributionDefinition,
  };
  return {
    type,
    ruleCode,
    ruleVersion: RULE_VERSION,
    targetCampaignExternalId: input.campaignExternalId,
    sourceCampaignExternalId: sourceCampaignExternalId || null,
    destinationCampaignExternalId: destinationCampaignExternalId || null,
    platform: input.platform,
    connectionId: input.connectionId,
    currencyCode: input.currencyCode,
    confidence: confidence.confidence,
    evidence: fullEvidence,
    materialEvidenceFingerprint: materialFingerprint(ruleCode, fullEvidence),
    reasoning: reasoningText,
    suggestedAction,
    dedupeKey: recommendationKey({ ruleCode, input, periodBucket, sourceCampaignExternalId, destinationCampaignExternalId }),
  };
}

function evaluateCampaign(input, settings, periodBucket) {
  const output = [];
  if (!settings.recommendationEvaluationEnabled) return output;
  const conversions = Number(input.internalConversions || 0);
  const stable = input.conditionDays >= settings.recommendationMinimumConsistencyDays && input.trendConsistent !== false;
  const hasTargetCpa = settings.targetCpa !== null && settings.targetCpa !== undefined && Number(settings.targetCpa) > 0;
  const hasMinimumSpend = settings.minimumSpend !== null && settings.minimumSpend !== undefined;

  if (eligible(input, { monetary: true }) && hasMinimumSpend && input.spend?.gte(settings.minimumSpend) && Number(input.clicks || 0) >= settings.minimumClicks) {
    if (input.cpa !== null && hasTargetCpa && conversions >= settings.minimumConversions && stable) {
      const target = D(settings.targetCpa);
      const boundary = target.mul(D(1).plus(settings.underperformThresholdPct));
      if (input.cpa.gt(boundary)) {
        const distance = input.cpa.minus(boundary).div(boundary);
        output.push(result({
          type: "PAUSE", ruleCode: "PAUSE_CPA_TARGET_BREACH", input, periodBucket, settings, targetDistance: distance,
          evidence: { observed: input.cpa.toString(), target: target.toString(), boundary: boundary.toString(), spend: input.spend.toString(), clicks: String(input.clicks), conversions: String(conversions), currencyCode: input.currencyCode, persistenceCount: input.persistenceEvaluations || 1, compatibility: true },
          reasoningText: reasoning(input, "recorded CPA", input.cpa.toString(), target.toString(), distance, "Manual review and possible pause are recommended."),
          suggestedAction: { action: "REVIEW_AND_PAUSE", pauseSuggested: true, requiresManualApproval: true },
        }));
      }
    }
    if (input.spend.gte(settings.spendWithoutConversionThreshold) && conversions === 0 && stable && (input.persistenceEvaluations || 1) >= settings.spendWithoutConversionPersistenceEvaluations) {
      const distance = input.spend.minus(settings.spendWithoutConversionThreshold).div(Math.max(1, settings.spendWithoutConversionThreshold));
      output.push(result({
        type: "PAUSE", ruleCode: "PAUSE_SPEND_WITHOUT_CONVERSION", input, periodBucket, settings, targetDistance: distance, persistenceEvaluations: input.persistenceEvaluations,
        evidence: { observed: "0", target: "internal conversions > 0", boundary: String(settings.spendWithoutConversionThreshold), spend: input.spend.toString(), clicks: String(input.clicks), conversions: "0", currencyCode: input.currencyCode, persistenceCount: input.persistenceEvaluations, compatibility: true },
        reasoningText: reasoning(input, "recorded internal conversions", "0", ">0", distance, "Manual review and possible pause are recommended."),
        suggestedAction: { action: "REVIEW_AND_PAUSE", pauseSuggested: true, requiresManualApproval: true },
      }));
    }
  }

  if (eligible(input, { monetary: true }) && input.dataSufficiency === "STRONG" && conversions >= settings.minimumConversions && stable && !input.performanceDeteriorating && !input.connectionIssue) {
    let scale;
    if (input.cpa !== null && hasTargetCpa) {
      const boundary = D(settings.targetCpa).mul(D(1).minus(settings.scaleThresholdPct));
      if (input.cpa.lt(boundary)) scale = { ruleCode: "SCALE_CPA_OUTPERFORMANCE", observed: input.cpa, target: D(settings.targetCpa), boundary, distance: boundary.minus(input.cpa).div(boundary) };
    }
    if (!scale && input.roas !== null && settings.targetRoas > 0) {
      const boundary = D(settings.targetRoas).mul(D(1).plus(settings.scaleThresholdPct));
      if (input.roas.gt(boundary)) scale = { ruleCode: "SCALE_ROAS_OUTPERFORMANCE", observed: input.roas, target: D(settings.targetRoas), boundary, distance: input.roas.minus(boundary).div(boundary) };
    }
    if (scale) {
      const maximum = Math.round(settings.maximumRecommendedScalePct * 100);
      const suggested = Math.min(maximum, Math.max(5, Math.round(Number(scale.distance.mul(100).toDecimalPlaces(0)))));
      output.push(result({
        type: "SCALE", ruleCode: scale.ruleCode, input, periodBucket, settings, targetDistance: scale.distance,
        evidence: { observed: scale.observed.toString(), target: scale.target.toString(), boundary: scale.boundary.toString(), spend: input.spend.toString(), conversions: String(conversions), currencyCode: input.currencyCode, compatibility: true, scaleCalculation: { performanceMargin: scale.distance.toString(), suggestedScalePct: suggested, maximumAllowedPct: maximum } },
        reasoningText: reasoning(input, "materially exceeded the scale threshold with metric", scale.observed.toString(), scale.target.toString(), scale.distance, "A bounded manual budget increase is recommended."),
        suggestedAction: { action: "INCREASE_BUDGET", suggestedScalePct: suggested, maximumAllowedPct: maximum, requiresManualApproval: true },
      }));
    }
  }

  const creativeReasons = [];
  if ((input.fatiguedCreativeCount || 0) >= settings.createContentFatigueCount) creativeReasons.push("CONFIRMED_CREATIVE_FATIGUE");
  if ((input.eligibleCreativeCount || 0) < settings.minimumCreativeCount) creativeReasons.push("LOW_CREATIVE_COUNT");
  if ((input.weakCreativePct || 0) > settings.weakCreativeDistributionThresholdPct) creativeReasons.push("WEAK_CREATIVE_DISTRIBUTION");
  if (input.missingFormats?.length) creativeReasons.push("CREATIVE_FORMAT_GAP");
  if (creativeReasons.length && eligible(input, { allowLimited: true })) {
    const primaryRule = creativeReasons.includes("CONFIRMED_CREATIVE_FATIGUE") ? "CREATE_CONTENT_CREATIVE_FATIGUE"
      : creativeReasons.includes("LOW_CREATIVE_COUNT") ? "CREATE_CONTENT_LOW_CREATIVE_COUNT"
        : creativeReasons.includes("WEAK_CREATIVE_DISTRIBUTION") ? "CREATE_CONTENT_WEAK_SCORE_DISTRIBUTION" : "CREATE_CONTENT_FORMAT_GAP";
    output.push(result({
      type: "CREATE_CONTENT", ruleCode: primaryRule, input, periodBucket, settings, targetDistance: Math.min(1, creativeReasons.length / 4),
      evidence: { observed: String(input.eligibleCreativeCount || 0), target: String(settings.minimumCreativeCount), boundary: String(settings.weakCreativeDistributionThresholdPct), spend: input.spend?.toString() || null, conversions: String(conversions), currencyCode: input.currencyCode, compatibility: true, creative: { creativeCount: input.creativeCount, eligibleCreativeCount: input.eligibleCreativeCount, types: input.creativeTypes, medianScore: input.medianCreativeScore, weakCreativePct: input.weakCreativePct, fatiguedCreativeCount: input.fatiguedCreativeCount, missingFormats: input.missingFormats, reasonCodes: creativeReasons } },
      reasoningText: `Campaign "${input.campaignName || input.campaignExternalId}" has deterministic creative inventory or fatigue evidence (${creativeReasons.join(", ")}). Manual content creation review is recommended.`,
      suggestedAction: { action: "CREATE_CONTENT", recommendedFormats: input.missingFormats || [], reasonCodes: creativeReasons, campaignExternalId: input.campaignExternalId, requiresManualApproval: true },
    }));
  }
  return output;
}

function evaluateReallocation(inputs, settings, periodBucket, { onSkip = () => {} } = {}) {
  const results = [];
  if (settings.targetCpa === null || settings.targetCpa === undefined || Number(settings.targetCpa) <= 0) {
    onSkip({ ruleCode: "REALLOCATE_COMPARABLE_CAMPAIGNS", reasonCodes: ["SETTING_MONETARY_VALUE_UNAVAILABLE"] });
    return results;
  }
  const sources = inputs.filter((input) => eligible(input, { monetary: true }) && ["SUFFICIENT", "STRONG"].includes(input.dataSufficiency) && input.cpa?.gt(D(settings.targetCpa).mul(D(1).plus(settings.underperformThresholdPct))));
  const destinations = inputs.filter((input) => eligible(input, { monetary: true }) && input.dataSufficiency === "STRONG" && input.cpa?.lt(D(settings.targetCpa).mul(D(1).minus(settings.scaleThresholdPct))));
  for (const source of sources) {
    const destination = destinations.find((candidate) => candidate.campaignExternalId !== source.campaignExternalId
      && candidate.platform === source.platform && candidate.connectionId === source.connectionId
      && candidate.currencyCode === source.currencyCode && candidate.campaignObjective && candidate.campaignObjective === source.campaignObjective
      && candidate.attributionDefinition === source.attributionDefinition
      && candidate.analysisWindowStart === source.analysisWindowStart && candidate.analysisWindowEnd === source.analysisWindowEnd
      && candidate.comparisonWindowStart === source.comparisonWindowStart && candidate.comparisonWindowEnd === source.comparisonWindowEnd);
    if (!destination) {
      const alternatives = destinations.filter((candidate) => candidate.campaignExternalId !== source.campaignExternalId);
      const incompatible = [...new Set(alternatives.flatMap((candidate) => [
        candidate.platform !== source.platform ? "PLATFORM_MISMATCH" : null,
        candidate.connectionId !== source.connectionId ? "CONNECTION_MISMATCH" : null,
        candidate.currencyCode !== source.currencyCode ? "CURRENCY_MISMATCH" : null,
        !candidate.campaignObjective || candidate.campaignObjective !== source.campaignObjective ? "OBJECTIVE_MISMATCH" : null,
        candidate.attributionDefinition !== source.attributionDefinition ? "ATTRIBUTION_MISMATCH" : null,
        candidate.analysisWindowStart !== source.analysisWindowStart || candidate.analysisWindowEnd !== source.analysisWindowEnd || candidate.comparisonWindowStart !== source.comparisonWindowStart || candidate.comparisonWindowEnd !== source.comparisonWindowEnd ? "WINDOW_MISMATCH" : null,
      ].filter(Boolean)))];
      onSkip({ ruleCode: "REALLOCATE_COMPARABLE_CAMPAIGNS", campaignExternalId: source.campaignExternalId, reasonCodes: incompatible.length ? incompatible : ["NO_COMPATIBLE_DESTINATION"] });
      continue;
    }
    const maximum = settings.maximumRecommendedReallocationPct;
    const suggested = Math.min(maximum, settings.defaultReallocationPct);
    const distance = source.cpa.minus(destination.cpa).div(source.cpa);
    results.push(result({
      type: "REALLOCATE_BUDGET", ruleCode: "REALLOCATE_COMPARABLE_CAMPAIGNS", input: source, periodBucket, settings, targetDistance: distance,
      sourceCampaignExternalId: source.campaignExternalId, destinationCampaignExternalId: destination.campaignExternalId,
      evidence: { observed: source.cpa.toString(), target: destination.cpa.toString(), boundary: D(settings.targetCpa).toString(), spend: source.spend.toString(), conversions: String(source.internalConversions || 0), currencyCode: source.currencyCode, sourceCampaignExternalId: source.campaignExternalId, destinationCampaignExternalId: destination.campaignExternalId, compatibility: { samePlatform: true, sameConnection: true, sameObjective: true, sameCurrency: true, sameAttribution: true, sameWindow: true }, reallocationCalculation: { suggestedReallocationPct: suggested, maximumAllowedPct: maximum } },
      reasoningText: `Comparable campaign "${source.campaignName || source.campaignExternalId}" materially underperformed "${destination.campaignName || destination.campaignExternalId}" in ${source.currencyCode}. Manual bounded budget reallocation is recommended.`,
      suggestedAction: { action: "REALLOCATE_BUDGET", suggestedReallocationPct: suggested, maximumAllowedPct: maximum, requiresManualApproval: true },
    }));
  }
  return results;
}

module.exports = { RULE_VERSION, eligible, recommendationKey, materialFingerprint, evaluateCampaign, evaluateReallocation };
