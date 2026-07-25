const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Prisma } = require("../../../../generated/admin-client");
const { DEFAULTS: BOOTSTRAP_DEFAULTS, validateSetting, createRecommendationSettingsService } = require("../recommendations/recommendation-settings.service");
const { calculateConfidence } = require("../recommendations/recommendation-confidence");
const { evaluateCampaign, evaluateReallocation, recommendationKey, materialFingerprint } = require("../recommendations/recommendation-rules");
const { createRecommendationRepository } = require("../recommendations/recommendation.repository");
const { createRecommendationLifecycleService } = require("../recommendations/recommendation-lifecycle.service");
const { recommendationEvaluateSchema } = require("../recommendations/recommendation.validator");
const { serializeIntelligenceResponse } = require("../response-serializer");
const DEFAULTS = Object.freeze({
  ...BOOTSTRAP_DEFAULTS,
  recommendationEvaluationEnabled: true,
  targetCpa: 25,
  minimumSpend: 25,
});

const D = (value) => new Prisma.Decimal(String(value));
function input(overrides = {}) {
  return {
    platform: "META", connectionId: "11111111-1111-4111-8111-111111111111", accountExternalId: "acct", campaignExternalId: "campaign-a", campaignName: "Campaign A", campaignObjective: "PATIENT_ACQUISITION", currencyCode: "EUR", currencyCompatible: true,
    analysisWindowStart: "2026-07-01", analysisWindowEnd: "2026-07-07", comparisonWindowStart: "2026-06-24", comparisonWindowEnd: "2026-06-30", windowComplete: true,
    spend: D(200), impressions: 5000n, clicks: 100n, internalConversions: 10n, attributedPayments: 10n, netRevenue: D(600), ctr: D("0.02"), cpc: D(2), conversionRate: D("0.1"), cpa: D(20), roas: D(3),
    activeDataDays: 7, conditionDays: 7, trendConsistent: true, dataCompleteness: 1, dataSufficiency: "STRONG", persistenceEvaluations: 3, performanceDeteriorating: false, connectionIssue: false, attributionDefinition: "INTERNAL_LAST_TOUCH_PAYMENT",
    creativeCount: 4, eligibleCreativeCount: 4, averageCreativeScore: 70, medianCreativeScore: 70, weakCreativeCount: 0, weakCreativePct: 0, fatiguedCreativeCount: 0, creativeTypes: ["IMAGE", "VIDEO"], missingFormats: [],
    ...overrides,
  };
}

test("recommendation settings use connection, platform, global, then defaults and record invalid values", async () => {
  const rows = [
    { id: "g", key: "targetCpa", scopeType: "GLOBAL", currencyCode: "EUR", valueJson: { value: 30 }, version: 1 },
    { id: "p", key: "targetCpa", scopeType: "PLATFORM", platform: "META", currencyCode: "EUR", valueJson: { value: -1 }, version: 2 },
    { id: "c", key: "targetCpa", scopeType: "CONNECTION", connectionId: "c1", currencyCode: "EUR", valueJson: { value: 20 }, version: 3 },
  ];
  const service = createRecommendationSettingsService({ prisma: { marketing_intelligence_settings: { findMany: async () => rows } } });
  const resolved = await service.resolveSettings({ platform: "META", connectionId: "c1", currencyCode: "EUR" });
  assert.equal(resolved.values.targetCpa, 20);
  const fallback = await service.resolveSettings({ platform: "META", connectionId: "other", currencyCode: "EUR" });
  assert.equal(fallback.values.targetCpa, 30);
  assert.equal(fallback.invalidSettings[0].settingId, "p");
  assert.throws(() => validateSetting("scaleThresholdPct", 25), /ratio/);
});

