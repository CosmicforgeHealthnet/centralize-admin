const DEFAULTS = Object.freeze({
  phase2Enabled: false,
  recommendation: Object.freeze({
    enabled: false,
    cron: "15 */6 * * *",
    timezone: "UTC",
  }),
  alertPerformance: Object.freeze({ enabled: false, cron: "30 2 * * *", timezone: "UTC" }),
  alertHealth: Object.freeze({ enabled: false, cron: "5 * * * *", timezone: "UTC" }),
  creativeSync: Object.freeze({ enabled: false, cron: "30 */6 * * *", timezone: "UTC" }),
  creativeScore: Object.freeze({ enabled: false, cron: "0 1 * * *", timezone: "UTC" }),
  recommendationExpiry: Object.freeze({ enabled: false, cron: "30 2 * * *", timezone: "UTC" }),
  fullEvaluation: Object.freeze({ enabled: false, cron: "0 3 * * *", timezone: "UTC" }),
});

class MarketingIntelligenceSchedulerConfigError extends Error {
  constructor(issues) {
    super(`Invalid Marketing Intelligence scheduler configuration (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "MarketingIntelligenceSchedulerConfigError";
    this.issues = issues;
  }
}

function parseBoolean(value, fallback, variable, issues) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issues.push({ variable, reasonCode: "INVALID_BOOLEAN" });
  return fallback;
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
}

function configured(env, key) {
  return key && env[key] !== undefined && env[key] !== null && env[key] !== "";
}

function readJobConfig({ env, cronLib, kind, enabledKey, cronKey, timezoneKey, legacyEnabledKey, legacyCronKey, legacyTimezoneKey, issues }) {
  const fallback = DEFAULTS[kind];
  const effectiveEnabledKey = configured(env, enabledKey) ? enabledKey : legacyEnabledKey || enabledKey;
  const effectiveCronKey = configured(env, cronKey) ? cronKey : legacyCronKey || cronKey;
  const effectiveTimezoneKey = configured(env, timezoneKey) ? timezoneKey : legacyTimezoneKey || timezoneKey;
  const enabled = parseBoolean(env[effectiveEnabledKey], fallback.enabled, effectiveEnabledKey, issues);
  const expression = String(env[effectiveCronKey] || fallback.cron).trim();
  const timezone = String(env[effectiveTimezoneKey] || fallback.timezone).trim();

  if (!cronLib.validate(expression)) issues.push({ variable: effectiveCronKey, reasonCode: "INVALID_CRON" });
  if (!validTimezone(timezone)) issues.push({ variable: effectiveTimezoneKey, reasonCode: "INVALID_TIMEZONE" });

  return { enabled, expression, timezone, configurationSource: configured(env, enabledKey) ? "SPECIFIC" : configured(env, legacyEnabledKey) ? "LEGACY" : "DEFAULT" };
}

function validateIntelligenceSchedulerEnvironment({ env = process.env, cronLib } = {}) {
  const cron = cronLib || require("node-cron");
  const issues = [];
  const phase2Enabled = parseBoolean(
    env.MARKETING_INTELLIGENCE_PHASE2_ENABLED,
    DEFAULTS.phase2Enabled,
    "MARKETING_INTELLIGENCE_PHASE2_ENABLED",
    issues,
  );
  const recommendation = readJobConfig({
    env,
    cronLib: cron,
    kind: "recommendation",
    enabledKey: "MARKETING_RECOMMENDATION_SCHEDULER_ENABLED",
    cronKey: "MARKETING_RECOMMENDATION_CRON",
    timezoneKey: "MARKETING_RECOMMENDATION_TIMEZONE",
    issues,
  });
  const alertPerformance = readJobConfig({ env, cronLib: cron, kind: "alertPerformance", enabledKey: "MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED", cronKey: "MARKETING_ALERT_PERFORMANCE_CRON", timezoneKey: "MARKETING_ALERT_PERFORMANCE_TIMEZONE", legacyEnabledKey: "MARKETING_ALERT_SCHEDULER_ENABLED", legacyCronKey: "MARKETING_ALERT_CRON", legacyTimezoneKey: "MARKETING_ALERT_TIMEZONE", issues });

  const alertHealth = readJobConfig({ env, cronLib: cron, kind: "alertHealth", enabledKey: "MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED", cronKey: "MARKETING_ALERT_HEALTH_CRON", timezoneKey: "MARKETING_ALERT_HEALTH_TIMEZONE", legacyEnabledKey: "MARKETING_ALERT_SCHEDULER_ENABLED", legacyTimezoneKey: "MARKETING_ALERT_TIMEZONE", issues });
  const creativeSync = readJobConfig({ env, cronLib: cron, kind: "creativeSync", enabledKey: "MARKETING_CREATIVE_SYNC_SCHEDULER_ENABLED", cronKey: "MARKETING_CREATIVE_SYNC_CRON", timezoneKey: "MARKETING_CREATIVE_SYNC_TIMEZONE", issues });
  const creativeScore = readJobConfig({ env, cronLib: cron, kind: "creativeScore", enabledKey: "MARKETING_CREATIVE_SCORE_SCHEDULER_ENABLED", cronKey: "MARKETING_CREATIVE_SCORE_CRON", timezoneKey: "MARKETING_CREATIVE_SCORE_TIMEZONE", issues });
  const recommendationExpiry = readJobConfig({ env, cronLib: cron, kind: "recommendationExpiry", enabledKey: "MARKETING_RECOMMENDATION_EXPIRY_SCHEDULER_ENABLED", cronKey: "MARKETING_RECOMMENDATION_EXPIRY_CRON", timezoneKey: "MARKETING_RECOMMENDATION_EXPIRY_TIMEZONE", issues });
  const fullEvaluation = readJobConfig({ env, cronLib: cron, kind: "fullEvaluation", enabledKey: "MARKETING_FULL_EVALUATION_SCHEDULER_ENABLED", cronKey: "MARKETING_FULL_EVALUATION_CRON", timezoneKey: "MARKETING_FULL_EVALUATION_TIMEZONE", issues });

  if (fullEvaluation.enabled && [recommendation.enabled, alertPerformance.enabled, alertHealth.enabled, creativeSync.enabled, creativeScore.enabled, recommendationExpiry.enabled].some(Boolean)) {
    issues.push({ variable: "MARKETING_FULL_EVALUATION_SCHEDULER_ENABLED", reasonCode: "CONFLICTING_SCHEDULERS" });
  }

  const uniqueIssues = [...new Map(issues.map((issue) => [`${issue.variable}:${issue.reasonCode}`, issue])).values()];
  if (uniqueIssues.length) throw new MarketingIntelligenceSchedulerConfigError(uniqueIssues);
  return {
    phase2: { enabled: phase2Enabled, configurationSource: configured(env, "MARKETING_INTELLIGENCE_PHASE2_ENABLED") ? "EXPLICIT" : "DEFAULT" },
    recommendation, alert: alertPerformance, alertPerformance, alertHealth,
    creativeSync, creativeScore, recommendationExpiry, fullEvaluation,
  };
}

module.exports = {
  DEFAULTS,
  MarketingIntelligenceSchedulerConfigError,
  validTimezone,
  validateIntelligenceSchedulerEnvironment,
};
