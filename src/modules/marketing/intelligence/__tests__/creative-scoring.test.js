const test = require("node:test");
const assert = require("node:assert/strict");
const { Prisma } = require("../../../../generated/admin-client");
const { DEFAULTS, createCreativeSettingsService } = require("../creative/creative-settings.service");
const { aggregateMetrics, determineSufficiency } = require("../creative/creative-metrics.service");
const { buildPeerGroup, normalizeComponent, metadataModifier, computeScore } = require("../creative/creative-scoring.rules");
const { evaluateFatigue } = require("../creative/creative-fatigue.service");
const { createCreativeScoringService, CREATIVE_SCORE_LOCK_KEY } = require("../creative/creative-scoring.service");
const fs = require("node:fs");
const path = require("node:path");

function setting(id, key, scopeType, valueJson, extra = {}) {
  return { id, key, scopeType, valueJson, valueType: typeof valueJson === "boolean" ? "BOOLEAN" : Number.isInteger(valueJson) ? "INTEGER" : "DECIMAL", version: 1, ...extra };
}

test("creative settings resolve connection, platform, global, then defaults with a stable fingerprint", async () => {
  const rows = [
    setting("g", "creativeAnalysisWindowDays", "GLOBAL", 20),
    setting("p", "creativeAnalysisWindowDays", "PLATFORM", 14, { platform: "META" }),
    setting("c", "creativeAnalysisWindowDays", "CONNECTION", 7, { connectionId: "connection-1" }),
  ];
  const service = createCreativeSettingsService({ prisma: { marketing_intelligence_settings: { findMany: async () => rows } } });
  const first = await service.resolveSettings({ platform: "META", connectionId: "connection-1" });
  const second = await service.resolveSettings({ platform: "META", connectionId: "connection-1" });
  assert.equal(first.values.creativeAnalysisWindowDays, 7);
  assert.equal(first.sources.creativeAnalysisWindowDays.scopeType, "CONNECTION");
  assert.equal(first.values.creativeFatigueRecentWindowDays, 7);
  assert.equal(first.fingerprint, second.fingerprint);
});

test("invalid scoped settings fall through safely and invalid weight sets use defaults", async () => {
  const weightKeys = ["creativeCtrWeight", "creativeCpcWeight", "creativeConversionRateWeight", "creativeCpaWeight", "creativeRoasWeight", "creativeTrendWeight"];
  const rows = [
    setting("bad", "creativeAnalysisWindowDays", "CONNECTION", -5, { connectionId: "connection-1" }),
    setting("platform", "creativeAnalysisWindowDays", "PLATFORM", 14, { platform: "META" }),
    ...weightKeys.map((key, index) => setting(`w${index}`, key, "GLOBAL", 0)),
    setting("pct", "creativeFatigueThresholdPct", "CONNECTION", 25, { connectionId: "connection-1" }),
  ];
  const service = createCreativeSettingsService({ prisma: { marketing_intelligence_settings: { findMany: async () => rows } } });
  const result = await service.resolveSettings({ platform: "META", connectionId: "connection-1" });
  assert.equal(result.values.creativeAnalysisWindowDays, 14);
  assert.equal(result.values.creativeCtrWeight, DEFAULTS.creativeCtrWeight);
  assert.equal(result.values.creativeFatigueThresholdPct, DEFAULTS.creativeFatigueThresholdPct);
  assert.ok(result.invalidSettings.some((item) => item.settingId === "bad"));
  assert.ok(result.invalidSettings.some((item) => item.key === "creativeWeights"));
});

test("invalid sufficiency threshold ordering falls back as one coherent threshold set", async () => {
  const rows = [
    setting("i", "creativeMinimumImpressionsInsufficient", "GLOBAL", 900),
    setting("l", "creativeMinimumImpressionsLimited", "GLOBAL", 500),
    setting("s", "creativeMinimumImpressionsSufficient", "GLOBAL", 1000),
  ];
  const service = createCreativeSettingsService({ prisma: { marketing_intelligence_settings: { findMany: async () => rows } } });
  const result = await service.resolveSettings({ platform: "META", connectionId: "connection-1" });
  assert.equal(result.values.creativeMinimumImpressionsInsufficient, DEFAULTS.creativeMinimumImpressionsInsufficient);
  assert.equal(result.values.creativeMinimumImpressionsLimited, DEFAULTS.creativeMinimumImpressionsLimited);
  assert.ok(result.invalidSettings.some((item) => /thresholds/.test(item.reason)));
});