test("target-dependent recommendation rules skip when monetary settings are unavailable", () => {
  const unavailable = { ...BOOTSTRAP_DEFAULTS, targetCpa: null, minimumSpend: null };
  const rows = evaluateCampaign(input({ cpa: D(50) }), unavailable, "bucket");
  assert.equal(rows.some((item) => ["PAUSE_CPA_TARGET_BREACH", "SCALE_CPA_OUTPERFORMANCE"].includes(item.ruleCode)), false);
  const skipped = [];
  assert.deepEqual(evaluateReallocation([input({ cpa: D(50) }), input({ campaignExternalId: "b", cpa: D(10) })], unavailable, "bucket", { onSkip: (reason) => skipped.push(reason) }), []);
  assert.deepEqual(skipped[0].reasonCodes, ["SETTING_MONETARY_VALUE_UNAVAILABLE"]);
});

test("confidence uses the exact four weighted components and clamps target distance", () => {
  const result = calculateConfidence({ input: input(), settings: DEFAULTS, targetDistance: 5, persistenceEvaluations: 5 });
  assert.equal(result.confidence.toString(), "1");
  assert.match(result.components.formula, /0\.40.*0\.30.*0\.20.*0\.10/);
  const oneDay = calculateConfidence({ input: input({ conditionDays: 1 }), settings: DEFAULTS, targetDistance: 0, persistenceEvaluations: 1 });
  assert.ok(oneDay.confidence.lt(result.confidence));
});

test("confidence components are independently normalized and persisted in recommendation evidence", () => {
  const recommendation = evaluateCampaign(input({ cpa: D(50), dataCompleteness: 0.85 }), DEFAULTS, "bucket").find((row) => row.ruleCode === "PAUSE_CPA_TARGET_BREACH");
  assert.ok(recommendation);
  assert.deepEqual(Object.keys(recommendation.evidence.confidenceComponents), ["sampleSufficiency", "multiDayConsistency", "targetDistance", "dataCompleteness", "formula"]);
  for (const key of ["sampleSufficiency", "multiDayConsistency", "targetDistance", "dataCompleteness"]) assert.ok(Number(recommendation.evidence.confidenceComponents[key]) >= 0 && Number(recommendation.evidence.confidenceComponents[key]) <= 1);
});

test("PAUSE requires a strict CPA breach and stable sufficient same-currency evidence", () => {
  const boundary = DEFAULTS.targetCpa * (1 + DEFAULTS.underperformThresholdPct);
  assert.equal(evaluateCampaign(input({ cpa: D(boundary) }), DEFAULTS, "bucket").filter((row) => row.type === "PAUSE").length, 0);
  const rows = evaluateCampaign(input({ cpa: D(boundary + 1) }), DEFAULTS, "bucket");
  const pause = rows.find((row) => row.ruleCode === "PAUSE_CPA_TARGET_BREACH");
  assert.ok(pause);
  assert.equal(pause.suggestedAction.requiresManualApproval, true);
  assert.equal(evaluateCampaign(input({ cpa: D(boundary + 1), currencyCode: null }), DEFAULTS, "bucket").some((row) => row.type === "PAUSE"), false);
  assert.equal(evaluateCampaign(input({ cpa: D(boundary + 1), conditionDays: 1 }), DEFAULTS, "bucket").some((row) => row.type === "PAUSE"), false);
  assert.equal(evaluateCampaign(input({ cpa: D(boundary + 1), connectionIssue: true }), DEFAULTS, "bucket").length, 0);
});

test("spend without conversion requires persistence and internal conversions", () => {
  const candidate = input({ cpa: null, internalConversions: 0n, attributedPayments: 0n, spend: D(150), persistenceEvaluations: 2 });
  assert.ok(evaluateCampaign(candidate, DEFAULTS, "bucket").some((row) => row.ruleCode === "PAUSE_SPEND_WITHOUT_CONVERSION"));
  assert.equal(evaluateCampaign({ ...candidate, persistenceEvaluations: 1 }, DEFAULTS, "bucket").some((row) => row.ruleCode === "PAUSE_SPEND_WITHOUT_CONVERSION"), false);
});

