const crypto = require("crypto");
const {
  resolveMediaStorageConfig,
  validateMediaStorageConfig,
  normalizeMode,
} = require("../media/storage/media-storage.config");

const PROVIDERS = Object.freeze({
  META: {
    flag: "META_SOCIAL_ENABLED",
    aliases: ["SOCIAL_META_ENABLED"],
    required: [
      "SOCIAL_META_CLIENT_ID",
      "SOCIAL_META_CLIENT_SECRET",
      "SOCIAL_META_REDIRECT_URI",
      "SOCIAL_META_WEBHOOK_SECRET",
      "SOCIAL_META_WEBHOOK_VERIFY_TOKEN",
    ],
    redirect: "SOCIAL_META_REDIRECT_URI",
  },
  TIKTOK: {
    flag: "TIKTOK_SOCIAL_ENABLED",
    aliases: ["SOCIAL_TIKTOK_ENABLED"],
    required: [
      "SOCIAL_TIKTOK_CLIENT_KEY",
      "SOCIAL_TIKTOK_CLIENT_SECRET",
      "SOCIAL_TIKTOK_REDIRECT_URI",
    ],
    webhookFlag: "TIKTOK_SOCIAL_WEBHOOKS_ENABLED",
    webhookRequired: ["SOCIAL_TIKTOK_WEBHOOK_SECRET"],
    redirect: "SOCIAL_TIKTOK_REDIRECT_URI",
  },
  X: {
    flag: "X_SOCIAL_ENABLED",
    aliases: ["SOCIAL_X_ENABLED"],
    required: [
      "SOCIAL_X_CLIENT_ID",
      "SOCIAL_X_CLIENT_SECRET",
      "SOCIAL_X_REDIRECT_URI",
    ],
    redirect: "SOCIAL_X_REDIRECT_URI",
  },
  LINKEDIN: {
    flag: "LINKEDIN_SOCIAL_ENABLED",
    aliases: ["SOCIAL_LINKEDIN_ENABLED"],
    required: [
      "SOCIAL_LINKEDIN_CLIENT_ID",
      "SOCIAL_LINKEDIN_CLIENT_SECRET",
      "SOCIAL_LINKEDIN_REDIRECT_URI",
    ],
    webhookFlag: "LINKEDIN_SOCIAL_WEBHOOKS_ENABLED",
    webhookRequired: ["SOCIAL_LINKEDIN_WEBHOOK_SECRET"],
    redirect: "SOCIAL_LINKEDIN_REDIRECT_URI",
  },
});

const BOOL_FLAGS = Object.freeze([
  "SOCIAL_WORKERS_ENABLED",
  "SOCIAL_PUBLISHING_WORKER_ENABLED",
  "SOCIAL_ACTION_WORKER_ENABLED",
  "SOCIAL_RECONCILIATION_ENABLED",
  "SOCIAL_REDACTION_WORKER_ENABLED",
  "SOCIAL_INBOX_ENABLED",
  "SOCIAL_PHASE_D_ENABLED",
  "META_SOCIAL_ENABLED",
  "TIKTOK_SOCIAL_ENABLED",
  "X_SOCIAL_ENABLED",
  "LINKEDIN_SOCIAL_ENABLED",
  "SOCIAL_META_ENABLED",
  "SOCIAL_TIKTOK_ENABLED",
  "SOCIAL_X_ENABLED",
  "SOCIAL_LINKEDIN_ENABLED",
  "TIKTOK_SOCIAL_WEBHOOKS_ENABLED",
  "LINKEDIN_SOCIAL_WEBHOOKS_ENABLED",
]);

