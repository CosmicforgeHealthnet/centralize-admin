const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MarketingIntelligenceSchedulerConfigError,
  validateIntelligenceSchedulerEnvironment,
} = require("../scheduling/scheduler-config");
const {
  registerIntelligenceSchedulers,
  resetForTests,
} = require("../scheduling/intelligence-scheduler.registry");

function fakeCron() {
  const calls = [];
  return {
    calls,
    validate: (value) => /^([*\d/,\-]+\s+){4}[*\d/,\-]+$/.test(value),
    schedule(expression, fn, options) {
      const task = { expression, fn, options, stopped: false, stop() { this.stopped = true; } };
      calls.push(task);
      return task;
    },
  };
}

function env(overrides = {}) {
  return {
    NODE_ENV: "development",
    MARKETING_INTELLIGENCE_PHASE2_ENABLED: "true",
    MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "true",
    MARKETING_RECOMMENDATION_CRON: "15 */6 * * *",
    MARKETING_RECOMMENDATION_TIMEZONE: "UTC",
    MARKETING_ALERT_SCHEDULER_ENABLED: "true",
    MARKETING_ALERT_CRON: "*/15 * * * *",
    MARKETING_ALERT_TIMEZONE: "Europe/Rome",
    ...overrides,
  };
}

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

test.afterEach(async () => resetForTests());

test("disabled schedulers do not register", () => {
  const cronLib = fakeCron();
  const registry = registerIntelligenceSchedulers({
    env: env({ MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "false", MARKETING_ALERT_SCHEDULER_ENABLED: "false" }),
    cronLib,
    recommendationEvaluationService: { evaluate: async () => ({}) },
    alertEvaluationService: { evaluate: async () => ({}) },
    log: silentLog(),
    force: true,
  });
  assert.equal(cronLib.calls.length, 0);
  assert.equal(registry.recommendation.getTask(), null);
  assert.equal(registry.alert.getTask(), null);
});

test("enabled schedulers register once with independent cron and timezone", () => {
  const cronLib = fakeCron();
  const options = {
    env: env(), cronLib,
    recommendationEvaluationService: { evaluate: async () => ({ status: "SUCCEEDED" }) },
    alertEvaluationService: { evaluate: async () => ({ status: "SUCCEEDED" }) },
    log: silentLog(), force: true,
  };
  const first = registerIntelligenceSchedulers(options);
  const second = registerIntelligenceSchedulers(options);
  assert.equal(first, second);
  assert.equal(cronLib.calls.length, 3);
  assert.deepEqual(cronLib.calls.map((call) => [call.expression, call.options.timezone]), [
    ["15 */6 * * *", "UTC"],
    ["*/15 * * * *", "Europe/Rome"],
    ["5 * * * *", "Europe/Rome"],
  ]);
});

test("every enabled component job registers exactly once", () => {
  const cronLib = fakeCron();
  registerIntelligenceSchedulers({
    env: env({
      MARKETING_CREATIVE_SYNC_SCHEDULER_ENABLED: "true",
      MARKETING_CREATIVE_SCORE_SCHEDULER_ENABLED: "true",
      MARKETING_RECOMMENDATION_EXPIRY_SCHEDULER_ENABLED: "true",
    }),
    cronLib,
    recommendationEvaluationService: { evaluate: async () => ({}) },
    alertEvaluationService: { evaluate: async () => ({}) },
    creativeSyncService: { syncCreatives: async () => ({}) },
    creativeScoringService: { scoreCreatives: async () => ({}) },
    recommendationExpiryService: { evaluate: async () => ({}) },
    log: silentLog(), force: true,
  });
  assert.equal(cronLib.calls.length, 6);
  assert.deepEqual(cronLib.calls.map((call) => call.expression), [
    "15 */6 * * *", "*/15 * * * *", "5 * * * *", "30 */6 * * *", "0 1 * * *", "30 2 * * *",
  ]);
});

test("full evaluation registers alone when component schedulers are disabled", () => {
  const cronLib = fakeCron();
  registerIntelligenceSchedulers({
    env: env({
      MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "false",
      MARKETING_ALERT_SCHEDULER_ENABLED: "false",
      MARKETING_FULL_EVALUATION_SCHEDULER_ENABLED: "true",
    }),
    cronLib,
    fullEvaluationService: { evaluate: async () => ({}) },
    log: silentLog(), force: true,
  });
  assert.equal(cronLib.calls.length, 1);
  assert.equal(cronLib.calls[0].expression, "0 3 * * *");
});

