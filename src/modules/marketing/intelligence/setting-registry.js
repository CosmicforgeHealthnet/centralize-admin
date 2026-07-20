const SCOPES = Object.freeze({
  ALL: ["GLOBAL", "PLATFORM", "CONNECTION"],
  GLOBAL_PLATFORM: ["GLOBAL", "PLATFORM"],
  GLOBAL_CONNECTION: ["GLOBAL", "CONNECTION"],
  GLOBAL: ["GLOBAL"],
});

const SETTING_REGISTRY = Object.freeze({
  targetCpa: { type: "DECIMAL", default: null, min: 0, scopes: SCOPES.ALL, currencyAware: true, nullable: true },
  underperformThresholdPct: { type: "DECIMAL", default: "0.30", min: 0, max: 1, scopes: SCOPES.GLOBAL_PLATFORM },
  scaleThresholdPct: { type: "DECIMAL", default: "0.20", min: 0, max: 1, scopes: SCOPES.GLOBAL_PLATFORM },
  minimumSpend: { type: "DECIMAL", default: null, min: 0, scopes: SCOPES.ALL, currencyAware: true, nullable: true },
  minimumClicks: { type: "INTEGER", default: 30, min: 0, scopes: SCOPES.GLOBAL_PLATFORM },
  minimumSignups: { type: "INTEGER", default: 3, min: 0, scopes: SCOPES.GLOBAL_PLATFORM },
  minimumPayments: { type: "INTEGER", default: 3, min: 0, scopes: SCOPES.GLOBAL_PLATFORM },
  recommendationLookbackDays: { type: "INTEGER", default: 14, min: 1, max: 90, scopes: SCOPES.GLOBAL_PLATFORM },
  comparisonLookbackDays: { type: "INTEGER", default: 14, min: 1, max: 90, scopes: SCOPES.GLOBAL_PLATFORM },
  attributionWindowDays: { type: "INTEGER", default: 30, min: 1, max: 90, scopes: SCOPES.GLOBAL },
  creativeFatigueThresholdPct: { type: "DECIMAL", default: "0.25", min: 0, max: 1, scopes: SCOPES.GLOBAL_PLATFORM },
  creativeMinimumImpressions: { type: "INTEGER", default: 1000, min: 0, scopes: SCOPES.GLOBAL_PLATFORM },
  maximumRecommendedScalePct: { type: "DECIMAL", default: "0.20", min: 0, max: 1, scopes: SCOPES.GLOBAL_PLATFORM },
  alertCooldownMinutes: { type: "INTEGER", default: 1440, min: 5, max: 10080, scopes: SCOPES.GLOBAL_PLATFORM },
  defaultMarketingAssigneeAdminUserId: { type: "STRING", format: "UUID", default: null, scopes: SCOPES.GLOBAL_CONNECTION, adminAssignee: true, nullable: true },
  recommendationEvaluationEnabled: { type: "BOOLEAN", default: false, scopes: SCOPES.ALL },
  alertEvaluationEnabled: { type: "BOOLEAN", default: false, scopes: SCOPES.ALL },
  creativeSyncEnabled: { type: "BOOLEAN", default: false, scopes: SCOPES.ALL },
  llmCommentaryEnabled: { type: "BOOLEAN", default: false, scopes: SCOPES.GLOBAL, reserved: true },
});

const SETTING_KEYS = Object.freeze(Object.keys(SETTING_REGISTRY));

module.exports = { SCOPES, SETTING_REGISTRY, SETTING_KEYS };
