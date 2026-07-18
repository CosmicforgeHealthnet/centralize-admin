const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  SocialOperationsConfigError,
  safeSyntheticEnv,
  validateSocialOperationsEnvironment,
} = require("../src/modules/marketing/social-operations/config/social-operations-env.validator");

function expectIssue(fn, variable, reasonCode) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error instanceof SocialOperationsConfigError, true);
      assert.equal(
        error.issues.some(
          (issue) =>
            issue.variable === variable &&
            (!reasonCode || issue.reasonCode === reasonCode),
        ),
        true,
        JSON.stringify(error.issues),
      );
      assert.equal(JSON.stringify(error.issues).includes("super-secret-value"), false);
      return true;
    },
  );
}

test("development and synthetic staging/production validate with safe defaults", () => {
  const development = validateSocialOperationsEnvironment({
    mode: "development",
    env: {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cosmicforge_admin",
    },
  });
  assert.equal(development.mode, "development");
  assert.equal(development.storageProvider, "local");

  const staging = validateSocialOperationsEnvironment({
    mode: "staging",
    env: safeSyntheticEnv("staging"),
  });
  assert.equal(staging.storageProvider, "cloudinary");

  const production = validateSocialOperationsEnvironment({
    mode: "production",
    env: safeSyntheticEnv("production"),
  });
  assert.equal(production.mode, "production");
});

test("strict staging and production fail closed for database, storage, encryption and URLs", () => {
  expectIssue(
    () => validateSocialOperationsEnvironment({ mode: "staging", env: {} }),
    "DATABASE_URL",
    "REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cosmicforge_admin",
        },
      }),
    "DATABASE_URL",
    "LOCALHOST_FORBIDDEN",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_MEDIA_STORAGE_PROVIDER: "local",
        },
      }),
    "SOCIAL_MEDIA_STORAGE_PROVIDER",
    "SOCIAL_MEDIA_LOCAL_STORAGE_FORBIDDEN",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "staging",
        env: {
          ...safeSyntheticEnv("staging"),
          CLOUDINARY_API_SECRET: "",
        },
      }),
    "CLOUDINARY_API_SECRET",
    "REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON: "",
        },
      }),
    "SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON",
    "REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_OAUTH_REDIRECT_URIS: "http://admin.example.test/callback",
        },
      }),
    "SOCIAL_OAUTH_REDIRECT_URIS[0]",
    "HTTPS_REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_OAUTH_REDIRECT_URIS: "https://*.example.test/callback",
        },
      }),
    "SOCIAL_OAUTH_REDIRECT_URIS[0]",
    "WILDCARD_FORBIDDEN",
  );
});

test("encryption keyring active version, key length, and content hash key are validated", () => {
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION: "missing",
        },
      }),
    "SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION",
    "ACTIVE_VERSION_NOT_IN_KEYRING",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON: JSON.stringify({ active: "too-short" }),
          SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION: "active",
        },
      }),
    "SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON",
    "KEY_LENGTH_INVALID",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_CONTENT_HASH_KEY: "test",
        },
      }),
    "SOCIAL_CONTENT_HASH_KEY",
    "SECRET_WEAK_OR_PLACEHOLDER",
  );
  const key = crypto.randomBytes(32).toString("hex");
  const passed = validateSocialOperationsEnvironment({
    mode: "production",
    env: {
      ...safeSyntheticEnv("production"),
      SOCIAL_OPERATIONS_ENCRYPTION_KEYS_JSON: JSON.stringify({ active: key }),
      SOCIAL_OPERATIONS_ENCRYPTION_ACTIVE_VERSION: "active",
    },
  });
  assert.equal(passed.mode, "production");
});

test("provider credentials are conditional and Ads credentials cannot satisfy X organic social", () => {
  const disabled = validateSocialOperationsEnvironment({
    mode: "production",
    env: {
      ...safeSyntheticEnv("production"),
      META_SOCIAL_ENABLED: "false",
    },
  });
  assert.deepEqual(disabled.enabledProviders, []);

  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          META_SOCIAL_ENABLED: "true",
          SOCIAL_META_CLIENT_SECRET: "",
        },
      }),
    "SOCIAL_META_CLIENT_ID",
    "REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          TIKTOK_SOCIAL_ENABLED: "true",
          SOCIAL_TIKTOK_CLIENT_SECRET: "super-secret-value",
          SOCIAL_TIKTOK_CLIENT_KEY: "",
        },
      }),
    "SOCIAL_TIKTOK_CLIENT_KEY",
    "REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          X_SOCIAL_ENABLED: "true",
          X_ADS_API_BASE_URL: "https://ads-api.example.test",
        },
      }),
    "X_ADS_API_BASE_URL",
    "ADS_CONFIG_DOES_NOT_SATISFY_ORGANIC_SOCIAL",
  );
});

test("worker constraints, Phase D, live inbox, and redaction gates fail closed", () => {
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_WORKERS_ENABLED: "true",
          SOCIAL_WORKER_HEARTBEAT_INTERVAL_MS: "300000",
          SOCIAL_WORKER_LEASE_DURATION_MS: "300000",
        },
      }),
    "SOCIAL_WORKER_HEARTBEAT_INTERVAL_MS",
    "HEARTBEAT_MUST_BE_LESS_THAN_LEASE",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_WORKER_RETRY_MIN_MS: "5000",
          SOCIAL_WORKER_RETRY_MAX_MS: "1000",
        },
      }),
    "SOCIAL_WORKER_RETRY_MIN_MS",
    "RETRY_MIN_MUST_NOT_EXCEED_MAX",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_INBOX_ENABLED: "true",
        },
      }),
    "SOCIAL_INBOX_ENABLED",
    "PHASE_D_REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_PHASE_D_ENABLED: "true",
        },
      }),
    "SOCIAL_PHASE_D_ENABLED",
    "COMPLIANCE_GATE_REQUIRED",
  );
  expectIssue(
    () =>
      validateSocialOperationsEnvironment({
        mode: "production",
        env: {
          ...safeSyntheticEnv("production"),
          SOCIAL_REDACTION_WORKER_ENABLED: "true",
        },
      }),
    "SOCIAL_REDACTION_WORKER_ENABLED",
    "COMPLIANCE_GATE_REQUIRED",
  );
});
