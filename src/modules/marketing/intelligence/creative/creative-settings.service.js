const { prisma } = require("../../../../shared/config/database");
const { stableHash } = require("./creative.connector.interface");

const DEFAULTS = Object.freeze({
  creativeScoringEnabled: true,
  creativeAnalysisWindowDays: 28,
  creativeComparisonWindowDays: 28,
  creativeMinimumImpressionsInsufficient: 500,
  creativeMinimumClicksInsufficient: 10,
  creativeMinimumImpressionsLimited: 500,
  creativeMinimumClicksLimited: 10,
  creativeMinimumImpressionsSufficient: 1000,
  creativeMinimumClicksSufficient: 30,
  creativeMinimumSpendSufficient: 25,
  creativeMinimumConversionsStrong: 5,
  creativeMetadataModifierMaximum: 5,
  creativeCtrWeight: 0.20,
  creativeCpcWeight: 0.15,
  creativeConversionRateWeight: 0.20,
  creativeCpaWeight: 0.25,
  creativeRoasWeight: 0.15,
  creativeTrendWeight: 0.05,
  creativeFatigueRecentWindowDays: 7,
  creativeFatigueComparisonWindowDays: 7,
  creativeMinimumImpressions: 1000,
  creativeFatigueMinimumClicks: 30,
  creativeFatigueMinimumSpend: 25,
  creativeFatigueThresholdPct: 0.25,
  creativeFatigueCpcIncreasePct: 0.20,
  creativeFatigueCpaIncreasePct: 0.20,
  creativeFatigueConversionRateDeclinePct: 0.20,
  creativeFatigueConsecutiveEvaluations: 2,
  creativeRecoveryConsecutiveEvaluations: 2,
  creativePrimaryCpaGoal: "PAYMENT",
  creativeSpendMandatory: false,
  creativeCtrTarget: 0.02,
  creativeCpcTarget: 2,
  creativeConversionRateTarget: 0.05,
  creativeCpaTarget: 25,
  creativeRoasTarget: 2,
});

const WEIGHT_KEYS = ["creativeCtrWeight", "creativeCpcWeight", "creativeConversionRateWeight", "creativeCpaWeight", "creativeRoasWeight", "creativeTrendWeight"];
const PERCENT_KEYS = ["creativeFatigueThresholdPct", "creativeFatigueCpcIncreasePct", "creativeFatigueCpaIncreasePct", "creativeFatigueConversionRateDeclinePct"];
const POSITIVE_INTEGER_KEYS = Object.keys(DEFAULTS).filter((key) => /Days|MinimumImpressions|MinimumClicks|MinimumConversions|ConsecutiveEvaluations/.test(key));
const NONNEGATIVE_KEYS = Object.keys(DEFAULTS).filter((key) => /Weight|MinimumSpend|ModifierMaximum|Target/.test(key));

function valueOf(row) {
  const raw = row?.valueJson;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "value")) return raw.value;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "days")) return raw.days;
  return raw;
}

function validateValue(key, value) {
  if (key === "creativeScoringEnabled" || key === "creativeSpendMandatory") {
    if (typeof value !== "boolean") throw new Error("must be boolean");
    return value;
  }
  if (key === "creativePrimaryCpaGoal") {
    const normalized = String(value).toUpperCase();
    if (!["SIGNUP", "PAYMENT"].includes(normalized)) throw new Error("must be SIGNUP or PAYMENT");
    return normalized;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("must be numeric");
  if (POSITIVE_INTEGER_KEYS.includes(key)) {
    const maximum = /Days/.test(key) ? 365 : /ConsecutiveEvaluations/.test(key) ? 100 : 1000000000;
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > maximum) throw new Error("must be a bounded positive integer");
  }
  if (NONNEGATIVE_KEYS.includes(key) && numeric < 0) throw new Error("must be non-negative");
  if (PERCENT_KEYS.includes(key) && (numeric < 0 || numeric > 1)) throw new Error("must be a ratio from 0 to 1");
  if (/Target$/.test(key) && numeric <= 0) throw new Error("target must be greater than zero");
  if (["creativeCtrTarget", "creativeConversionRateTarget"].includes(key) && numeric > 1) {
    throw new Error("ratio target must be from 0 to 1");
  }
  if (key === "creativeMetadataModifierMaximum" && numeric > 5) throw new Error("cannot exceed 5");
  return numeric;
}

