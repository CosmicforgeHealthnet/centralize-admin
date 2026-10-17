const crypto = require("crypto");

const DEFAULT_SEVERITY = Object.freeze({
  CPA_TARGET_BREACH: "WARNING",
  SPEND_WITHOUT_CONVERSION: "CRITICAL",
  CONVERSION_RATE_DROP: "WARNING",
  CREATIVE_FATIGUE: "WARNING",
  SYNC_STALE: "WARNING",
  CAMPAIGN_PERFORMANCE_DROP: "WARNING",
  HIGH_PERFORMING_CAMPAIGN: "INFO",
  TOKEN_REFRESH_FAILED: "CRITICAL",
  CONNECTION_DEGRADED: "WARNING",
  PLATFORM_PERMISSION_ERROR: "CRITICAL",
});

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const numeric = (value) => value === null || value === undefined ? null : Number(value);
const changedBy = (current, previous, direction) => {
  const now = numeric(current); const before = numeric(previous);
  if (now === null || before === null || before <= 0) return null;
  return direction === "up" ? (now - before) / before : (before - now) / before;
};

function conditionKey(candidate) {
  return hash([candidate.type, candidate.platform || "", candidate.connectionId || "", candidate.campaignExternalId || "", candidate.creativeAssetId || "", candidate.currencyCode || "", candidate.conditionScope || "default"].join("|"));
}

function candidate(type, source, message, evidence, overrides = {}) {
  const item = { type, severity: DEFAULT_SEVERITY[type], platform: source.platform || null, connectionId: source.connectionId || null, campaignExternalId: source.campaignExternalId || null, creativeAssetId: overrides.creativeAssetId || null, currencyCode: source.currencyCode || null, conditionScope: overrides.conditionScope || "default", message, evidence: { ruleVersion: "alert-v1", ...evidence } };
  item.conditionKey = conditionKey(item);
  return item;
}

function evaluateCampaignAlerts(input, settings) {
  const alerts = [];
  const sufficient = input.dataSufficiency !== "INSUFFICIENT" && input.windowComplete && input.trendConsistent;
  const targetCpa = numeric(settings.targetCpa);
  const cpa = numeric(input.cpa);
  const cpaThresholdPct = settings.underperformThresholdPct ?? settings.alertCpaThresholdPct;
  if (sufficient && input.currencyCompatible && Number(input.internalConversions || 0) >= (settings.minimumConversions ?? 3) && targetCpa > 0 && cpa > targetCpa * (1 + cpaThresholdPct)) {
    alerts.push(candidate("CPA_TARGET_BREACH", input, "Campaign CPA is materially above its configured target.", { observedCpa: cpa, targetCpa, thresholdPct: cpaThresholdPct, dataSufficiency: input.dataSufficiency, conditionDays: input.conditionDays }));
  }
  if (input.windowComplete && input.trendConsistent && (input.persistenceEvaluations || 1) >= settings.alertPersistenceEvaluations && numeric(input.spend) >= settings.alertSpendWithoutConversionThreshold && Number(input.internalConversions) === 0 && Number(input.clicks) >= 30) {
    alerts.push(candidate("SPEND_WITHOUT_CONVERSION", input, "Campaign spend reached the configured threshold without an eligible internal conversion.", { spend: numeric(input.spend), threshold: settings.alertSpendWithoutConversionThreshold, clicks: Number(input.clicks), internalConversions: 0, persistenceEvaluations: input.persistenceEvaluations }));
  }
  const conversionDrop = changedBy(input.conversionRate, input.comparisonConversionRate, "down");
  if (sufficient && conversionDrop !== null && conversionDrop >= settings.alertConversionRateDropPct && Number(input.comparisonClicks || 0) >= 30 && Number(input.comparisonConversions || 0) >= 3) {
    alerts.push(candidate("CONVERSION_RATE_DROP", input, "Campaign conversion rate declined materially across complete comparison windows.", { currentConversionRate: numeric(input.conversionRate), comparisonConversionRate: numeric(input.comparisonConversionRate), declinePct: conversionDrop, conditionDays: input.conditionDays }));
  }
  for (const creativeAssetId of input.fatiguedCreativeAssetIds || []) {
    alerts.push(candidate("CREATIVE_FATIGUE", input, "A creative asset has a persisted FATIGUED score.", { fatigueStatus: "FATIGUED" }, { creativeAssetId, conditionScope: "creative-score-fatigued" }));
  }
  const signals = {
    cpaIncrease: changedBy(input.cpa, input.comparisonCpa, "up"),
    roasDecrease: changedBy(input.roas, input.comparisonRoas, "down"),
    conversionRateDecrease: changedBy(input.conversionRate, input.comparisonConversionRate, "down"),
    ctrDecrease: changedBy(input.ctr, input.comparisonCtr, "down"),
  };
  const materialSignals = Object.entries(signals).filter(([, value]) => value !== null && value >= settings.alertCampaignPerformanceDropPct);
  if (sufficient && input.currencyCompatible && Number(input.clicks) >= 30 && materialSignals.length >= 2) {
    alerts.push(candidate("CAMPAIGN_PERFORMANCE_DROP", input, "Multiple campaign performance measures deteriorated materially across complete windows.", { signals: Object.fromEntries(materialSignals), dataSufficiency: input.dataSufficiency }));
  }
  if (input.dataSufficiency === "STRONG" && input.trendConsistent && input.currencyCompatible && targetCpa > 0 && cpa !== null && cpa <= targetCpa * (1 - settings.alertHighPerformanceThresholdPct) && Number(input.internalConversions) >= 3) {
    alerts.push(candidate("HIGH_PERFORMING_CAMPAIGN", input, "Campaign performance materially exceeds its configured CPA target with stable evidence.", { observedCpa: cpa, targetCpa, improvementPct: (targetCpa - cpa) / targetCpa, internalConversions: Number(input.internalConversions) }));
  }
  return alerts;
}