test("metrics use exact internal truth, null zero denominators, and reject mixed money aggregation", () => {
  const rows = [{
    date: new Date("2026-07-01T00:00:00Z"), currencyCode: "USD", spend: new Prisma.Decimal("10.50"), revenue: new Prisma.Decimal("21.00"),
    impressions: 1000n, reach: 800n, clicks: 50n, providerConversions: new Prisma.Decimal("12.5"), attributedSignups: 8n, attributedPayments: 5n,
    metadata: { revenueSource: "INTERNAL_ATTRIBUTED" },
  }];
  const metrics = aggregateMetrics(rows, { primaryGoal: "PAYMENT" });
  assert.equal(metrics.ctr.toString(), "0.05");
  assert.equal(metrics.cpc.toString(), "0.21");
  assert.equal(metrics.cpm.toString(), "10.5");
  assert.equal(metrics.conversionRate.toString(), "0.1");
  assert.equal(metrics.cpa.toString(), "2.1");
  assert.equal(metrics.roas.toString(), "2");
  assert.equal(metrics.goalCount, 5n);
  assert.equal(metrics.providerConversions.toString(), "12.5");

  const zero = aggregateMetrics([{ ...rows[0], spend: null, revenue: null, impressions: 0n, clicks: 0n, attributedPayments: null }]);
  assert.equal(zero.ctr, null);
  assert.equal(zero.cpc, null);
  assert.equal(zero.cpa, null);
  assert.equal(zero.roas, null);

  const mixed = aggregateMetrics([rows[0], { ...rows[0], currencyCode: "EUR" }]);
  assert.equal(mixed.currencyCompatible, false);
  assert.equal(mixed.spend, null);
  assert.equal(mixed.cpc, null);

  const incomplete = aggregateMetrics([rows[0], { ...rows[0], spend: null, impressions: null }]);
  assert.equal(incomplete.spend, null);
  assert.equal(incomplete.impressions, null);
  assert.equal(incomplete.ctr, null);
});

test("sufficiency precedence handles every boundary without provider-conversion promotion", () => {
  const base = { ...DEFAULTS, creativeSpendMandatory: false };
  const metrics = (impressions, clicks, spend, goals) => ({ impressions: BigInt(impressions), clicks: BigInt(clicks), spend: spend === null ? null : new Prisma.Decimal(spend), goalCount: BigInt(goals) });
  assert.equal(determineSufficiency(metrics(499, 100, "100", 20), base), "INSUFFICIENT");
  assert.equal(determineSufficiency(metrics(500, 10, "1", 0), base), "LIMITED");
  assert.equal(determineSufficiency(metrics(1000, 30, "25", 4), base), "SUFFICIENT");
  assert.equal(determineSufficiency(metrics(1000, 30, "25", 5), base), "STRONG");
  assert.equal(determineSufficiency(metrics(1000, 30, null, 5), base), "STRONG");
  assert.equal(determineSufficiency({ ...metrics(1000, 30, "25", 0), providerConversions: new Prisma.Decimal(99) }, base), "SUFFICIENT");
  const distinct = { ...base, creativeMinimumImpressionsInsufficient: 100, creativeMinimumClicksInsufficient: 5, creativeMinimumImpressionsLimited: 500, creativeMinimumClicksLimited: 10 };
  assert.equal(determineSufficiency(metrics(499, 9, "1", 0), distinct), "INSUFFICIENT");
});

