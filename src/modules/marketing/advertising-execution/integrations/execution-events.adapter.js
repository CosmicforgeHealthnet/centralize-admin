const notifications = require("../../../notifications/notifications.service");
const logger = require("../../../../shared/utils/logger");
const { sanitizeExecutionEvent, STRUCTURED_EVENT_NAMES } = require("../execution.observability");

const EVENT_ALIASES = Object.freeze({
  PLAN_VALIDATED: "marketing_execution.plan_validated", APPROVAL_RECORDED: "marketing_execution.approval_recorded",
  JOB_CLAIMED: "marketing_execution.job_claimed", OPERATION_STARTED: "marketing_execution.operation_started",
  OPERATION_SUCCEEDED: "marketing_execution.operation_succeeded", OPERATION_FAILED: "marketing_execution.operation_failed",
  OPERATION_UNKNOWN: "marketing_execution.operation_unknown", UNKNOWN_OUTCOME: "marketing_execution.operation_unknown",
  RECONCILIATION_DRIFT: "marketing_execution.reconciliation_drift", RECONCILIATION_DRIFTED: "marketing_execution.reconciliation_drift",
  COMPENSATION_QUEUED: "marketing_execution.compensation_queued", KILL_SWITCH_CHANGED: "marketing_execution.kill_switch_changed",
});

function sanitizePayload(payload) { return sanitizeExecutionEvent(payload || {}); }

function createExecutionEventsAdapter({ notificationService = notifications, realtime = null, metrics = null, structuredLogger = logger } = {}) {
  function recordMetric(name, safe) {
    const exact = {
      CREATIVE_REVIEW_CHANGED: "providerReviewStates", TARGETING_RESOLVED: safe.cache === "HIT" ? "targetingCacheHits" : "targetingCacheMisses",
      TARGETING_EXPIRED: "targetingCacheExpiry", TARGETING_DISCOVERY_FAILED: "targetingDiscoveryFailures", LEASE_RECOVERED: "leaseRecoveries",
      HEARTBEAT_FAILED: "heartbeatFailures", JOB_DEAD_LETTERED: "deadLetterCount", UNKNOWN_OUTCOME: "unknownOutcomes",
      LOCAL_PERSISTENCE_FAILURE: "localPersistenceRecovery", RECONCILIATION_QUEUED: "reconciliationQueueDepth",
      RECONCILIATION_VERIFIED: "reconciliationVerified", RECONCILIATION_DRIFTED: "reconciliationDrifted",
      RECONCILIATION_UNKNOWN: "reconciliationUnknown", RECONCILIATION_EXTERNAL_CHANGE: "externalChanges",
      COMPENSATION_COMPLETED: "compensationVerified", COMPENSATION_QUEUED: "compensationQueued", KILL_SWITCH_CHANGED: "killSwitchChanges",
    }[name];
    if (exact) metrics?.increment(exact, 1, safe.platform ? { provider: safe.platform } : {});
  }
  return Object.freeze({
    async emit(name, payload, recipients = []) {
      const safe = sanitizePayload(payload); const eventName = EVENT_ALIASES[name] || name;
      const event = sanitizePayload({ eventName, timestamp: new Date().toISOString(), ...safe });
      if (STRUCTURED_EVENT_NAMES.includes(eventName)) structuredLogger.info(JSON.stringify(event));
      for (const adminUserId of recipients.slice(0, 100)) if (notificationService?.createNotification) await notificationService.createNotification({ adminUserId, icon: "alert", title: `Advertising execution: ${String(name).slice(0, 80)}`, subtitle: String(safe.reason || safe.status || "Status updated").slice(0, 255) });
      if (typeof realtime === "function") await realtime(eventName, event);
      recordMetric(name, safe);
      return event;
    },
  });
}
module.exports = { EVENT_ALIASES, sanitizePayload, createExecutionEventsAdapter };
