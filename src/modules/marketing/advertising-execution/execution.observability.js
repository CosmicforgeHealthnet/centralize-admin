const SECRET_KEY = /token|authorization|cookie|secret|password|credential|raw.?payload|provider.?payload|signed.?url|upload.?url|lease.?owner|lock.?owner|private.?key|internal.?path/i;
const ALLOWED_METRIC_LABELS = new Set(["provider", "operationType", "resourceType", "resultCategory", "status", "apiVersion", "workerType", "currency"]);
const STRUCTURED_EVENT_NAMES = Object.freeze([
  "marketing_execution.plan_validated", "marketing_execution.approval_recorded", "marketing_execution.job_claimed",
  "marketing_execution.operation_started", "marketing_execution.operation_succeeded", "marketing_execution.operation_failed",
  "marketing_execution.operation_unknown", "marketing_execution.reconciliation_drift", "marketing_execution.compensation_queued",
  "marketing_execution.kill_switch_changed",
]);

function sanitizeExecutionEvent(fields = {}, seen = new WeakSet(), depth = 0) {
  if (fields === null || ["boolean", "number"].includes(typeof fields)) return fields;
  if (typeof fields === "string") return fields.slice(0, 500);
  if (fields instanceof Date) return Number.isNaN(fields.getTime()) ? null : fields.toISOString();
  if (depth > 6) return "[TRUNCATED_DEPTH]";
  if (Array.isArray(fields)) return fields.slice(0, 100).map((item) => sanitizeExecutionEvent(item, seen, depth + 1));
  if (!fields || typeof fields !== "object") return String(fields).slice(0, 500);
  if (seen.has(fields)) return "[CIRCULAR]";
  seen.add(fields);
  const sanitized = Object.fromEntries(Object.entries(fields).slice(0, 100)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, value]) => [key, sanitizeExecutionEvent(value, seen, depth + 1)]));
  seen.delete(fields);
  return sanitized;
}

const METRIC_NAMES = Object.freeze([
  "plansTotal", "plansCurrent", "plansQueued", "validationDurationSeconds", "validationFailures", "validationExpiry",
  "submissions", "cancellations", "cancellationRequests", "approvalLatencySeconds", "approvalExpiry", "approvals", "rejections",
  "revocations", "selfApprovalViolations", "approvalThresholdFailures", "pendingJobs", "claimedJobs", "runningJobs",
  "retryScheduledJobs", "reconcilingJobs", "deadLetterJobs", "oldestPendingJobAge", "claims", "leaseRecoveries",
  "heartbeatFailures", "claimContention", "operationSuccess", "operationFailure", "unknownOutcomes", "partialSuccess",
  "drift", "operationAttempts", "operationRetries", "preconditionChanges", "idempotentDuplicateRecovery", "idempotentDuplicates",
  "providerOperationLatency", "localPersistenceLatency", "providerReadLatency", "providerWriteLatency", "providerRateLimits",
  "permissionFailures", "providerValidationFailure", "capabilityBlockers", "providerReviewStates", "targetingDiscoveryFailures",
  "targetingCacheHits", "targetingCacheMisses", "targetingCacheExpiry", "budgetExposureApproved", "budgetExposureQueued",
  "budgetExposureExecuted", "budgetPolicyViolations", "sharedBudgetPolicyViolations", "readBackVerificationLatency",
  "reconciliationQueueDepth", "reconciliationAttempts", "reconciliationVerified", "reconciliationDrifted",
  "reconciliationUnknown", "externalChanges", "escalatedIncidents", "unresolvedIncidentAge", "compensationDrafts",
  "compensationSubmitted", "compensationApproved", "compensationQueued", "compensationVerified", "compensationFailed",
  "compensationPartial", "compensationUnknown", "killSwitchChanges", "creativeRevisionConflicts", "mediaValidationFailures",
  "malwareOutcomes", "validationLayerFailures", "queueDepth", "claimFailures", "approvalQualificationFailures",
  "deadLetterCount", "localPersistenceRecovery", "reconciliationLatency", "compensationOutcomes",
]);

function boundedLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (entries.some(([key]) => !ALLOWED_METRIC_LABELS.has(key))) throw new TypeError("Unbounded advertising execution metric label");
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value).slice(0, 64)]));
}

function createExecutionMetrics() {
  const counters = Object.fromEntries(METRIC_NAMES.map((name) => [name, 0]));
  const samples = [];
  const assertRegistered = (name) => { if (!Object.hasOwn(counters, name)) throw new TypeError("Unknown advertising execution metric"); };
  return Object.freeze({
    increment(name, amount = 1, labels = {}) {
      if (!Number.isFinite(amount) || amount < 0) throw new TypeError("Invalid metric amount");
      assertRegistered(name); boundedLabels(labels); counters[name] += amount;
      samples.push({ name, kind: "counter", value: amount, labels: boundedLabels(labels) }); if (samples.length > 500) samples.shift();
    },
    set(name, value, labels = {}) { assertRegistered(name); if (!Number.isFinite(value)) throw new TypeError("Invalid metric value"); counters[name] = value; samples.push({ name, kind: "gauge", value, labels: boundedLabels(labels) }); if (samples.length > 500) samples.shift(); },
    observe(name, value, labels = {}) { assertRegistered(name); if (!Number.isFinite(value) || value < 0) throw new TypeError("Invalid metric observation"); counters[name] += 1; samples.push({ name, kind: "histogram", value, labels: boundedLabels(labels) }); if (samples.length > 500) samples.shift(); },
    snapshot() { return Object.freeze({ ...counters, samples: samples.map((sample) => ({ ...sample, labels: { ...sample.labels } })) }); },
  });
}

module.exports = { SECRET_KEY, ALLOWED_METRIC_LABELS, STRUCTURED_EVENT_NAMES, METRIC_NAMES, boundedLabels, sanitizeExecutionEvent, createExecutionMetrics };