test("scheduled jobs call internal services directly with SCHEDULED trigger", async () => {
  const cronLib = fakeCron();
  const calls = [];
  registerIntelligenceSchedulers({
    env: env(), cronLib,
    recommendationEvaluationService: { evaluate: async (input) => { calls.push(["recommendation", input]); return { skipped: true, reason: "recommendation_evaluation_already_running" }; } },
    alertEvaluationService: { evaluate: async (input) => { calls.push(["alert", input]); return { status: "PARTIAL_SUCCESS" }; } },
    log: silentLog(), force: true,
  });
  await cronLib.calls[0].fn();
  await cronLib.calls[1].fn();
  assert.deepEqual(calls, [
    ["recommendation", { trigger: "SCHEDULED" }],
    ["alert", { trigger: "SCHEDULED", ruleGroup: "performance", types: ["CPA_TARGET_BREACH", "SPEND_WITHOUT_CONVERSION", "CONVERSION_RATE_DROP", "CREATIVE_FATIGUE", "CAMPAIGN_PERFORMANCE_DROP", "HIGH_PERFORMING_CAMPAIGN"] }],
  ]);
});

test("one scheduled evaluation failure does not block the other scheduler", async () => {
  const cronLib = fakeCron();
  let alertRuns = 0;
  registerIntelligenceSchedulers({
    env: env(), cronLib,
    recommendationEvaluationService: { evaluate: async () => { throw new Error("Bearer secret-token provider failure"); } },
    alertEvaluationService: { evaluate: async () => { alertRuns += 1; return { status: "SUCCEEDED" }; } },
    log: silentLog(), force: true,
  });
  const failed = await cronLib.calls[0].fn();
  await assert.doesNotReject(cronLib.calls[1].fn());
  assert.equal(failed.status, "FAILED");
  assert.doesNotMatch(failed.sanitizedError, /secret-token/);
  assert.equal(alertRuns, 1);
});

test("stop shuts down both jobs and permits clean registration after restart", async () => {
  const cronLib = fakeCron();
  const registry = registerIntelligenceSchedulers({
    env: env(), cronLib,
    recommendationEvaluationService: { evaluate: async () => ({}) },
    alertEvaluationService: { evaluate: async () => ({}) },
    log: silentLog(), force: true,
  });
  const originalTasks = [...cronLib.calls];
  assert.deepEqual(await registry.stop(), { recommendation: true, alertPerformance: true, alertHealth: true, creativeSync: false, creativeScore: false, recommendationExpiry: false, fullEvaluation: false });
  assert.equal(originalTasks.every((task) => task.stopped), true);
  registerIntelligenceSchedulers({
    env: env(), cronLib,
    recommendationEvaluationService: { evaluate: async () => ({}) },
    alertEvaluationService: { evaluate: async () => ({}) },
    log: silentLog(), force: true,
  });
  assert.equal(cronLib.calls.length, 6);
});

test("test environment does not register without an explicit injected force", () => {
  const cronLib = fakeCron();
  assert.equal(registerIntelligenceSchedulers({ env: env({ NODE_ENV: "test" }), cronLib }), null);
  assert.equal(cronLib.calls.length, 0);
});

test("configuration rejects invalid boolean, cron, and timezone explicitly", () => {
  const cronLib = fakeCron();
  assert.throws(
    () => validateIntelligenceSchedulerEnvironment({
      env: env({
        MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "yes",
        MARKETING_RECOMMENDATION_CRON: "not cron",
        MARKETING_ALERT_TIMEZONE: "Mars/Olympus_Mons",
      }),
      cronLib,
    }),
    (error) => {
      assert.ok(error instanceof MarketingIntelligenceSchedulerConfigError);
      assert.deepEqual(error.issues.map((issue) => issue.reasonCode).sort(), ["INVALID_BOOLEAN", "INVALID_CRON", "INVALID_TIMEZONE"]);
      return true;
    },
  );
});