function classifyConnectionError(connection) {
  const text = String(connection.sanitizedValidationError || connection.lastSyncError || "").toLowerCase();
  if (/permission|forbidden|insufficient.scope|approval/.test(text)) return "permission";
  if (/refresh|reauthor|invalid.token|expired.token|authentication/.test(text) || connection.requiresReauthorization) return "refresh";
  return "transient";
}

function evaluateConnectionAlerts(connection, settings, now = new Date()) {
  if (connection.status === "DISABLED") return [];
  const source = { platform: connection.platform, connectionId: connection.id };
  const alerts = [];
  const lastSuccess = connection.lastSuccessfulFetchAt || connection.lastSyncedAt;
  const staleHours = lastSuccess ? (now - new Date(lastSuccess)) / 3600000 : Infinity;
  if (staleHours > settings.alertSyncStaleHours) alerts.push(candidate("SYNC_STALE", source, "An active marketing connection has not completed a successful synchronization within the configured interval.", { lastSuccessfulSyncAt: lastSuccess || null, staleHours: Number.isFinite(staleHours) ? staleHours : null, thresholdHours: settings.alertSyncStaleHours, expectedSyncScopes: ["CAMPAIGN", "CREATIVE"] }));
  if (connection.status !== "ERROR" && !connection.requiresReauthorization) return alerts;
  const classification = classifyConnectionError(connection);
  if (classification === "permission") alerts.push(candidate("PLATFORM_PERMISSION_ERROR", source, "The provider denied a required reporting capability.", { errorClassification: "PERMISSION_OR_APPROVAL", requiresReauthorization: Boolean(connection.requiresReauthorization) }));
  else if (classification === "refresh") alerts.push(candidate("TOKEN_REFRESH_FAILED", source, "The connection cannot continue because credential refresh or reauthorization failed.", { errorClassification: "AUTHENTICATION_REFRESH", requiresReauthorization: Boolean(connection.requiresReauthorization) }));
  else {
    const failures = Number(connection.connectionMetadata?.consecutiveFailures || connection.connectionMetadata?.failureCount || 1);
    if (failures >= settings.alertDegradedConnectionFailureCount) alerts.push(candidate("CONNECTION_DEGRADED", source, "The provider connection reached the configured consecutive transient-failure threshold.", { errorClassification: "TRANSIENT_PROVIDER_FAILURE", consecutiveFailures: failures, threshold: settings.alertDegradedConnectionFailureCount }));
  }
  return alerts;
}

module.exports = { DEFAULT_SEVERITY, conditionKey, evaluateCampaignAlerts, evaluateConnectionAlerts, classifyConnectionError };
