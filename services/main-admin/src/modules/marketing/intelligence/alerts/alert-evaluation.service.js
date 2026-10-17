const { prisma } = require("../../../../shared/config/database");
const { createSyncLock } = require("../aggregation/sync-lock");
const { createRunLedgerService } = require("../run-ledger.service");
const { requireOperationActor } = require("../actor-validation");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { buildCampaignInputs } = require("../recommendations/recommendation-input.service");
const { createRecommendationSettingsService } = require("../recommendations/recommendation-settings.service");
const { createAlertSettingsService } = require("./alert-settings.service");
const { evaluateCampaignAlerts, evaluateConnectionAlerts } = require("./alert-rules");
const { createAlertRepository } = require("./alert.repository");
const { createAlertNotificationAdapter } = require("./alert-notification.adapter");
const { EVENTS, logEvent } = require("../observability");

const ALERT_LOCK_KEYS = Object.freeze({
  all: "marketing:intelligence:alerts",
  health: "marketing:intelligence:alerts:health",
  performance: "marketing:intelligence:alerts:performance",
});
const ALERT_LOCK_KEY = ALERT_LOCK_KEYS.all;
const utcDay = (value) => new Date(`${value}T00:00:00.000Z`);
const addDays = (date, days) => { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; };
const dateKey = (date) => date.toISOString().slice(0, 10);

function evaluationWindows(settings, from, to) {
  const today = new Date();
  const defaultEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const analysisEnd = to ? utcDay(to) : defaultEnd;
  const analysisStart = from ? utcDay(from) : addDays(analysisEnd, -(settings.alertAnalysisWindowDays - 1));
  const comparisonEnd = addDays(analysisStart, -1);
  const comparisonStart = addDays(comparisonEnd, -(settings.alertComparisonWindowDays - 1));
  return { analysisStart, analysisEnd, comparisonStart, comparisonEnd };
}

function cooldownFor(severity, settings) {
  return settings[`alertCooldown${severity[0]}${severity.slice(1).toLowerCase()}Minutes`] ?? settings.alertCooldownMinutes;
}