test("peer grouping chooses compatible hierarchy and excludes format, currency, and grain mismatches", () => {
  const target = { asset: { id: "a", platform: "META", connectionId: "c", accountExternalId: "acct", campaignExternalId: "campaign", type: "IMAGE", metadata: { scoredUnit: "ad" } }, metrics: { currencyCode: "USD" } };
  const campaignPeer = { asset: { ...target.asset, id: "b" }, metrics: { currencyCode: "USD", cpc: new Prisma.Decimal(1) } };
  const wrongType = { asset: { ...target.asset, id: "c", type: "VIDEO" }, metrics: { currencyCode: "USD" } };
  const wrongGrain = { asset: { ...target.asset, id: "d", metadata: { scoredUnit: "asset" } }, metrics: { currencyCode: "USD" } };
  const group = buildPeerGroup(target, [campaignPeer, wrongType, wrongGrain]);
  assert.equal(group.basis, "SAME_CAMPAIGN_TYPE_GRAIN");
  assert.deepEqual(group.peers.map((peer) => peer.asset.id), ["b"]);

  const score = computeScore({
    asset: target.asset,
    metrics: { ctr: new Prisma.Decimal("0.04"), cpc: new Prisma.Decimal("1"), conversionRate: null, cpa: null, roas: null, currencyCode: "USD", activeDays: 7 },
    comparisonMetrics: null,
    candidates: [campaignPeer, { asset: { ...target.asset, id: "e" }, metrics: { currencyCode: "EUR", cpc: new Prisma.Decimal("0.1") } }],
    sufficiency: "LIMITED",
    settings: DEFAULTS,
  });
  assert.equal(score.components.cpc.target, "1");
  assert.equal(score.components.cpc.peerCount, 1);
});

test("normalization caps outliers, handles lower/higher metrics, and score weights renormalize", () => {
  assert.equal(normalizeComponent("1000", "1", "higher").score.toString(), "100");
  assert.equal(normalizeComponent("0.0001", "1", "higher").score.toString(), "0.005");
  assert.equal(normalizeComponent("0", "1", "lower").score.toString(), "100");
  assert.equal(normalizeComponent("10", "1", "lower").score.toString(), "5");
  const asset = { id: "a", platform: "META", connectionId: "c", accountExternalId: "acct", campaignExternalId: "campaign", type: "IMAGE", ctaType: "SHOP_NOW", headline: "h", bodyText: "b", metadata: {} };
  const result = computeScore({ asset, metrics: { ctr: new Prisma.Decimal("0.02"), cpc: null, conversionRate: null, cpa: null, roas: null, currencyCode: null, activeDays: 2 }, comparisonMetrics: null, candidates: [], sufficiency: "LIMITED", settings: DEFAULTS });
  assert.ok(result.score.gte(0) && result.score.lte(100));
  assert.equal(result.weightsRenormalized, true);
  assert.equal(result.evidenceStrength, "LIMITED_COMPONENT_EVIDENCE");
});

test("metadata modifiers are explainable, bounded to five, and disabled for insufficient data", () => {
  const rich = { type: "VIDEO", durationSeconds: 15, ctaType: "BUY", headline: "h", bodyText: "b", hasHumanPresence: true };
  const modifier = metadataModifier(rich, "SUFFICIENT", { ...DEFAULTS, creativeMetadataModifierMaximum: 99 });
  assert.ok(modifier.value.lte(5));
  assert.ok(modifier.reasons.some((reason) => reason.code === "PROVIDER_CONFIRMED_HUMAN_PRESENCE"));
  assert.equal(metadataModifier(rich, "INSUFFICIENT", DEFAULTS).value.toString(), "0");
  assert.equal(metadataModifier({ ...rich, hasHumanPresence: null }, "SUFFICIENT", DEFAULTS).reasons.some((reason) => /HUMAN/.test(reason.code)), false);
});

function fatigueMetrics(overrides = {}) {
  return { impressions: 2000n, clicks: 100n, spend: new Prisma.Decimal(100), currencyCode: "USD", currencyCompatible: true, activeDays: 7, ctr: new Prisma.Decimal("0.02"), cpc: new Prisma.Decimal("1.3"), cpa: new Prisma.Decimal("13"), conversionRate: new Prisma.Decimal("0.07"), ...overrides };
}

test("fatigue requires primary plus confirmation, persistence, and two-step recovery", () => {
  const comparison = fatigueMetrics({ ctr: new Prisma.Decimal("0.04"), cpc: new Prisma.Decimal("1"), cpa: new Prisma.Decimal("10"), conversionRate: new Prisma.Decimal("0.1") });
  const recent = fatigueMetrics();
  const first = evaluateFatigue({ recent, comparison, settings: DEFAULTS, previousScore: null });
  assert.equal(first.status, "WATCH");
  const second = evaluateFatigue({ recent, comparison, settings: DEFAULTS, previousScore: { fatigueStatus: first.status, evidence: { fatigue: first.evidence } } });
  assert.equal(second.status, "FATIGUED");
  const stable = comparison;
  const recovery1 = evaluateFatigue({ recent: stable, comparison, settings: DEFAULTS, previousScore: { fatigueStatus: second.status, evidence: { fatigue: second.evidence } } });
  assert.equal(recovery1.status, "FATIGUED");
  const recovery2 = evaluateFatigue({ recent: stable, comparison, settings: DEFAULTS, previousScore: { fatigueStatus: recovery1.status, evidence: { fatigue: recovery1.evidence } } });
  assert.equal(recovery2.status, "RECOVERED");
  const recovered = evaluateFatigue({ recent: stable, comparison, settings: DEFAULTS, previousScore: { fatigueStatus: recovery2.status, evidence: { fatigue: recovery2.evidence } } });
  assert.equal(recovered.status, "NONE");
});

