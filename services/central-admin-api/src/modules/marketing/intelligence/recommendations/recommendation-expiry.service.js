const { prisma } = require("../../../../shared/config/database");
const { createSyncLock } = require("../aggregation/sync-lock");
const { createRunLedgerService } = require("../run-ledger.service");
const { createRecommendationSettingsService } = require("./recommendation-settings.service");
const { createRecommendationRepository } = require("./recommendation.repository");
const { sanitizeProviderText } = require("../connectors/provider-http");

const RECOMMENDATION_EXPIRY_LOCK_KEY = "marketing:intelligence:recommendation-expiry";

function createRecommendationExpiryService({ prisma: db = prisma, settingsService, syncLock, runLedger } = {}) {
  const settings = settingsService || createRecommendationSettingsService({ prisma: db });
  const lock = syncLock || createSyncLock({ prisma: db });
  const ledger = runLedger || createRunLedgerService({ prisma: db });
  const repository = createRecommendationRepository({ prisma: db });
  async function evaluate({ platform, connectionId, trigger = "INTERNAL", requestedByAdminUserId } = {}) {
    let run = await ledger.startRun({ runType: "RECOMMEND", status: "STARTED", trigger, requestedByAdminUserId, platform, connectionId, summary: { operation: "EXPIRY" } });
    const owner = await lock.acquire(RECOMMENDATION_EXPIRY_LOCK_KEY);
    if (!owner) {
      await ledger.finishRun(run?.id, { status: "SKIPPED_LOCKED", summary: { operation: "EXPIRY", reasonCode: "LOCK_UNAVAILABLE", lockScope: RECOMMENDATION_EXPIRY_LOCK_KEY } });
      return { skipped: true, status: "SKIPPED_LOCKED", reason: "recommendation_expiry_already_running", runId: run?.id || null };
    }
    let heartbeat;
    try {
      await ledger.updateRun?.(run?.id, { lockKey: RECOMMENDATION_EXPIRY_LOCK_KEY, lockOwner: owner });
      heartbeat = lock.startHeartbeat({ key: RECOMMENDATION_EXPIRY_LOCK_KEY, owner });
      const resolved = await settings.resolveSettings({ platform, connectionId });
      const expired = await repository.expireUnseen({ activeKeys: new Set(), platform: platform || "all", connectionId, now: new Date(), recoveryEvaluations: resolved.values.recommendationRecoveryEvaluations, staleDays: resolved.values.recommendationEvidenceStaleDays });
      const status = heartbeat.failed() ? "LOCK_RENEWAL_FAILED" : "SUCCEEDED";
      await ledger.finishRun(run?.id, { status, updatedCount: expired.count, succeededCount: expired.count, summary: { operation: "EXPIRY", expired: expired.count, settingsFingerprint: resolved.fingerprint }, ...(heartbeat.failed() ? { errorCode: "LOCK_RENEWAL_FAILED", sanitizedError: heartbeat.lastError()?.message } : {}) });
      return { skipped: false, status, expiredCount: expired.count, settingsFingerprint: resolved.fingerprint };
    } catch (error) {
      await ledger.finishRun(run?.id, { status: "FAILED", failedCount: 1, errorCode: "RECOMMENDATION_EXPIRY_FAILED", sanitizedError: sanitizeProviderText(error.message) }).catch(() => {});
      throw error;
    } finally {
      heartbeat?.stop();
      await lock.release(RECOMMENDATION_EXPIRY_LOCK_KEY, owner).catch(() => {});
    }
  }
  return { evaluate };
}

const service = createRecommendationExpiryService();
const { runPhase2Operation } = require("../phase2-feature");
module.exports = {
  RECOMMENDATION_EXPIRY_LOCK_KEY, createRecommendationExpiryService,
  evaluate: (...args) => runPhase2Operation("RECOMMENDATION_EXPIRY", () => service.evaluate(...args)),
};
