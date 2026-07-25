const { prisma } = require("../../../../shared/config/database");
const { canonicalJson, stableHash } = require("../creative/creative.connector.interface");
const { SETTING_REGISTRY } = require("../setting-registry");

const canonicalNumber = (key) => Number(SETTING_REGISTRY[key].default);

const DEFAULTS = Object.freeze({
  recommendationEvaluationEnabled: SETTING_REGISTRY.recommendationEvaluationEnabled.default,
  recommendationLookbackDays: SETTING_REGISTRY.recommendationLookbackDays.default,
  comparisonLookbackDays: SETTING_REGISTRY.comparisonLookbackDays.default,
  recommendationPeriodBucketDays: 7,
  recommendationExpiryDays: 14,
  recommendationRecoveryEvaluations: 2,
  recommendationEvidenceStaleDays: 14,
  targetCpa: null,
  targetRoas: 2,
  underperformThresholdPct: canonicalNumber("underperformThresholdPct"),
  scaleThresholdPct: 0.20,
  minimumSpend: null,
  minimumClicks: 30,
  minimumSignups: 3,
  minimumPayments: 3,
  minimumConversions: 3,
  spendWithoutConversionThreshold: 100,
  spendWithoutConversionPersistenceEvaluations: 2,
  maximumRecommendedScalePct: canonicalNumber("maximumRecommendedScalePct"),
  maximumRecommendedReallocationPct: 25,
  defaultReallocationPct: 10,
  minimumCreativeCount: 3,
  weakCreativeScoreThreshold: 40,
  weakCreativeDistributionThresholdPct: 0.50,
  createContentFatigueCount: 1,
  recommendationMinimumDataCompletenessPct: 0.80,
  recommendationMinimumConsistencyDays: 3,
  defaultMarketingAssigneeAdminUserId: null,
  defaultRecommendationTaskDueDays: 3,
});

const RATIO_KEYS = new Set([
  "underperformThresholdPct", "scaleThresholdPct",
  "weakCreativeDistributionThresholdPct", "recommendationMinimumDataCompletenessPct",
]);
const PERCENT_POINT_KEYS = new Set(["maximumRecommendedReallocationPct", "defaultReallocationPct"]);
const INTEGER_KEYS = new Set(Object.keys(DEFAULTS).filter((key) => /Days|Count|Clicks|Signups|Payments|Conversions|PersistenceEvaluations/.test(key)));
const MONEY_KEYS = new Set(["targetCpa", "minimumSpend", "spendWithoutConversionThreshold"]);
const CURRENCY_AWARE_KEYS = new Set(["targetCpa", "minimumSpend"]);

function settingValue(row) {
  const raw = row?.valueJson;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "value")) return raw.value;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "days")) return raw.days;
  return raw;
}

function validateSetting(key, value) {
  if (key === "recommendationEvaluationEnabled") {
    if (typeof value !== "boolean") throw new Error("must be boolean");
    return value;
  }
  if (key === "defaultMarketingAssigneeAdminUserId") {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(text)) throw new Error("must be a UUID");
    return text;
  }
  if (CURRENCY_AWARE_KEYS.has(key) && (value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("must be numeric");
  if (RATIO_KEYS.has(key) && (number < 0 || number > 1)) throw new Error("must be a ratio from 0 to 1");
  if (key === "maximumRecommendedScalePct" && (number < 0 || number > 1)) throw new Error("must be a ratio from 0 to 1");
  if (PERCENT_POINT_KEYS.has(key) && (number < 0 || number > 100)) throw new Error("must be percentage points from 0 to 100");
  if (INTEGER_KEYS.has(key) && (!Number.isInteger(number) || number < 0 || number > 1000000)) throw new Error("must be a bounded non-negative integer");
  if (MONEY_KEYS.has(key) && number < 0) throw new Error("must be non-negative");
  if (key === "targetRoas" && number <= 0) throw new Error("must be greater than zero");
  return number;
}

function rank(row, { platform, connectionId, currencyCode }) {
  if (CURRENCY_AWARE_KEYS.has(row.key) && (!currencyCode || row.currencyCode !== currencyCode)) return 0;
  if (row.currencyCode && row.currencyCode !== currencyCode) return 0;
  if (row.scopeType === "CONNECTION" && row.connectionId === connectionId) return 3;
  if (row.scopeType === "PLATFORM" && row.platform === platform) return 2;
  if (row.scopeType === "GLOBAL") return 1;
  return 0;
}

function createRecommendationSettingsService({ prisma: db = prisma } = {}) {
  async function resolveSettings({ platform, connectionId, currencyCode } = {}) {
    const rows = db.marketing_intelligence_settings?.findMany
      ? await db.marketing_intelligence_settings.findMany({
        where: { key: { in: Object.keys(DEFAULTS) }, OR: [{ scopeType: "GLOBAL" }, { scopeType: "PLATFORM", platform }, { scopeType: "CONNECTION", connectionId }] },
      })
      : [];
    const values = {};
    const sources = {};
    const invalidSettings = [];
    for (const key of Object.keys(DEFAULTS)) {
      if (CURRENCY_AWARE_KEYS.has(key) && !currencyCode) {
        values[key] = null;
        sources[key] = { scopeType: "UNAVAILABLE", version: null, currencyCode: null };
        invalidSettings.push({ key, settingId: null, scopeType: "REQUEST", reasonCode: "SETTING_CURRENCY_CONTEXT_REQUIRED" });
        continue;
      }
      const candidates = rows.filter((row) => row.key === key && rank(row, { platform, connectionId, currencyCode }) > 0)
        .sort((a, b) => rank(b, { platform, connectionId, currencyCode }) - rank(a, { platform, connectionId, currencyCode }));
      let selected = false;
      for (const row of candidates) {
        try {
          values[key] = validateSetting(key, settingValue(row));
          sources[key] = { scopeType: row.scopeType, id: row.id, version: row.version, currencyCode: row.currencyCode || null };
          selected = true;
          break;
        } catch (error) {
          invalidSettings.push({ key, settingId: row.id, scopeType: row.scopeType, reason: error.message });
        }
      }
      if (!selected) {
        values[key] = DEFAULTS[key];
        sources[key] = { scopeType: "BOOTSTRAP_DEFAULT", version: DEFAULTS[key] === null ? null : 1, ...(CURRENCY_AWARE_KEYS.has(key) ? { currencyCode } : {}) };
        if (CURRENCY_AWARE_KEYS.has(key)) invalidSettings.push({ key, settingId: null, scopeType: "BOOTSTRAP", reasonCode: "SETTING_MONETARY_VALUE_UNAVAILABLE", currencyCode });
      }
    }
    if (values.defaultReallocationPct > values.maximumRecommendedReallocationPct) {
      invalidSettings.push({ key: "defaultReallocationPct", reason: "cannot exceed maximumRecommendedReallocationPct" });
      values.defaultReallocationPct = DEFAULTS.defaultReallocationPct;
      sources.defaultReallocationPct = { scopeType: "BOOTSTRAP_DEFAULT", version: 1, fallback: "invalid_bound" };
    }
    const fingerprint = stableHash(canonicalJson({ values, sources: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, { scopeType: source.scopeType, id: source.id || null, version: source.version }])) }));
    return { values, sources, invalidSettings, fingerprint };
  }
  return { resolveSettings };
}

const service = createRecommendationSettingsService();
module.exports = { DEFAULTS, validateSetting, createRecommendationSettingsService, resolveSettings: service.resolveSettings };