test("SCALE requires STRONG stable evidence and produces a calculated bounded percentage", () => {
  const scale = evaluateCampaign(input({ cpa: D(10) }), DEFAULTS, "bucket").find((row) => row.type === "SCALE");
  assert.ok(scale);
  assert.ok(scale.suggestedAction.suggestedScalePct >= 5 && scale.suggestedAction.suggestedScalePct <= DEFAULTS.maximumRecommendedScalePct * 100);
  assert.equal(evaluateCampaign(input({ cpa: D(10), dataSufficiency: "SUFFICIENT" }), DEFAULTS, "bucket").some((row) => row.type === "SCALE"), false);
  assert.equal(evaluateCampaign(input({ cpa: D(DEFAULTS.targetCpa * (1 - DEFAULTS.scaleThresholdPct)), roas: null }), DEFAULTS, "bucket").some((row) => row.type === "SCALE"), false);
  const capped = evaluateCampaign(input({ cpa: D("0.01") }), { ...DEFAULTS, maximumRecommendedScalePct: 0.09 }, "bucket").find((row) => row.type === "SCALE");
  assert.equal(capped.suggestedAction.suggestedScalePct, 9);
  assert.equal(evaluateCampaign(input({ cpa: D(10), trendConsistent: false }), DEFAULTS, "bucket").some((row) => row.type === "SCALE"), false);
});

test("REALLOCATE requires matching objective, currency, connection, platform, attribution and window", () => {
  const source = input({ campaignExternalId: "source", cpa: D(50), dataSufficiency: "SUFFICIENT" });
  const destination = input({ campaignExternalId: "destination", cpa: D(10) });
  const rows = evaluateReallocation([source, destination], DEFAULTS, "bucket");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].suggestedAction.suggestedReallocationPct, DEFAULTS.defaultReallocationPct);
  assert.equal(evaluateReallocation([source, { ...destination, currencyCode: "USD" }], DEFAULTS, "bucket").length, 0);
  assert.equal(evaluateReallocation([source, { ...destination, campaignObjective: "AWARENESS" }], DEFAULTS, "bucket").length, 0);
  assert.equal(evaluateReallocation([source, { ...destination, analysisWindowStart: "2026-07-02" }], DEFAULTS, "bucket").length, 0);
  const capped = evaluateReallocation([source, destination], { ...DEFAULTS, defaultReallocationPct: 80, maximumRecommendedReallocationPct: 12 }, "bucket")[0];
  assert.equal(capped.suggestedAction.suggestedReallocationPct, 12);
  const skipped = [];
  assert.equal(evaluateReallocation([source, { ...destination, currencyCode: "USD" }], DEFAULTS, "bucket", { onSkip: (reason) => skipped.push(reason) }).length, 0);
  assert.ok(skipped[0].reasonCodes.includes("CURRENCY_MISMATCH"));
});

test("CREATE_CONTENT can use LIMITED inventory evidence but not insufficient data", () => {
  const limited = input({ dataSufficiency: "LIMITED", eligibleCreativeCount: 1, creativeCount: 1, missingFormats: ["VIDEO"] });
  const recommendation = evaluateCampaign(limited, DEFAULTS, "bucket").find((row) => row.type === "CREATE_CONTENT");
  assert.ok(recommendation);
  assert.deepEqual(recommendation.suggestedAction.recommendedFormats, ["VIDEO"]);
  assert.equal(evaluateCampaign({ ...limited, dataSufficiency: "INSUFFICIENT" }, DEFAULTS, "bucket").length, 0);
});