test("fatigue ignores CTR-only and one-day anomalies; currency mismatch excludes money confirmations", () => {
  const comparison = fatigueMetrics({ ctr: new Prisma.Decimal("0.04"), cpc: new Prisma.Decimal("1"), cpa: new Prisma.Decimal("10"), conversionRate: new Prisma.Decimal("0.1") });
  const ctrOnly = fatigueMetrics({ cpc: new Prisma.Decimal("1"), cpa: new Prisma.Decimal("10"), conversionRate: new Prisma.Decimal("0.1") });
  assert.equal(evaluateFatigue({ recent: ctrOnly, comparison, settings: DEFAULTS }).status, "NONE");
  assert.equal(evaluateFatigue({ recent: { ...fatigueMetrics(), activeDays: 1 }, comparison, settings: DEFAULTS }).evidence.volumeMet, false);
  const mismatch = fatigueMetrics({ currencyCode: "EUR", conversionRate: new Prisma.Decimal("0.07") });
  const result = evaluateFatigue({ recent: mismatch, comparison, settings: DEFAULTS });
  assert.equal(result.evidence.currencyCompatible, false);
  assert.equal(result.evidence.confirmingSignals.cpcIncrease, false);
  assert.equal(result.evidence.confirmingSignals.cpaIncrease, false);
  assert.equal(result.evidence.confirmingSignals.conversionRateDecline, true);
  assert.equal(result.status, "WATCH");
});

test("scoring persists immutable evidence and reuses an unchanged scoring key", async () => {
  const asset = { id: "11111111-1111-4111-8111-111111111111", platform: "META", connectionId: "22222222-2222-4222-8222-222222222222", accountExternalId: "acct", campaignExternalId: "campaign", type: "IMAGE", metadata: { scoredUnit: "ad" } };
  const rows = [
    { date: new Date("2026-07-01T00:00:00Z"), currencyCode: "USD", spend: new Prisma.Decimal(20), revenue: new Prisma.Decimal(40), impressions: 600n, clicks: 20n, attributedSignups: 4n, attributedPayments: 3n, providerConversions: new Prisma.Decimal(10), metadata: { revenueSource: "INTERNAL_ATTRIBUTED" } },
    { date: new Date("2026-07-02T00:00:00Z"), currencyCode: "USD", spend: new Prisma.Decimal(20), revenue: new Prisma.Decimal(40), impressions: 600n, clicks: 20n, attributedSignups: 4n, attributedPayments: 3n, providerConversions: new Prisma.Decimal(10), metadata: { revenueSource: "INTERNAL_ATTRIBUTED" } },
  ];
  let stored = null;
  const previousScoreQueries = [];
  const db = {
    marketing_creative_assets: { findMany: async () => [asset] },
    marketing_creative_performance_snapshots: { findMany: async () => rows },
    marketing_creative_score_snapshots: {
      findFirst: async ({ where }) => {
        previousScoreQueries.push(where);
        return null;
      },
      findUnique: async () => stored,
      create: async ({ data }) => { stored = { id: "score-1", ...data }; return stored; },
    },
  };
  const lock = { acquire: async (key) => { assert.equal(key, CREATIVE_SCORE_LOCK_KEY); return "owner"; }, startHeartbeat: () => ({ failed: () => false, lastError: () => null, stop() {} }), release: async () => true };
  const settingsService = { resolveSettings: async () => ({ values: DEFAULTS, sources: {}, invalidSettings: [], fingerprint: "a".repeat(64) }) };
  const ledger = { startRun: async () => ({ id: "run" }), finishRun: async () => ({}) };
  const service = createCreativeScoringService({ prisma: db, syncLock: lock, settingsService, runLedger: ledger });
  const first = await service.scoreCreatives({ platform: "META", since: "2026-07-01", until: "2026-07-02" });
  const second = await service.scoreCreatives({ platform: "META", since: "2026-07-01", until: "2026-07-02" });
  assert.equal(first.results[0].status, "CREATED");
  assert.equal(second.results[0].status, "REUSED");
  assert.equal(stored.settingsVersion, "a".repeat(64));
  assert.match(stored.ruleVersion, /^creative-score-v1:/);
  assert.ok(stored.evidence.metrics);
  assert.equal(stored.dataSufficiency, "STRONG");
  assert.equal(previousScoreQueries.length, 2);
  assert.equal(previousScoreQueries[0].analysisWindowEnd.lt.toISOString(), "2026-07-02T00:00:00.000Z");
  assert.equal(previousScoreQueries[1].analysisWindowEnd.lt.toISOString(), "2026-07-02T00:00:00.000Z");
});