const NUMERIC_RULES = Object.freeze({
  SOCIAL_WORKER_POLL_INTERVAL_MS: [1000, 300000, 30000],
  SOCIAL_WORKER_RECOVERY_INTERVAL_MS: [1000, 300000, 30000],
  SOCIAL_WORKER_LEASE_DURATION_MS: [5000, 900000, 300000],
  SOCIAL_WORKER_HEARTBEAT_INTERVAL_MS: [1000, 300000, 30000],
  SOCIAL_PUBLISHING_WORKER_CONCURRENCY: [1, 20, 1],
  SOCIAL_ACTION_WORKER_CONCURRENCY: [1, 50, 1],
  SOCIAL_PUBLISHING_WORKER_BATCH_SIZE: [1, 100, 5],
  SOCIAL_ACTION_WORKER_BATCH_SIZE: [1, 250, 10],
  SOCIAL_WORKER_SHUTDOWN_GRACE_MS: [1000, 120000, 10000],
  SOCIAL_WORKER_MAX_ATTEMPTS: [1, 20, 6],
  SOCIAL_WORKER_RETRY_MIN_MS: [1000, 86400000, 10000],
  SOCIAL_WORKER_RETRY_MAX_MS: [1000, 604800000, 3600000],
});

class SocialOperationsConfigError extends Error {
  constructor(issues) {
    super("Social Operations configuration is invalid");
    this.name = "SocialOperationsConfigError";
    this.issues = issues;
    Error.captureStackTrace(this, this.constructor);
  }
}

function value(env, names) {
  for (const name of Array.isArray(names) ? names : [names]) {
    if (env[name] !== undefined && env[name] !== "") return env[name];
  }
  return undefined;
}

function issue(issues, variable, reasonCode) {
  issues.push({ variable, reasonCode });
}

function boolValue(env, name, issues) {
  const raw = env[name];
  if (raw === undefined || raw === "") return false;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issue(issues, name, "INVALID_BOOLEAN");
  return false;
}

function providerFlag(env, provider, issues) {
  const config = PROVIDERS[provider];
  return [config.flag, ...(config.aliases || [])].some((name) => boolValue(env, name, issues));
}

function parseNumber(env, name, issues) {
  const [min, max, fallback] = NUMERIC_RULES[name];
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    issue(issues, name, "INVALID_NUMBER_RANGE");
    return fallback;
  }
  return parsed;
}

function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname || "").toLowerCase());
}

function isPlaceholderSecret(text) {
  return /^(test|testing|example|placeholder|changeme|change_me|ephemeral|local)$/i.test(
    String(text || ""),
  );
}

function parseUrl({ env, name, required, mode, issues, mustBeHttps = false }) {
  const raw = env[name];
  if (!raw) {
    if (required) issue(issues, name, "REQUIRED");
    return null;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    issue(issues, name, "MALFORMED_URL");
    return null;
  }
  if (parsed.hash) issue(issues, name, "URL_FRAGMENT_FORBIDDEN");
  if (raw.includes("*")) issue(issues, name, "WILDCARD_FORBIDDEN");
  if ((mustBeHttps || ["staging", "production"].includes(mode)) && parsed.protocol !== "https:") {
    issue(issues, name, "HTTPS_REQUIRED");
  }
  if (["staging", "production"].includes(mode) && isLocalHost(parsed.hostname)) {
    issue(issues, name, "LOCALHOST_FORBIDDEN");
  }
  return parsed;
}

function validateDatabase({ env, mode, issues }) {
  const raw = env.DATABASE_URL;
  if (["staging", "production"].includes(mode) && !raw) {
    issue(issues, "DATABASE_URL", "REQUIRED");
    return;
  }
  if (!raw) return;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    issue(issues, "DATABASE_URL", "MALFORMED_URL");
    return;
  }
  if (!["postgresql:", "postgres:"].includes(parsed.protocol)) {
    issue(issues, "DATABASE_URL", "POSTGRES_SCHEME_REQUIRED");
  }
  if (["staging", "production"].includes(mode) && isLocalHost(parsed.hostname)) {
    issue(issues, "DATABASE_URL", "LOCALHOST_FORBIDDEN");
  }
  if (mode === "production" && /test|ci|ephemeral|local/i.test(parsed.pathname)) {
    issue(issues, "DATABASE_URL", "PRODUCTION_TEST_DATABASE_FORBIDDEN");
  }
}