test("alert health and performance use independent defaults and specific flags override legacy", async () => {
  const cronLib = fakeCron();
  const defaults = validateIntelligenceSchedulerEnvironment({ env: {}, cronLib });
  assert.deepEqual(defaults.alertHealth, { enabled: false, expression: "5 * * * *", timezone: "UTC", configurationSource: "DEFAULT" });
  assert.deepEqual(defaults.alertPerformance, { enabled: false, expression: "30 2 * * *", timezone: "UTC", configurationSource: "DEFAULT" });

  const calls = [];
  const registry = registerIntelligenceSchedulers({
    env: env({
      MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "false",
      MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED: "false",
      MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED: "true",
      MARKETING_ALERT_PERFORMANCE_CRON: "30 2 * * *",
      MARKETING_ALERT_PERFORMANCE_TIMEZONE: "UTC",
    }),
    cronLib,
    alertEvaluationService: { evaluate: async (input) => { calls.push(input); return {}; } },
    log: silentLog(), force: true,
  });
  assert.equal(cronLib.calls.length, 1);
  await cronLib.calls[0].fn();
  assert.equal(calls[0].ruleGroup, "performance");
  assert.deepEqual(await registry.stop(), { recommendation: false, alertPerformance: true, alertHealth: false, creativeSync: false, creativeScore: false, recommendationExpiry: false, fullEvaluation: false });
});

test("health can run without performance and legacy shared flag remains an unambiguous fallback", async () => {
  const cronLib = fakeCron();
  const calls = [];
  registerIntelligenceSchedulers({
    env: env({
      MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "false",
      MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED: "true",
      MARKETING_ALERT_HEALTH_TIMEZONE: "UTC",
      MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED: "false",
    }),
    cronLib,
    alertEvaluationService: { evaluate: async (input) => { calls.push(input); return {}; } },
    log: silentLog(), force: true,
  });
  assert.equal(cronLib.calls.length, 1);
  await cronLib.calls[0].fn();
  assert.equal(calls[0].ruleGroup, "health");
  await resetForTests();

  const legacy = validateIntelligenceSchedulerEnvironment({ env: { MARKETING_ALERT_SCHEDULER_ENABLED: "true" }, cronLib });
  assert.equal(legacy.alertHealth.enabled, true);
  assert.equal(legacy.alertPerformance.enabled, true);
  assert.equal(legacy.alertHealth.configurationSource, "LEGACY");
  assert.equal(legacy.alertPerformance.configurationSource, "LEGACY");
});

test("specific alert cron and timezone failures are reported independently", () => {
  const cronLib = fakeCron();
  assert.throws(() => validateIntelligenceSchedulerEnvironment({
    env: {
      MARKETING_ALERT_HEALTH_CRON: "bad health cron",
      MARKETING_ALERT_HEALTH_TIMEZONE: "Mars/Olympus",
      MARKETING_ALERT_PERFORMANCE_CRON: "bad performance cron",
    },
    cronLib,
  }), (error) => {
    assert.deepEqual(error.issues.map((issue) => issue.variable).sort(), ["MARKETING_ALERT_HEALTH_CRON", "MARKETING_ALERT_HEALTH_TIMEZONE", "MARKETING_ALERT_PERFORMANCE_CRON"].sort());
    return true;
  });
});

test("health runtime failure does not block performance and rule groups do not overlap", async () => {
  const cronLib = fakeCron(); let performanceRuns = 0; const groups = {};
  registerIntelligenceSchedulers({
    env: env({
      MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "false",
      MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED: "true",
      MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED: "true",
    }),
    cronLib,
    alertEvaluationService: { evaluate: async ({ ruleGroup, types }) => {
      groups[ruleGroup] = types;
      if (ruleGroup === "health") throw new Error("health provider failure");
      performanceRuns += 1; return { status: "SUCCEEDED" };
    } },
    log: silentLog(), force: true,
  });
  assert.equal(cronLib.calls.length, 2);
  assert.equal((await cronLib.calls[1].fn()).status, "FAILED");
  await assert.doesNotReject(cronLib.calls[0].fn());
  assert.equal(performanceRuns, 1);
  assert.deepEqual(groups.health.filter((type) => groups.performance.includes(type)), []);
});
