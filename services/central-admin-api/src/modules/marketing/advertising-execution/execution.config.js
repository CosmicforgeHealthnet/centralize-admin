const { PROVIDERS } = require("./execution.constants");
const { executionError } = require("./execution.errors");

const DEFAULTS = Object.freeze({
  enabled: false,
  dryRun: true,
  workerEnabled: false,
  providers: Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider, false]))),
  connectionWriteEnabled: false,
});

const PROVIDER_ENV_KEYS = Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [
  provider,
  `MARKETING_AD_EXECUTION_${provider}_ENABLED`,
])));

const VERSION_ENV_KEYS = Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [
  provider,
  `MARKETING_AD_EXECUTION_${provider}_API_VERSION`,
])));

const VERSION_PATTERNS = Object.freeze({
  GOOGLE_ADS: /^v\d+(?:\.\d+)?$/,
  META: /^v\d+(?:\.\d+)?$/,
  TIKTOK: /^v\d+(?:\.\d+)?$/,
  LINKEDIN: /^\d{6}$/,
  X: /^\d+$/,
});

function isProviderVersionSupported(provider, value, now = new Date()) {
  if (!VERSION_PATTERNS[provider]?.test(value)) return false;
  if (provider === "GOOGLE_ADS") {
    const major = Number(/^v(\d+)/.exec(value)?.[1]);
    return major >= 21 && major <= 24;
  }
  if (provider === "LINKEDIN") {
    const latest = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
    const minimumDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const minimum = minimumDate.getUTCFullYear() * 100 + minimumDate.getUTCMonth() + 1;
    const parsed = Number(value);
    return parsed >= minimum && parsed <= latest;
  }
  if (provider === "X") return value === "12";
  return true;
}

function readProviderVersion(env, provider, issues) {
  const key = VERSION_ENV_KEYS[provider];
  const value = String(env[key] || "").trim();
  if (!value) return null;
  if (!isProviderVersionSupported(provider, value)) {
    issues.push({ variable: key, reasonCode: "INVALID_PROVIDER_API_VERSION" });
    return null;
  }
  return value;
}

function parseBoolean(env, key, fallback, issues) {
  const value = env[key];
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issues.push({ variable: key, reasonCode: "INVALID_BOOLEAN" });
  return fallback;
}

function readExecutionConfig(env = process.env) {
  const issues = [];
  const enabled = parseBoolean(env, "MARKETING_AD_EXECUTION_ENABLED", DEFAULTS.enabled, issues);
  const dryRun = parseBoolean(env, "MARKETING_AD_EXECUTION_DRY_RUN", DEFAULTS.dryRun, issues);
  const workerConfigured = parseBoolean(env, "MARKETING_AD_EXECUTION_WORKER_ENABLED", DEFAULTS.workerEnabled, issues);
  const reconciliationWorkerEnabled = parseBoolean(env, "MARKETING_AD_RECONCILIATION_WORKER_ENABLED", false, issues);
  const configuredProviders = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    parseBoolean(env, PROVIDER_ENV_KEYS[provider], false, issues),
  ]));
  const apiVersions = Object.fromEntries(PROVIDERS.map((provider) => [provider, readProviderVersion(env, provider, issues)]));
  for (const provider of PROVIDERS) {
    const versionValue = String(env[VERSION_ENV_KEYS[provider]] || "").trim();
    if (configuredProviders[provider] && !versionValue) {
      issues.push({ variable: VERSION_ENV_KEYS[provider], reasonCode: "PROVIDER_API_VERSION_REQUIRED" });
    }
  }
  if (issues.length) throw executionError("INVALID_EXECUTION_CONFIG", { issues });

  return Object.freeze({
    enabled,
    dryRun,
    workerEnabled: enabled && workerConfigured,
    workerConfigured,
    reconciliationWorkerEnabled,
    providers: Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider, enabled && configuredProviders[provider]]))),
    configuredProviders: Object.freeze(configuredProviders),
    apiVersions: Object.freeze(apiVersions),
    connectionWriteEnabled: false,
  });
}

module.exports = { DEFAULTS, PROVIDER_ENV_KEYS, VERSION_ENV_KEYS, VERSION_PATTERNS, isProviderVersionSupported, readProviderVersion, readExecutionConfig };
