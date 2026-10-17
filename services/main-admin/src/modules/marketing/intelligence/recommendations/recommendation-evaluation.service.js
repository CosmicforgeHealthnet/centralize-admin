const { prisma } = require("../../../../shared/config/database");
const { createSyncLock } = require("../aggregation/sync-lock");
const { createRunLedgerService } = require("../run-ledger.service");
const { requireOperationActor } = require("../actor-validation");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { createRecommendationSettingsService } = require("./recommendation-settings.service");
const { buildCampaignInputs } = require("./recommendation-input.service");
const { evaluateCampaign, evaluateReallocation } = require("./recommendation-rules");
const { createRecommendationRepository } = require("./recommendation.repository");
const { EVENTS, logEvent } = require("../observability");

const RECOMMENDATION_LOCK_KEY = "marketing:intelligence:recommendations";
const utcDay = (value) => new Date(`${value}T00:00:00.000Z`);
const addDays = (date, days) => { const copy = new Date(date); copy.setUTCDate(copy.getUTCDate() + days); return copy; };
const day = (date) => date.toISOString().slice(0, 10);

function windows(settings, from, to) {
  const today = new Date();
  const defaultEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const analysisEnd = to ? utcDay(to) : defaultEnd;
  const analysisStart = from ? utcDay(from) : addDays(analysisEnd, -(settings.recommendationLookbackDays - 1));
  const comparisonEnd = addDays(analysisStart, -1);
  const comparisonStart = addDays(comparisonEnd, -(settings.comparisonLookbackDays - 1));
  return { analysisStart, analysisEnd, comparisonStart, comparisonEnd };
}

function periodBucket(window, bucketDays) {
  const epochDay = Math.floor(window.analysisStart.getTime() / 86400000);
  const bucket = Math.floor(epochDay / Math.max(1, bucketDays));
  return `${bucket}:${day(window.analysisStart)}/${day(window.analysisEnd)}`;
}

