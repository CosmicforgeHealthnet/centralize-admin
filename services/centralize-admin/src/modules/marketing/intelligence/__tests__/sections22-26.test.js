const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PHASE2_DISABLED_CODE,
  isPhase2Enabled,
  disabledResult,
  requirePhase2Enabled,
} = require("../phase2-feature");
const { SETTING_REGISTRY } = require("../setting-registry");
const recommendationSettings = require("../recommendations/recommendation-settings.service");
const alertSettings = require("../alerts/alert-settings.service");
const { validateIntelligenceSchedulerEnvironment } = require("../scheduling/scheduler-config");
const { registerIntelligenceSchedulers, resetForTests } = require("../scheduling/intelligence-scheduler.registry");
const creativeSync = require("../creative/creative-sync.service");
const creativeScoring = require("../creative/creative-scoring.service");
const recommendationEvaluation = require("../recommendations/recommendation-evaluation.service");
const recommendationExpiry = require("../recommendations/recommendation-expiry.service");
const alertEvaluation = require("../alerts/alert-evaluation.service");
const fullEvaluation = require("../full-evaluation.service");
const phase1Cron = require("../aggregation/aggregation.cron");
const {
  LiveValidationSafetyError,
  parseArgs,
  validateInvocation,
  runLiveValidation,
} = require("../../../../../scripts/marketing-intelligence/live-validate-provider");

const ROOT = path.resolve(__dirname, "../../../../..");
const DOCS = path.join(ROOT, "docs");
const UUID = "11111111-1111-4111-8111-111111111111";

function fakeCron() {
  const calls = [];
  return {
    calls,
    validate: () => true,
    schedule(expression, fn, options) {
      const task = { expression, fn, options, stop() {} };
      calls.push(task);
      return task;
    },
  };
}

test.afterEach(async () => resetForTests());

test("Phase 2 master flag defaults false and only explicit true enables it", () => {
  assert.equal(isPhase2Enabled({}), false);
  assert.equal(isPhase2Enabled({ MARKETING_INTELLIGENCE_PHASE2_ENABLED: "false" }), false);
  assert.equal(isPhase2Enabled({ MARKETING_INTELLIGENCE_PHASE2_ENABLED: "TRUE" }), true);
  assert.deepEqual(disabledResult("CREATIVE_SYNC"), {
    skipped: true, status: "DISABLED", reason: "phase2_disabled",
    reasonCode: PHASE2_DISABLED_CODE, action: "CREATIVE_SYNC",
  });
});

test("scheduler configuration validates the master flag and defaults it false", () => {
  assert.deepEqual(validateIntelligenceSchedulerEnvironment({ env: {}, cronLib: fakeCron() }).phase2, {
    enabled: false, configurationSource: "DEFAULT",
  });
  assert.throws(() => validateIntelligenceSchedulerEnvironment({
    env: { MARKETING_INTELLIGENCE_PHASE2_ENABLED: "yes" }, cronLib: fakeCron(),
  }), (error) => error.issues.some((issue) => issue.variable === "MARKETING_INTELLIGENCE_PHASE2_ENABLED"));
});