function createAlertEvaluationService({ prisma: db = prisma, settingsService, recommendationSettingsService, syncLock, runLedger, inputBuilder = buildCampaignInputs, notificationAdapter, log } = {}) {
  const settingsResolver = settingsService || createAlertSettingsService({ prisma: db });
  const recommendationSettings = recommendationSettingsService || createRecommendationSettingsService({ prisma: db });
  const lock = syncLock || createSyncLock({ prisma: db });
  const ledger = runLedger || createRunLedgerService({ prisma: db });
  const repository = createAlertRepository({ prisma: db });
  const delivery = notificationAdapter || createAlertNotificationAdapter({ prisma: db });

  async function evaluate({ platform = "all", connectionId, from, to, types, ruleGroup = "all", trigger = "INTERNAL", requestedByAdminUserId } = {}) {
    const operationStartedAt = Date.now();
    await requireOperationActor(db, { trigger, requestedByAdminUserId });
    const selectedRuleGroup = ["health", "performance"].includes(ruleGroup) ? ruleGroup : "all";
    const lockKey = ALERT_LOCK_KEYS[selectedRuleGroup];
    let run = await ledger.startRun({ runType: "ALERT", status: "STARTED", trigger, requestedByAdminUserId, platform: platform === "all" ? undefined : platform, connectionId, summary: { ruleGroup: selectedRuleGroup } });
    const owner = await lock.acquire(lockKey);
    if (!owner) {
      await ledger.finishRun(run?.id, { status: "SKIPPED_LOCKED", summary: { ruleGroup: selectedRuleGroup, reasonCode: "LOCK_UNAVAILABLE", lockScope: lockKey } });
      return { skipped: true, reason: "alert_evaluation_already_running", runId: run?.id || null };
    }
    let heartbeat;
    const results = []; const failures = []; const deliveries = [];
    try {
      const context = { platform: platform === "all" ? undefined : platform, connectionId };
      const [resolved, recommendationResolved] = await Promise.all([settingsResolver.resolveSettings(context), recommendationSettings.resolveSettings(context)]);
      const settings = { ...recommendationResolved.values, ...resolved.values };
      const selected = evaluationWindows(settings, from, to);
      await ledger.updateRun?.(run?.id, { windowStart: selected.analysisStart, windowEnd: selected.analysisEnd, lockKey, lockOwner: owner });
      heartbeat = lock.startHeartbeat({ key: lockKey, owner });
      if (connectionId && !settings.alertEvaluationEnabled) {
        await ledger.finishRun(run?.id, { status: "SUCCEEDED", summary: { disabled: true } });
        return { status: "DISABLED", results: [] };
      }
      const [campaigns, connections] = await Promise.all([
        selectedRuleGroup === "health" ? [] : inputBuilder({ db, ...selected, platform, connectionId, settings }),
        selectedRuleGroup === "performance" ? [] : db.marketing_ad_platform_connections.findMany({ where: { ...(platform !== "all" ? { platform } : {}), ...(connectionId ? { id: connectionId } : {}), status: { not: "DISABLED" } } }),
      ]);
      const candidates = [];
      for (const campaign of campaigns) {
        if (heartbeat.failed()) break;
        try {
          const [scopedAlert, scopedRecommendation] = await Promise.all([
            settingsResolver.resolveSettings({ platform: campaign.platform, connectionId: campaign.connectionId, currencyCode: campaign.currencyCode }),
            recommendationSettings.resolveSettings({ platform: campaign.platform, connectionId: campaign.connectionId, currencyCode: campaign.currencyCode }),
          ]);
          if (!scopedAlert.values.alertEvaluationEnabled) continue;
          candidates.push(...evaluateCampaignAlerts(campaign, { ...scopedRecommendation.values, ...scopedAlert.values }));
        }
        catch (error) { failures.push({ scope: "campaign", campaignExternalId: campaign.campaignExternalId, code: "ALERT_RULE_FAILED", message: sanitizeProviderText(error.message).slice(0, 500) }); }
      }
      for (const connection of connections) {
        if (heartbeat.failed()) break;
        try {
          const scoped = await settingsResolver.resolveSettings({ platform: connection.platform, connectionId: connection.id, currencyCode: connection.currency });
          if (!scoped.values.alertEvaluationEnabled) continue;
          candidates.push(...evaluateConnectionAlerts(connection, { ...recommendationResolved.values, ...scoped.values }));
        }
        catch (error) { failures.push({ scope: "connection", connectionId: connection.id, code: "ALERT_RULE_FAILED", message: sanitizeProviderText(error.message).slice(0, 500) }); }
      }
      const allowed = types?.length ? new Set(types) : null;
      const filtered = allowed ? candidates.filter((item) => allowed.has(item.type)) : candidates;
      const activeConditionKeys = new Set();
      const now = new Date();
      for (const item of filtered) {
        if (heartbeat.failed()) break;
        activeConditionKeys.add(item.conditionKey);
        try {
          const persisted = await repository.persist(item, { now, cooldownMinutes: cooldownFor(item.severity, settings) });
          results.push({ id: persisted.alert.id, type: persisted.alert.type, severity: persisted.alert.severity, status: persisted.alert.status, created: persisted.created, shouldNotify: persisted.shouldNotify, occurrenceCount: persisted.alert.occurrenceCount });
          if (persisted.shouldNotify) {
            const delivered = await delivery.deliver(persisted.alert, settings);
            const notification = delivered.notifications.at(-1);
            const failure = delivered.reason || delivered.persistenceFailures?.at(-1) || delivered.realtimeFailures.at(-1) || (!delivered.notifications.length ? "NOTIFICATION_PERSISTENCE_FAILED" : null);
            await repository.markDelivery(persisted.alert.id, { notificationId: notification?.id, cooldownMinutes: persisted.cooldownMinutes, deliveredAt: now, failure });
            deliveries.push({ alertId: persisted.alert.id, recipientCount: delivered.recipients.length, notificationCount: delivered.notifications.length, notificationFailureCount: delivered.persistenceFailures?.length || 0, realtimeFailureCount: delivered.realtimeFailures.length });
          }
        } catch (error) {
          failures.push({ type: item.type, conditionKey: item.conditionKey, code: "ALERT_PERSIST_FAILED", message: sanitizeProviderText(error.message).slice(0, 500) });
        }
      }
      const resolvedIds = heartbeat.failed() ? [] : await repository.recoverAbsent({ activeConditionKeys, recoveryEvaluations: settings.alertRecoveryEvaluations, platform, connectionId, types, now });
      const status = heartbeat.failed() ? "LOCK_RENEWAL_FAILED" : failures.length ? (results.length ? "PARTIAL_SUCCESS" : "FAILED") : "SUCCEEDED";
      await ledger.finishRun(run?.id, { status, processedCount: campaigns.length + connections.length, succeededCount: results.length, failedCount: failures.length, createdCount: results.filter((item) => item.created).length, summary: { ruleGroup: selectedRuleGroup, detected: results.length, autoResolved: resolvedIds.length, deliveries, invalidSettings: resolved.invalidSettings }, ...(heartbeat.failed() ? { errorCode: "LOCK_RENEWAL_FAILED", sanitizedError: heartbeat.lastError()?.message } : {}) });
      logEvent(EVENTS.ALERTS_EVALUATED, {
        runId: run?.id || null, ruleGroup: selectedRuleGroup, platform, connectionId: connectionId || null,
        evaluatedTotal: campaigns.length + connections.length, openedTotal: results.filter((item) => item.created).length,
        updatedTotal: results.filter((item) => !item.created).length, resolvedTotal: resolvedIds.length,
        notifiedTotal: deliveries.filter((item) => item.notificationCount > 0).length,
        suppressedTotal: results.filter((item) => !item.shouldNotify).length,
        deliveryFailedTotal: deliveries.reduce((sum, item) => sum + item.notificationFailureCount + item.realtimeFailureCount, 0),
        durationMs: Date.now() - operationStartedAt, status,
      }, { log, level: status === "FAILED" ? "error" : "info" });
      return { status, runId: run?.id || null, ruleGroup: selectedRuleGroup, analysisWindow: { from: dateKey(selected.analysisStart), to: dateKey(selected.analysisEnd) }, settingsVersion: resolved.fingerprint, results, failures, autoResolvedIds: resolvedIds, deliveries };
    } catch (error) {
      await ledger.finishRun(run?.id, { status: "FAILED", failedCount: 1, sanitizedError: sanitizeProviderText(error.message) });
      throw error;
    } finally {
      heartbeat?.stop();
      await lock.release(lockKey, owner);
    }
  }
  return { evaluate };
}

const service = createAlertEvaluationService();
const { runPhase2Operation } = require("../phase2-feature");
module.exports = {
  ALERT_LOCK_KEY, ALERT_LOCK_KEYS, evaluationWindows, cooldownFor, createAlertEvaluationService,
  evaluate: (...args) => runPhase2Operation("ALERT_EVALUATION", () => service.evaluate(...args)),
};
