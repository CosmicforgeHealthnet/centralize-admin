const test = require("node:test");
const assert = require("node:assert/strict");
const { readExecutionConfig, isProviderVersionSupported } = require("../execution.config");

test("provider versions are configuration-driven and safe defaults stay disabled", () => {
  const config = readExecutionConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.workerEnabled, false);
  assert.equal(config.connectionWriteEnabled, false);
  assert.deepEqual(config.apiVersions, { GOOGLE_ADS: null, META: null, TIKTOK: null, LINKEDIN: null, X: null });
});

test("an enabled provider fails closed without its required API version", () => {
  assert.throws(() => readExecutionConfig({ MARKETING_AD_EXECUTION_GOOGLE_ADS_ENABLED: "true" }), (error) => error.code === "INVALID_EXECUTION_CONFIG" && error.errors[0].issues.some((issue) => issue.reasonCode === "PROVIDER_API_VERSION_REQUIRED"));
});

test("malformed or unsupported provider versions are rejected", () => {
  assert.throws(() => readExecutionConfig({ MARKETING_AD_EXECUTION_GOOGLE_ADS_API_VERSION: "v999" }), (error) => error.code === "INVALID_EXECUTION_CONFIG");
  assert.throws(() => readExecutionConfig({ MARKETING_AD_EXECUTION_X_API_VERSION: "13" }), (error) => error.code === "INVALID_EXECUTION_CONFIG");
  assert.equal(isProviderVersionSupported("GOOGLE_ADS", "v24"), true);
  assert.equal(isProviderVersionSupported("X", "12"), true);
  assert.equal(isProviderVersionSupported("LINKEDIN", "202607", new Date("2026-07-22T00:00:00.000Z")), true);
  assert.equal(isProviderVersionSupported("LINKEDIN", "202506", new Date("2026-07-22T00:00:00.000Z")), false);
});

test("configured versions never imply effective write readiness", () => {
  const config = readExecutionConfig({ MARKETING_AD_EXECUTION_ENABLED: "false", MARKETING_AD_EXECUTION_WORKER_ENABLED: "true", MARKETING_AD_EXECUTION_GOOGLE_ADS_ENABLED: "true", MARKETING_AD_EXECUTION_GOOGLE_ADS_API_VERSION: "v24" });
  assert.equal(config.providers.GOOGLE_ADS, false);
  assert.equal(config.workerEnabled, false);
  assert.equal(config.connectionWriteEnabled, false);
});