function validateTypedRow(row) {
  const value = valueOf(row);
  if (row.valueType === "BOOLEAN" && typeof value !== "boolean") throw new Error("typed BOOLEAN value is invalid");
  if (row.valueType === "INTEGER" && !Number.isInteger(Number(value))) throw new Error("typed INTEGER value is invalid");
  if (row.valueType === "DECIMAL" && !Number.isFinite(Number(value))) throw new Error("typed DECIMAL value is invalid");
  if (row.valueType === "STRING" && typeof value !== "string") throw new Error("typed STRING value is invalid");
  return value;
}

function scopeRank(row, context) {
  if (row.scopeType === "CONNECTION" && row.connectionId === context.connectionId) return 3;
  if (row.scopeType === "PLATFORM" && row.platform === context.platform) return 2;
  if (row.scopeType === "GLOBAL") return 1;
  return 0;
}

function createCreativeSettingsService({ prisma: db = prisma } = {}) {
  async function resolveSettings({ platform, connectionId } = {}) {
    const rows = db.marketing_intelligence_settings?.findMany
      ? await db.marketing_intelligence_settings.findMany({
        where: {
          key: { in: Object.keys(DEFAULTS) },
          OR: [
            { scopeType: "GLOBAL" },
            { scopeType: "PLATFORM", platform },
            { scopeType: "CONNECTION", connectionId },
          ],
        },
      })
      : [];
    const values = {};
    const sources = {};
    const invalidSettings = [];
    for (const key of Object.keys(DEFAULTS)) {
      const candidates = rows.filter((row) => row.key === key && scopeRank(row, { platform, connectionId }) > 0)
        .sort((left, right) => scopeRank(right, { platform, connectionId }) - scopeRank(left, { platform, connectionId }));
      let selected = false;
      for (const row of candidates) {
        try {
          values[key] = validateValue(key, validateTypedRow(row));
          sources[key] = { scopeType: row.scopeType, id: row.id, version: row.version };
          selected = true;
          break;
        } catch (error) {
          invalidSettings.push({ key, settingId: row.id, scopeType: row.scopeType, reason: error.message });
        }
      }
      if (!selected) {
        values[key] = DEFAULTS[key];
        sources[key] = { scopeType: "BOOTSTRAP_DEFAULT", version: 1 };
      }
    }
    const totalWeight = WEIGHT_KEYS.reduce((sum, key) => sum + values[key], 0);
    if (!(totalWeight > 0)) {
      invalidSettings.push({ key: "creativeWeights", reason: "available base weights must sum to a positive value" });
      for (const key of WEIGHT_KEYS) {
        values[key] = DEFAULTS[key];
        sources[key] = { scopeType: "BOOTSTRAP_DEFAULT", version: 1, fallback: "invalid_weight_set" };
      }
    }
    const orderedThresholds = [
      ["creativeMinimumImpressionsInsufficient", "creativeMinimumImpressionsLimited", "creativeMinimumImpressionsSufficient"],
      ["creativeMinimumClicksInsufficient", "creativeMinimumClicksLimited", "creativeMinimumClicksSufficient"],
    ];
    for (const keys of orderedThresholds) {
      if (!(values[keys[0]] <= values[keys[1]] && values[keys[1]] <= values[keys[2]])) {
        invalidSettings.push({ key: keys.join(","), reason: "sufficiency thresholds must be non-decreasing" });
        for (const key of keys) {
          values[key] = DEFAULTS[key];
          sources[key] = { scopeType: "BOOTSTRAP_DEFAULT", version: 1, fallback: "invalid_threshold_order" };
        }
      }
    }
    const fingerprint = stableHash(JSON.stringify({ values, sources: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, { scopeType: source.scopeType, id: source.id || null, version: source.version }])) }));
    return { values, sources, invalidSettings, fingerprint };
  }

  return { resolveSettings };
}

const defaultService = createCreativeSettingsService();
module.exports = { DEFAULTS, WEIGHT_KEYS, validateValue, validateTypedRow, createCreativeSettingsService, resolveSettings: defaultService.resolveSettings };