test("dedupe keys use canonical explicit identities and period buckets", () => {
  const a = recommendationKey({ ruleCode: "PAUSE_CPA_TARGET_BREACH", input: input(), periodBucket: "1:2026-07-01/2026-07-07" });
  const b = recommendationKey({ periodBucket: "1:2026-07-01/2026-07-07", input: input(), ruleCode: "PAUSE_CPA_TARGET_BREACH" });
  const c = recommendationKey({ ruleCode: "PAUSE_CPA_TARGET_BREACH", input: input(), periodBucket: "2:2026-07-08/2026-07-14" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("repository updates PENDING but preserves terminal recommendations", async () => {
  const rows = [];
  const db = { marketing_recommendations: {
    findUnique: async ({ where }) => rows.find((row) => row.dedupeKey === where.dedupeKey) || null,
    create: async ({ data }) => { const row = { id: `r${rows.length}`, createdAt: new Date(), ...data }; rows.push(row); return row; },
    update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); Object.assign(row, data); return row; },
  } };
  const repo = createRecommendationRepository({ prisma: db });
  const candidate = evaluateCampaign(input({ cpa: D(50) }), DEFAULTS, "bucket").find((row) => row.type === "PAUSE");
  const first = await repo.persist(candidate, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date() });
  const originalCreatedAt = first.createdAt;
  const second = await repo.persist({ ...candidate, reasoning: "updated" }, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date() });
  assert.equal(rows.length, 1);
  assert.equal(second.reasoning, "updated");
  assert.equal(second.createdAt, originalCreatedAt);
  second.status = "ACCEPTED";
  const terminalSnapshot = { status: second.status, evidence: JSON.stringify(second.evidence), reasoning: second.reasoning, confidence: second.confidence.toString(), createdAt: second.createdAt };
  await repo.persist({ ...candidate, materialEvidenceFingerprint: "different" }, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date() });
  assert.equal(rows.length, 2);
  assert.deepEqual({ status: rows[0].status, evidence: JSON.stringify(rows[0].evidence), reasoning: rows[0].reasoning, confidence: rows[0].confidence.toString(), createdAt: rows[0].createdAt }, terminalSnapshot);
});

test("material fingerprint ignores volatile timestamps and changes for material evidence", () => {
  const evidence = { observed: "40", target: "25", boundary: "31.25", spend: "100", conversions: "2", currencyCode: "EUR", evaluatedAt: "2026-07-01" };
  assert.equal(materialFingerprint("PAUSE_CPA_TARGET_BREACH", evidence), materialFingerprint("PAUSE_CPA_TARGET_BREACH", { ...evidence, evaluatedAt: "2026-07-02" }));
  assert.notEqual(materialFingerprint("PAUSE_CPA_TARGET_BREACH", evidence), materialFingerprint("PAUSE_CPA_TARGET_BREACH", { ...evidence, observed: "41" }));
});

test("dismissed reconsideration requires a new bucket or material evidence and never reopens history", async () => {
  const rows = [];
  const db = { marketing_recommendations: {
    findUnique: async ({ where }) => rows.find((row) => row.dedupeKey === where.dedupeKey) || null,
    create: async ({ data }) => { const row = { id: `r${rows.length + 1}`, createdAt: new Date(), ...data }; rows.push(row); return row; },
    update: async ({ where, data }) => Object.assign(rows.find((row) => row.id === where.id), data),
  } };
  const repo = createRecommendationRepository({ prisma: db });
  const firstCandidate = evaluateCampaign(input({ cpa: D(50) }), DEFAULTS, "bucket-1").find((row) => row.type === "PAUSE");
  const first = await repo.persist(firstCandidate, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date(Date.now() + 1000) });
  first.status = "DISMISSED";
  await repo.persist(firstCandidate, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date(Date.now() + 1000) });
  assert.equal(rows.length, 1);
  await repo.persist({ ...firstCandidate, materialEvidenceFingerprint: "changed" }, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date(Date.now() + 1000) });
  assert.equal(rows.length, 2);
  const nextBucket = evaluateCampaign(input({ cpa: D(50) }), DEFAULTS, "bucket-2").find((row) => row.type === "PAUSE");
  await repo.persist(nextBucket, { analysisStart: new Date(), analysisEnd: new Date(), expiresAt: new Date(Date.now() + 1000) });
  assert.equal(rows.length, 3);
  assert.equal(first.status, "DISMISSED");
});

