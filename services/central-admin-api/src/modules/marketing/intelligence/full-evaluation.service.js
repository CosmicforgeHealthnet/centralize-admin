const { prisma } = require("../../../shared/config/database");
const { createSyncLock } = require("./aggregation/sync-lock");
const { createRunLedgerService } = require("./run-ledger.service");
const { createSettingsService } = require("./settings.service");
const creativeSyncService = require("./creative/creative-sync.service");
const creativeScoringService = require("./creative/creative-scoring.service");
const recommendationService = require("./recommendations/recommendation-evaluation.service");
const alertService = require("./alerts/alert-evaluation.service");
const expiryService = require("./recommendations/recommendation-expiry.service");
const { sanitizeProviderText } = require("./connectors/provider-http");
const { sanitizeSummary } = require("./run-query.service");
const { requireOperationActor } = require("./actor-validation");

const FULL_EVALUATION_LOCK_KEY = "marketing:intelligence:full-evaluation";

function statusOf(result) { return result?.status || (result?.skipped ? "SKIPPED_LOCKED" : "SUCCEEDED"); }
function succeeded(status) { return ["SUCCEEDED", "PARTIAL_SUCCESS", "DISABLED"].includes(status); }

function createFullEvaluationService({ prisma: db = prisma, syncLock, runLedger, settingsService, creativeSync = creativeSyncService, creativeScoring = creativeScoringService, recommendations = recommendationService, alerts = alertService, expiry = expiryService } = {}) {
  const lock = syncLock || createSyncLock({ prisma: db });
  const ledger = runLedger || createRunLedgerService({ prisma: db });
  const settings = settingsService || createSettingsService({ prisma: db });
  async function evaluate({ trigger = "INTERNAL", requestedByAdminUserId } = {}) {
    await requireOperationActor(db, { trigger, requestedByAdminUserId });
    let run = await ledger.startRun({ runType: "FULL_EVALUATION", status: "STARTED", trigger, requestedByAdminUserId });
    const owner = await lock.acquire(FULL_EVALUATION_LOCK_KEY);
    if (!owner) {
      await ledger.finishRun(run?.id, { status: "SKIPPED_LOCKED", summary: { reasonCode: "LOCK_UNAVAILABLE", lockScope: FULL_EVALUATION_LOCK_KEY } });
      return { skipped: true, status: "SKIPPED_LOCKED", reason: "full_evaluation_already_running", runId: run?.id || null };
    }
    let heartbeat; const steps = {}; const platforms = {}; const failures = [];
    try {
      await ledger.updateRun?.(run?.id, { lockKey: FULL_EVALUATION_LOCK_KEY, lockOwner: owner });
      heartbeat = lock.startHeartbeat({ key: FULL_EVALUATION_LOCK_KEY, owner });
      const connections = await db.marketing_ad_platform_connections.findMany({ where: { status: "ACTIVE" }, orderBy: [{ platform: "asc" }, { id: "asc" }] });
      const snapshots = [];
      for (const connection of connections) {
        const resolved = await settings.resolveSettings({ platform: connection.platform, connectionId: connection.id, currencyCode: connection.currency });
        snapshots.push({ connectionId: connection.id, platform: connection.platform, fingerprint: resolved.fingerprint, toggles: { creativeSyncEnabled: resolved.values.creativeSyncEnabled, recommendationEvaluationEnabled: resolved.values.recommendationEvaluationEnabled, alertEvaluationEnabled: resolved.values.alertEvaluationEnabled } });
        platforms[connection.platform] ||= { status: "SUCCEEDED", connections: 0, skipped: 0, failed: 0 };
        platforms[connection.platform].connections += 1;
      }
      const execute = async (name, fn) => {
        if (heartbeat.failed()) throw new Error("lock owner lost during full evaluation");
        try { const result = await fn(); steps[name] = { status: statusOf(result), result: sanitizeSummary(result) }; return result; }
        catch (error) { const failure = { step: name, code: String(error.code || `${name.toUpperCase()}_FAILED`).slice(0, 100), message: sanitizeProviderText(error.message).slice(0, 500) }; failures.push(failure); steps[name] = { status: "FAILED", errorCode: failure.code }; return null; }
      };
      const creativeIds = snapshots.filter((item) => item.toggles.creativeSyncEnabled).map((item) => item.connectionId);
      await execute("creativeSync", () => creativeSync.syncCreatives({ connectionIds: creativeIds, trigger: "FULL_EVALUATION", settingsSnapshot: snapshots }));
      await execute("creativeScoring", () => creativeScoring.scoreCreatives({ trigger: "FULL_EVALUATION", settingsSnapshot: snapshots }));
      for (const snapshot of snapshots.filter((item) => item.toggles.recommendationEvaluationEnabled)) await execute(`recommendations:${snapshot.connectionId}`, () => recommendations.evaluate({ platform: snapshot.platform, connectionId: snapshot.connectionId, trigger: "FULL_EVALUATION", settingsSnapshot: snapshot }));
      for (const snapshot of snapshots.filter((item) => item.toggles.alertEvaluationEnabled)) await execute(`alerts:${snapshot.connectionId}`, () => alerts.evaluate({ platform: snapshot.platform, connectionId: snapshot.connectionId, trigger: "FULL_EVALUATION", settingsSnapshot: snapshot }));
      await execute("recommendationExpiry", () => expiry.evaluate({ trigger: "FULL_EVALUATION", settingsSnapshot: snapshots }));
      for (const snapshot of snapshots) if (!snapshot.toggles.creativeSyncEnabled && !snapshot.toggles.recommendationEvaluationEnabled && !snapshot.toggles.alertEvaluationEnabled) platforms[snapshot.platform].skipped += 1;
      const successful = Object.values(steps).filter((step) => succeeded(step.status)).length;
      const status = heartbeat.failed() ? "LOCK_RENEWAL_FAILED" : failures.length ? (successful ? "PARTIAL_SUCCESS" : "FAILED") : "SUCCEEDED";
      const summary = sanitizeSummary({ settingsSnapshot: snapshots, steps, platforms, failures });
      await ledger.finishRun(run?.id, { status, processedCount: connections.length, succeededCount: successful, failedCount: failures.length, skippedCount: snapshots.filter((item) => !item.toggles.creativeSyncEnabled && !item.toggles.recommendationEvaluationEnabled && !item.toggles.alertEvaluationEnabled).length, summary, ...(heartbeat.failed() ? { errorCode: "LOCK_RENEWAL_FAILED", sanitizedError: heartbeat.lastError()?.message } : {}) });
      return { skipped: false, status, runId: run?.id || null, steps, platforms, failures, settingsSnapshot: snapshots };
    } catch (error) {
      await ledger.finishRun(run?.id, { status: "FAILED", failedCount: 1, errorCode: "FULL_EVALUATION_FAILED", sanitizedError: sanitizeProviderText(error.message), summary: sanitizeSummary({ steps, platforms, failures }) }).catch(() => {});
      throw error;
    } finally {
      heartbeat?.stop();
      await lock.release(FULL_EVALUATION_LOCK_KEY, owner).catch(() => {});
    }
  }
  return { evaluate };
}

const service = createFullEvaluationService();
const { runPhase2Operation } = require("./phase2-feature");
module.exports = {
  FULL_EVALUATION_LOCK_KEY, createFullEvaluationService,
  evaluate: (...args) => runPhase2Operation("FULL_EVALUATION", () => service.evaluate(...args)),
};
