const { prisma } = require("../../../../shared/config/database");
const { createSyncLock } = require("../aggregation/sync-lock");
const { createRunLedgerService } = require("../run-ledger.service");
const { requireOperationActor } = require("../actor-validation");
const { createCreativeSettingsService } = require("./creative-settings.service");
const { aggregateMetrics, determineSufficiency, serializeMetrics } = require("./creative-metrics.service");
const { computeScore } = require("./creative-scoring.rules");
const { evaluateFatigue } = require("./creative-fatigue.service");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { assertUuid } = require("../validation-security");
const { EVENTS, logEvent } = require("../observability");

const CREATIVE_SCORE_LOCK_KEY = "marketing:intelligence:creative-score";
const RULE_VERSION = "creative-score-v1";

function utcDay(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value) : utcDay(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function dateOnly(value) {
  return value.toISOString().slice(0, 10);
}

function completeWindowEnd(until) {
  if (until) return utcDay(until);
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}

function windows(settings, until, since) {
  const analysisEnd = completeWindowEnd(until);
  const analysisStart = since ? utcDay(since) : addDays(analysisEnd, -(settings.creativeAnalysisWindowDays - 1));
  const comparisonEnd = addDays(analysisStart, -1);
  const comparisonStart = addDays(comparisonEnd, -(settings.creativeComparisonWindowDays - 1));
  const fatigueRecentEnd = analysisEnd;
  const fatigueRecentStart = addDays(fatigueRecentEnd, -(settings.creativeFatigueRecentWindowDays - 1));
  const fatigueComparisonEnd = addDays(fatigueRecentStart, -1);
  const fatigueComparisonStart = addDays(fatigueComparisonEnd, -(settings.creativeFatigueComparisonWindowDays - 1));
  return { analysisStart, analysisEnd, comparisonStart, comparisonEnd, fatigueRecentStart, fatigueRecentEnd, fatigueComparisonStart, fatigueComparisonEnd };
}

function within(rows, start, end) {
  return rows.filter((row) => {
    const date = new Date(row.date);
    return date >= start && date <= end;
  });
}

function failure(error, creativeAssetId) {
  return { creativeAssetId, status: "FAILED", errorCode: String(error.code || "CREATIVE_SCORE_FAILED").slice(0, 100), sanitizedMessage: sanitizeProviderText(String(error.message || "Creative score failed")).slice(0, 500) };
}

function createCreativeScoringService({
  prisma: db = prisma,
  settingsService,
  syncLock,
  runLedger,
  log,
} = {}) {
  const settingsResolver = settingsService || createCreativeSettingsService({ prisma: db });
  const lock = syncLock || createSyncLock({ prisma: db });
  const ledger = runLedger || createRunLedgerService({ prisma: db });

  async function scoreCreative(asset, allAssets, until, since) {
    const resolved = await settingsResolver.resolveSettings({ platform: asset.platform, connectionId: asset.connectionId });
    const settings = resolved.values;
    if (!settings.creativeScoringEnabled) return { creativeAssetId: asset.id, status: "SKIPPED_DISABLED" };
    const selectedWindows = windows(settings, until, since);
    const earliest = [selectedWindows.comparisonStart, selectedWindows.fatigueComparisonStart].sort((a, b) => a - b)[0];
    const rows = await db.marketing_creative_performance_snapshots.findMany({
      where: { creativeAssetId: asset.id, date: { gte: earliest, lte: selectedWindows.analysisEnd } },
      orderBy: { date: "asc" },
    });
    const analysisMetrics = aggregateMetrics(within(rows, selectedWindows.analysisStart, selectedWindows.analysisEnd), { primaryGoal: settings.creativePrimaryCpaGoal });
    const comparisonMetrics = aggregateMetrics(within(rows, selectedWindows.comparisonStart, selectedWindows.comparisonEnd), { primaryGoal: settings.creativePrimaryCpaGoal });
    const sufficiency = determineSufficiency(analysisMetrics, settings);

    const candidates = [];
    for (const peerAsset of allAssets) {
      try {
        const peerRows = peerAsset.id === asset.id
          ? rows
          : await db.marketing_creative_performance_snapshots.findMany({
            where: { creativeAssetId: peerAsset.id, date: { gte: selectedWindows.analysisStart, lte: selectedWindows.analysisEnd } },
          });
        candidates.push({ asset: peerAsset, metrics: aggregateMetrics(peerRows, { primaryGoal: settings.creativePrimaryCpaGoal }) });
      } catch (_peerError) {
        // A malformed/unavailable peer must not prevent scoring the target.
        // Its exclusion is visible through the reduced peer count/basis.
      }
    }
    const calculated = computeScore({ asset, metrics: analysisMetrics, comparisonMetrics, candidates, sufficiency, settings });
    const previousScore = await db.marketing_creative_score_snapshots.findFirst({
      // A settings/rule rerun for the same reporting window is not a new
      // scheduled fatigue evaluation and must not advance a streak.
      where: {
        creativeAssetId: asset.id,
        analysisWindowEnd: { lt: selectedWindows.analysisEnd },
      },
      orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
    });
    const fatigueRecent = aggregateMetrics(within(rows, selectedWindows.fatigueRecentStart, selectedWindows.fatigueRecentEnd), { primaryGoal: settings.creativePrimaryCpaGoal });
    const fatigueComparison = aggregateMetrics(within(rows, selectedWindows.fatigueComparisonStart, selectedWindows.fatigueComparisonEnd), { primaryGoal: settings.creativePrimaryCpaGoal });
    const fatigue = evaluateFatigue({ recent: fatigueRecent, comparison: fatigueComparison, settings, previousScore });
    const effectiveRuleVersion = `${RULE_VERSION}:${resolved.fingerprint.slice(0, 12)}`;
    const unique = {
      creativeAssetId: asset.id,
      analysisWindowStart: selectedWindows.analysisStart,
      analysisWindowEnd: selectedWindows.analysisEnd,
      ruleVersion: effectiveRuleVersion,
    };
    const existing = await db.marketing_creative_score_snapshots.findUnique({
      where: { creativeAssetId_analysisWindowStart_analysisWindowEnd_ruleVersion: unique },
    });
    if (existing) return { creativeAssetId: asset.id, status: "REUSED", score: existing };
    const created = await db.marketing_creative_score_snapshots.create({
      data: {
        ...unique,
        comparisonWindowStart: selectedWindows.comparisonStart,
        comparisonWindowEnd: selectedWindows.comparisonEnd,
        score: calculated.score,
        dataSufficiency: sufficiency,
        fatigueStatus: fatigue.status,
        components: {
          values: calculated.components,
          peerBasis: calculated.peerBasis,
          peerCount: calculated.peerCount,
          availableWeight: calculated.availableWeight,
          weightsRenormalized: calculated.weightsRenormalized,
          metadataModifier: calculated.metadataModifier,
        },
        evidence: {
          metrics: serializeMetrics(analysisMetrics),
          evidenceStrength: calculated.evidenceStrength,
          invalidSettings: resolved.invalidSettings,
          settingSources: resolved.sources,
          fatigue: fatigue.evidence,
          fatigueWindows: {
            recentStart: dateOnly(selectedWindows.fatigueRecentStart), recentEnd: dateOnly(selectedWindows.fatigueRecentEnd),
            comparisonStart: dateOnly(selectedWindows.fatigueComparisonStart), comparisonEnd: dateOnly(selectedWindows.fatigueComparisonEnd),
          },
          reasonCodes: sufficiency === "INSUFFICIENT" ? ["INSUFFICIENT_VOLUME"] : [],
        },
        ruleVersion: effectiveRuleVersion,
        settingsVersion: resolved.fingerprint,
        generatedAt: new Date(),
      },
    });
    return { creativeAssetId: asset.id, status: "CREATED", score: created };
  }

  async function scoreCreatives({ platform, connectionIds, creativeAssetIds, since, until, trigger = "INTERNAL", requestedByAdminUserId } = {}) {
    const operationStartedAt = Date.now();
    await requireOperationActor(db, { trigger, requestedByAdminUserId });
    let run = await ledger.startRun({ runType: "SCORE", status: "STARTED", trigger, requestedByAdminUserId, startedAt: new Date() });
    const owner = await lock.acquire(CREATIVE_SCORE_LOCK_KEY);
    if (!owner) {
      await ledger.finishRun(run?.id, { status: "SKIPPED_LOCKED", summary: { reasonCode: "LOCK_UNAVAILABLE", lockScope: CREATIVE_SCORE_LOCK_KEY } });
      return { skipped: true, reason: "creative_score_already_running", ...(run?.id ? { runId: run.id } : {}) };
    }
    let heartbeat;
    const results = [];
    try {
      await ledger.updateRun?.(run?.id, { lockKey: CREATIVE_SCORE_LOCK_KEY, lockOwner: owner });
      heartbeat = lock.startHeartbeat({ key: CREATIVE_SCORE_LOCK_KEY, owner });
      const where = {
        ...(platform && platform !== "all" ? { platform } : {}),
        ...(connectionIds?.length ? { connectionId: { in: connectionIds } } : {}),
        ...(creativeAssetIds?.length ? { id: { in: creativeAssetIds } } : {}),
      };
      const assets = await db.marketing_creative_assets.findMany({ where, orderBy: { id: "asc" } });
      for (const asset of assets) {
        try {
          results.push(await scoreCreative(asset, assets, until, since));
        } catch (error) {
          results.push(failure(error, asset.id));
        }
        if (heartbeat.failed()) break;
      }
      const createdCount = results.filter((item) => item.status === "CREATED").length;
      const reusedCount = results.filter((item) => item.status === "REUSED").length;
      const failedCount = results.filter((item) => item.status === "FAILED").length;
      const successCount = createdCount + reusedCount + results.filter((item) => item.status === "SKIPPED_DISABLED").length;
      const status = heartbeat.failed() ? "LOCK_RENEWAL_FAILED"
        : failedCount === 0 ? "SUCCEEDED"
          : successCount > 0 ? "PARTIAL_SUCCESS" : "FAILED";
      await ledger.finishRun(run?.id, {
        status,
        processedCount: results.length,
        createdCount,
        updatedCount: 0,
        succeededCount: successCount,
        failedCount,
        summary: { reusedCount, results: results.map((item) => ({ creativeAssetId: item.creativeAssetId, status: item.status, errorCode: item.errorCode })) },
        ...(heartbeat.failed() ? { errorCode: "LOCK_RENEWAL_FAILED", sanitizedError: heartbeat.lastError()?.message } : {}),
      });
      const completedScores = results.map((item) => item.score).filter(Boolean);
      const countBy = (field, value) => completedScores.filter((score) => score?.[field] === value).length;
      logEvent(EVENTS.CREATIVE_SCORING_COMPLETED, {
        runId: run?.id || null, platform: platform || "all", connectionId: connectionIds?.length === 1 ? connectionIds[0] : null,
        creativesEvaluated: results.length,
        sufficiencyStrong: countBy("dataSufficiency", "STRONG"), sufficiencyLimited: countBy("dataSufficiency", "LIMITED"), sufficiencyInsufficient: countBy("dataSufficiency", "INSUFFICIENT"),
        fatigueNone: countBy("fatigueStatus", "NONE"), fatigueWatch: countBy("fatigueStatus", "WATCH"), fatigueFatigued: countBy("fatigueStatus", "FATIGUED"), fatigueRecovered: countBy("fatigueStatus", "RECOVERED"),
        ruleVersion: RULE_VERSION, durationMs: Date.now() - operationStartedAt, status,
      }, { log, level: status === "FAILED" ? "error" : "info" });
      return { skipped: false, status, createdCount, reusedCount, failedCount, results, runId: run?.id || null };
    } catch (error) {
      await ledger.finishRun(run?.id, {
        status: "FAILED",
        errorCode: error.code || "CREATIVE_SCORE_FAILED",
        sanitizedError: error.message,
        summary: { processedCount: results.length },
      }).catch(() => {});
      throw error;
    } finally {
      heartbeat?.stop();
      await lock.release(CREATIVE_SCORE_LOCK_KEY, owner).catch(() => {});
    }
  }

  async function listScores(creativeAssetId, { page = 1, limit = 25 } = {}) {
    assertUuid(creativeAssetId, "creativeId");
    const [total, items] = await Promise.all([
      db.marketing_creative_score_snapshots.count({ where: { creativeAssetId } }),
      db.marketing_creative_score_snapshots.findMany({ where: { creativeAssetId }, orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async function latestScore(creativeAssetId) {
    assertUuid(creativeAssetId, "creativeId");
    return db.marketing_creative_score_snapshots.findFirst({ where: { creativeAssetId }, orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
  }

  return { scoreCreatives, scoreCreative, listScores, latestScore };
}

const defaultService = createCreativeScoringService();
const { runPhase2Operation } = require("../phase2-feature");
module.exports = {
  CREATIVE_SCORE_LOCK_KEY, RULE_VERSION, windows, createCreativeScoringService,
  scoreCreatives: (...args) => runPhase2Operation("CREATIVE_SCORING", () => defaultService.scoreCreatives(...args)),
  listScores: defaultService.listScores,
  latestScore: defaultService.latestScore,
};