test("recommendation expiration is consecutive, reasoned, idempotent, and terminal-safe", async () => {
  const rows = [
    { id: "pending", status: "PENDING", dedupeKey: "missing", recoveryStreak: 0, lastEvaluatedAt: new Date("2026-07-18"), expiresAt: new Date("2026-07-30"), evidence: { observed: "40" } },
    { id: "due", status: "PENDING", dedupeKey: "due", recoveryStreak: 0, expiresAt: new Date("2026-07-18"), evidence: { observed: "50" } },
    { id: "accepted", status: "ACCEPTED", dedupeKey: "accepted", recoveryStreak: 0, expiresAt: new Date("2026-07-18"), evidence: { observed: "60" } },
  ];
  const db = { marketing_recommendations: {
    findMany: async () => rows.filter((row) => row.status === "PENDING"),
    update: async ({ where, data }) => Object.assign(rows.find((row) => row.id === where.id), data),
  } };
  const repo = createRecommendationRepository({ prisma: db });
  const now = new Date("2026-07-19T00:00:00Z");
  assert.equal((await repo.expireUnseen({ activeKeys: new Set(), now, recoveryEvaluations: 2, staleDays: 14 })).count, 1);
  assert.equal(rows[0].status, "PENDING"); assert.equal(rows[0].recoveryStreak, 1);
  assert.equal(rows[1].expirationReason, "EXPIRES_AT_PASSED"); assert.deepEqual(rows[1].evidence, { observed: "50" });
  assert.equal((await repo.expireUnseen({ activeKeys: new Set(), now, recoveryEvaluations: 2, staleDays: 14 })).count, 1);
  assert.equal(rows[0].status, "EXPIRED"); assert.equal(rows[0].expirationReason, "CONDITION_NO_LONGER_HOLDS");
  assert.equal(rows[2].status, "ACCEPTED");
  assert.equal((await repo.expireUnseen({ activeKeys: new Set(), now, recoveryEvaluations: 2, staleDays: 14 })).count, 0);
});

test("lifecycle enforces PENDING transitions and equivalent idempotency", async () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const adminId = "33333333-3333-4333-8333-333333333333";
  const rows = [{ id: firstId, type: "PAUSE", status: "PENDING" }, { id: secondId, type: "SCALE", status: "PENDING" }];
  const audits = [];
  const db = { marketing_recommendations: {
    findUnique: async ({ where }) => rows.find((row) => row.id === where.id) || null,
    update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); Object.assign(row, data); return row; },
  }, auditLog: { create: async ({ data }) => { audits.push(data); return data; } } };
  const service = createRecommendationLifecycleService({ prisma: db });
  assert.equal((await service.accept(firstId, adminId)).status, "ACCEPTED");
  assert.equal((await service.accept(firstId, adminId)).status, "ACCEPTED");
  assert.equal((await service.dismiss(secondId, adminId, "not now")).status, "DISMISSED");
  await assert.rejects(() => service.dismiss(firstId, adminId, "x"), /Invalid recommendation lifecycle/);
  assert.equal(audits.length, 2); assert.equal(audits[0].metadata.previousStatus, "PENDING"); assert.equal(audits[0].adminUserId, adminId);
});

test("evaluation validator bounds dates and recommendation routes use VIEW/EDIT", () => {
  assert.equal(recommendationEvaluateSchema.safeParse({ platform: "all", from: "2026-07-01", to: "2026-07-07" }).success, true);
  assert.equal(recommendationEvaluateSchema.safeParse({ platform: "all", from: "2026-07-08", to: "2026-07-07" }).success, false);
  const routes = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  assert.match(routes, /"\/recommendations"[\s\S]*?"VIEW"/);
  assert.match(routes, /"\/recommendations\/evaluate"[\s\S]*?"EDIT"/);
});

test("Section 10 source contains no alert creation or provider write", () => {
  const root = path.join(__dirname, "../recommendations");
  const source = fs.readdirSync(root).filter((file) => file.endsWith(".js")).map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /marketing_alerts\.(create|upsert)|updateCampaign|pauseCampaign|provider.*write/i);
});

test("Section 10-13 API serializer removes Prisma, BigInt, and Date runtime objects recursively", () => {
  const serialized = serializeIntelligenceResponse({ confidence: D("0.8125"), count: 7n, at: new Date("2026-07-19T00:00:00Z"), nested: [{ spend: D("12.30") }] });
  assert.deepEqual(serialized, { confidence: "0.8125", count: "7", at: "2026-07-19T00:00:00.000Z", nested: [{ spend: "12.3" }] });
  assert.doesNotThrow(() => JSON.stringify(serialized));
});