test("master false prevents every Phase 2 scheduler even when component flags are true", async () => {
  const cron = fakeCron();
  const registry = registerIntelligenceSchedulers({
    env: {
      NODE_ENV: "development",
      MARKETING_INTELLIGENCE_PHASE2_ENABLED: "false",
      MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "true",
      MARKETING_ALERT_HEALTH_SCHEDULER_ENABLED: "true",
      MARKETING_ALERT_PERFORMANCE_SCHEDULER_ENABLED: "true",
      MARKETING_CREATIVE_SYNC_SCHEDULER_ENABLED: "true",
      MARKETING_CREATIVE_SCORE_SCHEDULER_ENABLED: "true",
      MARKETING_RECOMMENDATION_EXPIRY_SCHEDULER_ENABLED: "true",
    },
    cronLib: cron, force: true, log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(registry.config.phase2.enabled, false);
  assert.equal(cron.calls.length, 0);
  assert.deepEqual(await registry.stop(), {
    recommendation: false, alertPerformance: false, alertHealth: false,
    creativeSync: false, creativeScore: false, recommendationExpiry: false, fullEvaluation: false,
  });
});

test("default operational services return stable disabled results without touching Prisma", async () => {
  const before = process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED;
  process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED = "false";
  try {
    const results = await Promise.all([
      creativeSync.syncCreatives({}), creativeScoring.scoreCreatives({}),
      recommendationEvaluation.evaluate({}), alertEvaluation.evaluate({}),
      recommendationExpiry.evaluate({}), fullEvaluation.evaluate({}),
    ]);
    assert.deepEqual(results.map((item) => item.status), Array(6).fill("DISABLED"));
    assert.equal(results.every((item) => item.reasonCode === PHASE2_DISABLED_CODE), true);
  } finally {
    if (before === undefined) delete process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED;
    else process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED = before;
  }
});

test("manual Phase 2 middleware blocks with a stable code and allows explicit enablement", () => {
  const before = process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED;
  let observed;
  process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED = "false";
  requirePhase2Enabled({ method: "POST", baseUrl: "/api/v1/marketing/intelligence", path: "/creatives/score" }, null, (error) => { observed = error; });
  assert.equal(observed.code, PHASE2_DISABLED_CODE);
  assert.equal(observed.statusCode, 503);
  process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED = "true";
  observed = "not-called";
  requirePhase2Enabled({}, null, (error) => { observed = error; });
  assert.equal(observed, undefined);
  if (before === undefined) delete process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED;
  else process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED = before;
});

test("Phase 1 campaign synchronization remains independent of master false", () => {
  const prior = {
    master: process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED,
    sync: process.env.MARKETING_INTELLIGENCE_SYNC_ENABLED,
    node: process.env.NODE_ENV,
  };
  process.env.MARKETING_INTELLIGENCE_PHASE2_ENABLED = "false";
  process.env.MARKETING_INTELLIGENCE_SYNC_ENABLED = "true";
  process.env.NODE_ENV = "development";
  const cron = fakeCron();
  try {
    assert.ok(phase1Cron.registerMarketingIntelligenceCron({ cronLib: cron, aggregationService: {}, prisma: {}, force: true }));
    assert.equal(cron.calls.length, 1);
  } finally {
    phase1Cron.resetForTests();
    for (const [key, value] of Object.entries({ MARKETING_INTELLIGENCE_PHASE2_ENABLED: prior.master, MARKETING_INTELLIGENCE_SYNC_ENABLED: prior.sync, NODE_ENV: prior.node })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("route gating leaves reads, settings, provider setup, validation and Phase 1 sync available", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/modules/marketing/intelligence/intelligence.routes.js"), "utf8");
  for (const route of ["/creatives/score", "/creatives/sync", "/recommendations/evaluate", "/alerts/evaluate", "/experiments/:id/start"]) {
    const escaped = route.replace(/[/:]/g, (character) => character === "/" ? "\\/" : "[:]");
    assert.match(source, new RegExp(`"${escaped}"[\\s\\S]{0,180}requirePhase2Enabled`));
  }
  for (const route of ["/settings", "/provider-validation", "/connections", "/sync"]) {
    const block = source.slice(source.indexOf(`"${route}"`), source.indexOf(`"${route}"`) + 220);
    assert.doesNotMatch(block, /requirePhase2Enabled/);
  }
});

test("approved bootstrap defaults are canonical and secondary consumers cannot drift", () => {
  const expected = {
    attributionWindowDays: 30, recommendationLookbackDays: 14, comparisonLookbackDays: 14,
    creativeMinimumImpressions: 1000, minimumClicks: 30, minimumSignups: 3, minimumPayments: 3,
    underperformThresholdPct: "0.30", scaleThresholdPct: "0.20", creativeFatigueThresholdPct: "0.25",
    maximumRecommendedScalePct: "0.20", alertCooldownMinutes: 1440,
    recommendationEvaluationEnabled: false, alertEvaluationEnabled: false,
    creativeSyncEnabled: false, llmCommentaryEnabled: false,
    targetCpa: null, minimumSpend: null, defaultMarketingAssigneeAdminUserId: null,
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(SETTING_REGISTRY[key].default, value, key);
  assert.equal(recommendationSettings.DEFAULTS.recommendationLookbackDays, 14);
  assert.equal(recommendationSettings.DEFAULTS.comparisonLookbackDays, 14);
  assert.equal(recommendationSettings.DEFAULTS.underperformThresholdPct, 0.30);
  assert.equal(recommendationSettings.DEFAULTS.maximumRecommendedScalePct, 0.20);
  assert.equal(recommendationSettings.DEFAULTS.recommendationEvaluationEnabled, false);
  assert.equal(alertSettings.DEFAULTS.alertCooldownMinutes, 1440);
  assert.equal(alertSettings.DEFAULTS.alertEvaluationEnabled, false);
});

test("live-validation invocation requires every explicit safety boundary", () => {
  const validArgs = parseArgs(["--confirm-live", "--platform=META", `--connection-id=${UUID}`, "--from=2026-07-01", "--to=2026-07-02", "--account=act_123"]);
  const validEnv = { NODE_ENV: "development", MARKETING_LIVE_VALIDATION_ENABLED: "true" };
  assert.equal(validateInvocation({ args: validArgs, env: validEnv }).platform, "META");
  const cases = [
    [{ ...validEnv, NODE_ENV: "test" }, validArgs, "LIVE_VALIDATION_FORBIDDEN_IN_TEST"],
    [{ NODE_ENV: "development" }, validArgs, "LIVE_VALIDATION_FLAG_REQUIRED"],
    [validEnv, { ...validArgs, confirmLive: false }, "LIVE_CONFIRMATION_REQUIRED"],
    [validEnv, { ...validArgs, platform: "UNKNOWN" }, "INVALID_PLATFORM"],
    [validEnv, { ...validArgs, connectionId: "bad" }, "INVALID_CONNECTION_ID"],
    [validEnv, { ...validArgs, to: "2026-07-20" }, "INVALID_DATE_RANGE"],
  ];
  for (const [env, args, code] of cases) assert.throws(() => validateInvocation({ args, env }), (error) => error instanceof LiveValidationSafetyError && error.code === code);
});

test("controlled live validation uses only injected read adapters and returns sanitized bounded evidence", async () => {
  const calls = [];
  const connection = { id: UUID, platform: "META", accountId: "act_123", status: "ACTIVE", currency: "EUR" };
  const connector = {
    async fetchCreativeCatalog() { calls.push("catalog"); return { items: [{ sourceKey: "stable-1" }], nextCursor: null }; },
    async fetchCreativeInsights() { calls.push("insights"); return { rows: [{ sourceKey: "metric-1" }], nextCursor: "next" }; },
  };
  const result = await runLiveValidation({ platform: "META", connectionId: UUID, account: "act_123", from: "2026-07-01", to: "2026-07-02" }, {
    loadConnection: async () => { calls.push("connection"); return connection; },
    testConnection: async () => { calls.push("test"); return { success: true }; },
    getConnector: () => connector,
  });
  assert.deepEqual(calls.sort(), ["catalog", "catalog", "connection", "insights", "test"].sort());
  assert.equal(result.boundedFetch, "PASSED");
  assert.equal(result.stableCreativeIds, "PASSED");
  assert.deepEqual(result.normalizedRows, { catalog: 1, insights: 1 });
  assert.doesNotMatch(JSON.stringify(result), /authorization|access.?token|refresh.?token|rawResponse/i);
});

test("WP0-WP12 architecture reconciliation and five-provider artifacts are complete", () => {
  const architecture = fs.readFileSync(path.join(DOCS, "CosmicForge_Marketing_Intelligence_Phase2_Complete_Architecture.md"), "utf8");
  for (let index = 0; index <= 12; index += 1) assert.match(architecture, new RegExp(`\\bWP${index}\\b`));
  for (const platform of ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]) assert.match(architecture, new RegExp(`\\b${platform}\\b`));
  assert.doesNotMatch(architecture, /model\s+(Forecast|AttributionTouch|LLMRecommendation)/i);
  assert.equal((architecture.match(/```mermaid/g) || []).length, 14);
});

test("release documentation and sanitized machine-readable status artifacts exist", () => {
  const required = [
    "CosmicForge_Marketing_Intelligence_Phase2_Release_Runbook.md",
    "CosmicForge_Marketing_Intelligence_Phase2_Live_Validation_Matrix.md",
    "CosmicForge_Marketing_Intelligence_Phase2_Final_Acceptance_Checklist.md",
    "marketing-intelligence-phase2-live-validation-status.json",
  ];
  for (const name of required) assert.ok(fs.statSync(path.join(DOCS, name)).size > 100, name);
  const status = JSON.parse(fs.readFileSync(path.join(DOCS, required[3]), "utf8"));
  assert.equal(Object.keys(status.platforms).length, 5);
  assert.doesNotMatch(JSON.stringify(status), /authorization|access.?token|refresh.?token|client.?secret|rawResponse/i);
});

test("DOCX is a non-empty OOXML archive and canonical Task sample contains no invented priority", () => {
  const docx = fs.readFileSync(path.join(DOCS, "CosmicForge_Marketing_Intelligence_Phase2_Complete_Architecture.docx"));
  assert.equal(docx.subarray(0, 2).toString(), "PK");
  const archiveText = docx.toString("latin1");
  assert.match(archiveText, /\[Content_Types\]\.xml/);
  assert.match(archiveText, /word\/document\.xml/);
  const architecture = fs.readFileSync(path.join(DOCS, "CosmicForge_Marketing_Intelligence_Phase2_Complete_Architecture.md"), "utf8");
  const sample = architecture.match(/Task conversion request[\s\S]*?```json([\s\S]*?)```/i)?.[1] || "";
  assert.match(sample, /assigneeAdminUserId/);
  assert.match(sample, /2026-07-25T17:00:00\.000Z/);
  assert.doesNotMatch(sample, /priority/);
});