function createRecommendationEvaluationService({ prisma: db = prisma, settingsService, syncLock, runLedger, inputBuilder = buildCampaignInputs, log } = {}) {
  const settingsResolver = settingsService || createRecommendationSettingsService({ prisma: db });
  const lock = syncLock || createSyncLock({ prisma: db });
  const ledger = runLedger || createRunLedgerService({ prisma: db });
  const repository = createRecommendationRepository({ prisma: db });

  async function evaluate({ platform = "all", connectionId, from, to, ruleTypes, trigger = "INTERNAL", requestedByAdminUserId } = {}) {
    const operationStartedAt = Date.now();
    await requireOperationActor(db, { trigger, requestedByAdminUserId });
    let run = await ledger.startRun({ runType: "RECOMMEND", status: "STARTED", trigger, requestedByAdminUserId, platform: platform === "all" ? undefined : platform, connectionId });
    const owner = await lock.acquire(RECOMMENDATION_LOCK_KEY);
    if (!owner) {
      await ledger.finishRun(run?.id, { status: "SKIPPED_LOCKED", summary: { reasonCode: "LOCK_UNAVAILABLE", lockScope: RECOMMENDATION_LOCK_KEY } });
      return { skipped: true, reason: "recommendation_evaluation_already_running", runId: run?.id || null };
    }
    let heartbeat;
    const results = [];
    const failures = [];
    try {
      const resolved = await settingsResolver.resolveSettings({ platform: platform === "all" ? undefined : platform, connectionId });
      const selected = windows(resolved.values, from, to);
      await ledger.updateRun?.(run?.id, { windowStart: selected.analysisStart, windowEnd: selected.analysisEnd, lockKey: RECOMMENDATION_LOCK_KEY, lockOwner: owner });
      heartbeat = lock.startHeartbeat({ key: RECOMMENDATION_LOCK_KEY, owner });
      if (connectionId && !resolved.values.recommendationEvaluationEnabled) {
        await ledger.finishRun(run?.id, { status: "SUCCEEDED", summary: { disabled: true } });
        return { status: "DISABLED", results: [] };
      }
      const inputs = await inputBuilder({ db, ...selected, platform, connectionId, settings: resolved.values });
      const bucket = periodBucket(selected, resolved.values.recommendationPeriodBucketDays);
      const candidates = [];
      const skippedRules = [];
      const scopedSettings = new Map();
      for (const input of inputs) {
        if (heartbeat.failed()) break;
        try {
          const scoped = await settingsResolver.resolveSettings({ platform: input.platform, connectionId: input.connectionId, currencyCode: input.currencyCode });
          scopedSettings.set(`${input.platform}|${input.connectionId || ""}|${input.currencyCode || ""}`, scoped.values);
          if (!scoped.values.recommendationEvaluationEnabled) {
            skippedRules.push({ ruleCode: "ALL", campaignExternalId: input.campaignExternalId, reasonCodes: ["RECOMMENDATION_EVALUATION_DISABLED"] });
            continue;
          }
          const evaluated = evaluateCampaign(input, scoped.values, bucket);
          candidates.push(...evaluated);
        } catch (error) {
          failures.push({ campaignExternalId: input.campaignExternalId, code: String(error.code || "RECOMMENDATION_RULE_FAILED").slice(0, 100), message: sanitizeProviderText(error.message).slice(0, 500) });
        }
      }
      for (const [contextKey, contextSettings] of scopedSettings) {
        try {
          const [groupPlatform, groupConnectionId, groupCurrency] = contextKey.split("|");
          const compatibleInputs = inputs.filter((input) => input.platform === groupPlatform && (input.connectionId || "") === groupConnectionId && (input.currencyCode || "") === groupCurrency);
          candidates.push(...evaluateReallocation(compatibleInputs, contextSettings, bucket, { onSkip: (reason) => skippedRules.push(reason) }));
        }
        catch (error) { failures.push({ rule: "REALLOCATE_BUDGET", code: "RECOMMENDATION_RULE_FAILED", message: sanitizeProviderText(error.message).slice(0, 500) }); }
      }
      const allowed = ruleTypes?.length ? new Set(ruleTypes) : null;
      const filtered = allowed ? candidates.filter((candidate) => allowed.has(candidate.type)) : candidates;
      const activeKeys = new Set();
      const now = new Date();
      const expiresAt = addDays(selected.analysisEnd, resolved.values.recommendationExpiryDays);
      for (const candidate of filtered) {
        if (heartbeat.failed()) break;
        try {
          const saved = await repository.persist(candidate, { analysisStart: selected.analysisStart, analysisEnd: selected.analysisEnd, expiresAt, now });
          activeKeys.add(saved.dedupeKey);
          results.push({ id: saved.id, type: saved.type, status: saved.status, dedupeKey: saved.dedupeKey, persistenceAction: saved.persistenceAction });
        } catch (error) {
          failures.push({ campaignExternalId: candidate.targetCampaignExternalId, ruleCode: candidate.ruleCode, code: String(error.code || "RECOMMENDATION_PERSIST_FAILED").slice(0, 100), message: sanitizeProviderText(error.message).slice(0, 500) });
        }
      }
      const expired = heartbeat.failed() ? { count: 0 } : await repository.expireUnseen({ activeKeys, platform, connectionId, now, recoveryEvaluations: resolved.values.recommendationRecoveryEvaluations, staleDays: resolved.values.recommendationEvidenceStaleDays });
      const status = heartbeat.failed() ? "LOCK_RENEWAL_FAILED" : failures.length ? (results.length ? "PARTIAL_SUCCESS" : "FAILED") : "SUCCEEDED";
      await ledger.finishRun(run?.id, { status, processedCount: inputs.length, succeededCount: results.length, failedCount: failures.length, summary: { generated: results.length, expired: expired.count, skippedRuleCount: Math.max(0, inputs.length * 4 - filtered.length), skippedRules, invalidSettings: resolved.invalidSettings }, ...(heartbeat.failed() ? { errorCode: "LOCK_RENEWAL_FAILED", sanitizedError: heartbeat.lastError()?.message } : {}) });
      const countByType = (action) => Object.fromEntries([...new Set(results.filter((item) => item.persistenceAction === action).map((item) => item.type))].sort().map((type) => [type, results.filter((item) => item.persistenceAction === action && item.type === type).length]));
      logEvent(EVENTS.RECOMMENDATIONS_EVALUATED, {
        runId: run?.id || null, platform, connectionId: connectionId || null, campaignsEvaluated: inputs.length,
        createdTotal: results.filter((item) => item.persistenceAction === "CREATED").length,
        updatedTotal: results.filter((item) => item.persistenceAction === "UPDATED").length,
        expiredTotal: expired.count, skippedTotal: Math.max(0, inputs.length * 4 - filtered.length),
        createdByType: countByType("CREATED"), updatedByType: countByType("UPDATED"), expiredByReason: {},
        durationMs: Date.now() - operationStartedAt, status,
      }, { log, level: status === "FAILED" ? "error" : "info" });
      return { status, runId: run?.id || null, analysisWindow: { from: day(selected.analysisStart), to: day(selected.analysisEnd) }, settingsVersion: resolved.fingerprint, results, failures, skippedRules, expiredCount: expired.count };
    } catch (error) {
      await ledger.finishRun(run?.id, { status: "FAILED", failedCount: 1, sanitizedError: error.message });
      throw error;
    } finally {
      heartbeat?.stop();
      await lock.release(RECOMMENDATION_LOCK_KEY, owner);
    }
  }
  return { evaluate };
}

const service = createRecommendationEvaluationService();
const { runPhase2Operation } = require("../phase2-feature");
module.exports = {
  RECOMMENDATION_LOCK_KEY, windows, periodBucket, createRecommendationEvaluationService,
  evaluate: (...args) => runPhase2Operation("RECOMMENDATION_EVALUATION", () => service.evaluate(...args)),
};