function decodeKeyMaterial(value) {
  const text = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, "hex");
  return Buffer.from(text, "base64");
}

function validateEncryption({ env, mode, issues }) {
  if (!["staging", "production"].includes(mode)) return;
  const keyringName =
    env.SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON !== undefined
      ? "SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON"
      : "SOCIAL_ENCRYPTION_KEYS_JSON";
  const activeName =
    env.SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION !== undefined
      ? "SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION"
      : "SOCIAL_ENCRYPTION_ACTIVE_VERSION";
  const rawKeyring = value(env, [
    "SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON",
    "SOCIAL_ENCRYPTION_KEYS_JSON",
  ]);
  const activeVersion = value(env, [
    "SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION",
    "SOCIAL_ENCRYPTION_ACTIVE_VERSION",
  ]);
  if (!rawKeyring) {
    issue(issues, keyringName, "REQUIRED");
  }
  if (!activeVersion) {
    issue(issues, activeName, "REQUIRED");
  }
  if (rawKeyring) {
    try {
      const parsed = JSON.parse(rawKeyring);
      const entries = Array.isArray(parsed)
        ? parsed.map((entry) => [String(entry.version || entry.keyVersion || entry.id), entry.key || entry.value || entry.material])
        : Object.entries(parsed);
      if (!entries.length) issue(issues, keyringName, "KEYRING_EMPTY");
      const versions = new Set(entries.map(([version]) => String(version)));
      if (activeVersion && !versions.has(String(activeVersion))) {
        issue(issues, activeName, "ACTIVE_VERSION_NOT_IN_KEYRING");
      }
      for (const [, material] of entries) {
        if (isPlaceholderSecret(material) || decodeKeyMaterial(material).length !== 32) {
          issue(issues, keyringName, "KEY_LENGTH_INVALID");
          break;
        }
      }
    } catch {
      issue(issues, keyringName, "KEYRING_INVALID");
    }
  }
  const hashKey = env.SOCIAL_CONTENT_HASH_KEY;
  if (!hashKey) issue(issues, "SOCIAL_CONTENT_HASH_KEY", "REQUIRED");
  if (hashKey && (String(hashKey).length < 32 || isPlaceholderSecret(hashKey))) {
    issue(issues, "SOCIAL_CONTENT_HASH_KEY", "SECRET_WEAK_OR_PLACEHOLDER");
  }
}

function validateStorage({ env, mode, issues }) {
  try {
    validateMediaStorageConfig(resolveMediaStorageConfig({ env, mode }));
  } catch (error) {
    const details = error.details || {};
    if (details.missing) {
      for (const name of details.missing) issue(issues, name, "REQUIRED");
    } else {
      issue(issues, details.variable || "SOCIAL_MEDIA_STORAGE_PROVIDER", details.reasonCode || "INVALID");
    }
  }
}

function validateUrls({ env, mode, issues }) {
  for (const name of ["ADMIN_APP_BASE_URL", "SOCIAL_API_BASE_URL", "ADMIN_BACKEND_PUBLIC_URL"]) {
    parseUrl({ env, name, required: ["staging", "production"].includes(mode), mode, issues });
  }
  const allowList =
    env.SOCIAL_OAUTH_REDIRECT_URIS ||
    env.SOCIAL_OPERATIONS_OAUTH_REDIRECT_URIS ||
    "";
  if (["staging", "production"].includes(mode) && !allowList) {
    issue(issues, "SOCIAL_OAUTH_REDIRECT_URIS", "REQUIRED");
  }
  for (const [index, entry] of allowList.split(",").map((item) => item.trim()).filter(Boolean).entries()) {
    parseUrl({
      env: { CALLBACK_ENTRY: entry },
      name: "CALLBACK_ENTRY",
      required: false,
      mode,
      issues,
      mustBeHttps: ["staging", "production"].includes(mode),
    });
    const last = issues[issues.length - 1];
    if (last?.variable === "CALLBACK_ENTRY") {
      last.variable = `SOCIAL_OAUTH_REDIRECT_URIS[${index}]`;
    }
  }
}

