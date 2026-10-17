const { prisma } = require("../../../../shared/config/database");
const { canonicalJson, stableHash } = require("../creative/creative.connector.interface");
const { SETTING_REGISTRY } = require("../setting-registry");

const DEFAULTS = Object.freeze({
  alertEvaluationEnabled: SETTING_REGISTRY.alertEvaluationEnabled.default,
  alertAnalysisWindowDays: 7,
  alertComparisonWindowDays: 7,
  alertCooldownMinutes: SETTING_REGISTRY.alertCooldownMinutes.default,
  alertCooldownInfoMinutes: 360,
  alertCooldownWarningMinutes: 180,
  alertCooldownCriticalMinutes: 30,
  alertRecoveryEvaluations: 2,
  alertPersistenceEvaluations: 2,
  alertDegradedConnectionFailureCount: 3,
  alertSyncStaleHours: 24,
  alertTargetCpa: null,
  alertCpaThresholdPct: 0.25,
  alertSpendWithoutConversionThreshold: 100,
  alertConversionRateDropPct: 0.25,
  alertCampaignPerformanceDropPct: 0.20,
  alertHighPerformanceThresholdPct: 0.20,
  alertRecipientAdminUserIds: [],
  alertRecipientDepartment: "MARKETING",
});

const RATIO_KEYS = new Set(["alertCpaThresholdPct", "alertConversionRateDropPct", "alertCampaignPerformanceDropPct", "alertHighPerformanceThresholdPct"]);
const INTEGER_KEYS = new Set(["alertAnalysisWindowDays", "alertComparisonWindowDays", "alertCooldownMinutes", "alertCooldownInfoMinutes", "alertCooldownWarningMinutes", "alertCooldownCriticalMinutes", "alertRecoveryEvaluations", "alertPersistenceEvaluations", "alertDegradedConnectionFailureCount", "alertSyncStaleHours"]);
const DEPARTMENTS = new Set(["FINANCE", "DEVELOPMENT", "CUSTOMER_CARE", "MARKETING", "SOCIAL_MEDIA", "EXECUTIVE", "MANAGEMENT", "HR", "VERIFICATION", "RTC", "TELEMEDICINE", "OPERATIONS"]);

function rawValue(row) {
  const value = row?.valueJson;
  return value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value") ? value.value : value;
}

function validateSetting(key, value) {
  if (key === "alertEvaluationEnabled") {
    if (typeof value !== "boolean") throw new Error("must be boolean");
    return value;
  }
  if (key === "alertRecipientAdminUserIds") {
    if (!Array.isArray(value) || value.length > 100) throw new Error("must be a bounded array");
    return [...new Set(value.map(String).map((item) => item.trim()).filter((item) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item)))];
  }
  if (key === "alertRecipientDepartment") {
    const department = String(value || "").trim().toUpperCase();
    if (!DEPARTMENTS.has(department)) throw new Error("must be a known department");
    return department;
  }
  if (key === "alertTargetCpa" && (value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("must be a non-negative number");
  if (RATIO_KEYS.has(key) && number > 1) throw new Error("must be a ratio from 0 to 1");
  if (INTEGER_KEYS.has(key) && (!Number.isInteger(number) || number > 1000000)) throw new Error("must be a bounded integer");
  return number;
}

function rank(row, context) {
  if (row.scopeType === "CONNECTION" && row.connectionId === context.connectionId) return 3;
  if (row.scopeType === "PLATFORM" && row.platform === context.platform) return 2;
  return row.scopeType === "GLOBAL" ? 1 : 0;
}

function createAlertSettingsService({ prisma: db = prisma } = {}) {
  async function resolveSettings(context = {}) {
    const rows = db.marketing_intelligence_settings?.findMany ? await db.marketing_intelligence_settings.findMany({
      where: { key: { in: Object.keys(DEFAULTS) }, OR: [{ scopeType: "GLOBAL" }, { scopeType: "PLATFORM", platform: context.platform }, { scopeType: "CONNECTION", connectionId: context.connectionId }] },
    }) : [];
    const values = {};
    const sources = {};
    const invalidSettings = [];
    for (const key of Object.keys(DEFAULTS)) {
      const candidates = rows.filter((row) => row.key === key && rank(row, context)).sort((a, b) => rank(b, context) - rank(a, context));
      let selected = false;
      for (const row of candidates) {
        try {
          values[key] = validateSetting(key, rawValue(row));
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
    const fingerprint = stableHash(canonicalJson({ values, sources }));
    return { values, sources, invalidSettings, fingerprint };
  }
  return { resolveSettings };
}

module.exports = { DEFAULTS, validateSetting, createAlertSettingsService };