test("scoring isolates creative failures, sanitizes them, and returns partial success", async () => {
  const assets = [
    { id: "11111111-1111-4111-8111-111111111111", platform: "META", connectionId: "33333333-3333-4333-8333-333333333333", accountExternalId: "a", campaignExternalId: "c", type: "IMAGE", metadata: {} },
    { id: "22222222-2222-4222-8222-222222222222", platform: "META", connectionId: "33333333-3333-4333-8333-333333333333", accountExternalId: "a", campaignExternalId: "c", type: "IMAGE", metadata: {} },
  ];
  const rows = [{ date: new Date("2026-07-01T00:00:00Z"), currencyCode: null, spend: null, revenue: null, impressions: 600n, clicks: 20n, attributedSignups: null, attributedPayments: null, providerConversions: null, metadata: {} }];
  const created = [];
  const db = {
    marketing_creative_assets: { findMany: async () => assets },
    marketing_creative_performance_snapshots: { findMany: async ({ where }) => {
      if (where.creativeAssetId === assets[1].id) throw new Error("Bearer highly-secret-token provider row failed");
      return rows;
    } },
    marketing_creative_score_snapshots: {
      findFirst: async () => null,
      findUnique: async () => null,
      create: async ({ data }) => { const score = { id: `score-${created.length}`, ...data }; created.push(score); return score; },
    },
  };
  const ledgerUpdates = [];
  const service = createCreativeScoringService({
    prisma: db,
    settingsService: { resolveSettings: async () => ({ values: DEFAULTS, sources: {}, invalidSettings: [], fingerprint: "b".repeat(64) }) },
    syncLock: { acquire: async () => "owner", startHeartbeat: () => ({ failed: () => false, lastError: () => null, stop() {} }), release: async () => true },
    runLedger: { startRun: async () => ({ id: "run" }), finishRun: async (_id, data) => ledgerUpdates.push(data) },
  });
  const result = await service.scoreCreatives({ since: "2026-07-01", until: "2026-07-01" });
  assert.equal(result.status, "PARTIAL_SUCCESS");
  assert.equal(result.results[0].status, "CREATED");
  assert.equal(result.results[1].status, "FAILED");
  assert.doesNotMatch(result.results[1].sanitizedMessage, /highly-secret-token/);
  assert.equal(ledgerUpdates.at(-1).failedCount, 1);
});

test("score lock collision skips work and score routes retain VIEW/EDIT authorization", async () => {
  let assetReads = 0;
  const runs = [];
  const finishes = [];
  const service = createCreativeScoringService({
    prisma: { marketing_creative_assets: { findMany: async () => { assetReads += 1; return []; } } },
    settingsService: {},
    syncLock: { acquire: async () => null },
    runLedger: { startRun: async (data) => runs.push(data), finishRun: async (_id, data) => finishes.push(data) },
  });
  assert.deepEqual(await service.scoreCreatives(), { skipped: true, reason: "creative_score_already_running" });
  assert.equal(assetReads, 0);
  assert.equal(runs[0].status, "STARTED");
  assert.equal(finishes[0].status, "SKIPPED_LOCKED");

  const routes = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  assert.match(routes, /"\/creatives\/score"[\s\S]*?"EDIT"/);
  assert.match(routes, /"\/creatives\/:id\/scores\/latest"[\s\S]*?"VIEW"/);
  assert.match(routes, /"\/creatives\/:id\/scores"[\s\S]*?"VIEW"/);
});