function validateAdminGoogleOAuth({ env, mode, issues }) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL",
  ];
  const hasValue = (name) => env[name] !== undefined && String(env[name]).trim() !== "";
  const present = required.filter((name) => hasValue(name));
  if (present.length === 0) return;

  for (const name of required) {
    if (!hasValue(name)) issue(issues, name, "REQUIRED");
  }
  if (!hasValue("GOOGLE_CALLBACK_URL")) return;

  const googleEnv = {
    ...env,
    GOOGLE_CALLBACK_URL: String(env.GOOGLE_CALLBACK_URL).trim(),
  };
  const before = issues.length;
  parseUrl({
    env: googleEnv,
    name: "GOOGLE_CALLBACK_URL",
    required: true,
    mode,
    issues,
    mustBeHttps: ["staging", "production"].includes(mode),
  });
  if (issues.length > before) return;

  const parsed = new URL(googleEnv.GOOGLE_CALLBACK_URL);
  if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname)) {
    issue(issues, "GOOGLE_CALLBACK_URL", "HTTPS_REQUIRED");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:code|token|secret|key|credential)/i.test(key)) {
      issue(issues, "GOOGLE_CALLBACK_URL", "SENSITIVE_QUERY_PARAM_FORBIDDEN");
      break;
    }
  }
}

function validateProviders({ env, mode, issues }) {
  const enabled = [];
  for (const provider of Object.keys(PROVIDERS)) {
    const config = PROVIDERS[provider];
    const isEnabled = providerFlag(env, provider, issues);
    if (!isEnabled) continue;
    enabled.push(provider);
    if (["staging", "production"].includes(mode)) {
      for (const name of config.required) {
        if (!env[name]) issue(issues, name, "REQUIRED");
      }
      if (config.webhookFlag && boolValue(env, config.webhookFlag, issues)) {
        for (const name of config.webhookRequired || []) {
          if (!env[name]) issue(issues, name, "REQUIRED");
        }
      }
      parseUrl({
        env,
        name: config.redirect,
        required: true,
        mode,
        issues,
        mustBeHttps: true,
      });
    }
  }
  if ((providerFlag(env, "X", issues) || false) && (env.X_ADS_API_BASE_URL || env.X_ADS_CLIENT_ID)) {
    issue(issues, "X_ADS_API_BASE_URL", "ADS_CONFIG_DOES_NOT_SATISFY_ORGANIC_SOCIAL");
  }
  return enabled;
}

function validateWorkers({ env, mode, issues, complianceReady = false }) {
  for (const name of BOOL_FLAGS) boolValue(env, name, issues);
  const numbers = Object.fromEntries(
    Object.keys(NUMERIC_RULES).map((name) => [name, parseNumber(env, name, issues)]),
  );
  if (numbers.SOCIAL_WORKER_HEARTBEAT_INTERVAL_MS >= numbers.SOCIAL_WORKER_LEASE_DURATION_MS) {
    issue(issues, "SOCIAL_WORKER_HEARTBEAT_INTERVAL_MS", "HEARTBEAT_MUST_BE_LESS_THAN_LEASE");
  }
  if (numbers.SOCIAL_WORKER_RETRY_MIN_MS > numbers.SOCIAL_WORKER_RETRY_MAX_MS) {
    issue(issues, "SOCIAL_WORKER_RETRY_MIN_MS", "RETRY_MIN_MUST_NOT_EXCEED_MAX");
  }
  const workersEnabled = boolValue(env, "SOCIAL_WORKERS_ENABLED", issues);
  if (workersEnabled && !env.DATABASE_URL) issue(issues, "DATABASE_URL", "REQUIRED_FOR_WORKERS");
  const inboxEnabled = boolValue(env, "SOCIAL_INBOX_ENABLED", issues);
  const phaseDEnabled = boolValue(env, "SOCIAL_PHASE_D_ENABLED", issues);
  const redactionEnabled = boolValue(env, "SOCIAL_REDACTION_WORKER_ENABLED", issues);
  if (inboxEnabled && !phaseDEnabled) issue(issues, "SOCIAL_INBOX_ENABLED", "PHASE_D_REQUIRED");
  if (phaseDEnabled && !complianceReady) issue(issues, "SOCIAL_PHASE_D_ENABLED", "COMPLIANCE_GATE_REQUIRED");
  if (redactionEnabled && !complianceReady) {
    issue(issues, "SOCIAL_REDACTION_WORKER_ENABLED", "COMPLIANCE_GATE_REQUIRED");
  }
  return numbers;
}

function safeSyntheticEnv(mode) {
  const key = crypto.randomBytes(32).toString("base64");
  return {
    NODE_ENV: mode === "test" ? "test" : "production",
    APP_ENV: mode,
    DATABASE_URL: `postgresql://admin:placeholder@db.${mode}.example.test:5432/cosmicforge_admin_${mode}`,
    ADMIN_APP_BASE_URL: `https://admin.${mode}.example.test`,
    SOCIAL_API_BASE_URL: `https://admin-api.${mode}.example.test/api/v1/marketing/social`,
    ADMIN_BACKEND_PUBLIC_URL: `https://admin-api.${mode}.example.test`,
    SOCIAL_OAUTH_REDIRECT_URIS: `https://admin-api.${mode}.example.test/api/v1/marketing/social/oauth/META/callback`,
    SOCIAL_MEDIA_STORAGE_PROVIDER: "cloudinary",
    CLOUDINARY_CLOUD_NAME: "synthetic-cloud",
    CLOUDINARY_API_KEY: "synthetic-api-key",
    CLOUDINARY_API_SECRET: "synthetic-api-secret-with-safe-length",
    SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON: JSON.stringify({ "2026-07": key }),
    SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION: "2026-07",
    SOCIAL_CONTENT_HASH_KEY: crypto.randomBytes(32).toString("hex"),
    SOCIAL_WORKERS_ENABLED: "false",
    SOCIAL_PUBLISHING_WORKER_ENABLED: "false",
    SOCIAL_ACTION_WORKER_ENABLED: "false",
    SOCIAL_REDACTION_WORKER_ENABLED: "false",
    SOCIAL_INBOX_ENABLED: "false",
    SOCIAL_PHASE_D_ENABLED: "false",
    META_SOCIAL_ENABLED: "false",
    TIKTOK_SOCIAL_ENABLED: "false",
    X_SOCIAL_ENABLED: "false",
    LINKEDIN_SOCIAL_ENABLED: "false",
  };
}

function validateSocialOperationsEnvironment({
  env = process.env,
  mode,
  complianceReady = false,
} = {}) {
  const resolvedMode = normalizeMode(mode || env.SOCIAL_OPERATIONS_ENV || env.APP_ENV || env.NODE_ENV);
  const issues = [];
  validateDatabase({ env, mode: resolvedMode, issues });
  validateEncryption({ env, mode: resolvedMode, issues });
  validateStorage({ env, mode: resolvedMode, issues });
  validateUrls({ env, mode: resolvedMode, issues });
  validateAdminGoogleOAuth({ env, mode: resolvedMode, issues });
  const enabledProviders = validateProviders({ env, mode: resolvedMode, issues });
  const workerConfig = validateWorkers({ env, mode: resolvedMode, issues, complianceReady });
  if (issues.length) throw new SocialOperationsConfigError(issues);
  return {
    mode: resolvedMode,
    storageProvider: resolveMediaStorageConfig({ env, mode: resolvedMode }).provider,
    enabledProviders,
    workerConfig,
    phaseDEnabled: boolValue(env, "SOCIAL_PHASE_D_ENABLED", []),
    inboxEnabled: boolValue(env, "SOCIAL_INBOX_ENABLED", []),
  };
}

module.exports = {
  PROVIDERS,
  BOOL_FLAGS,
  NUMERIC_RULES,
  SocialOperationsConfigError,
  safeSyntheticEnv,
  validateAdminGoogleOAuth,
  validateSocialOperationsEnvironment,
};
