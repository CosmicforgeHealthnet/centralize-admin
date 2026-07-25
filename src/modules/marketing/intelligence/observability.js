const logger = require("../../../shared/utils/logger");
const { redactLogPayload } = require("../social-operations/security/log-redaction.service");
const { sanitizeBoundedJson, sanitizePlainText } = require("./validation-security");

const EVENTS = Object.freeze({
  CREATIVE_SYNC_STARTED: "marketing.creative_sync.started",
  CREATIVE_SYNC_COMPLETED: "marketing.creative_sync.completed",
  PROVIDER_FAILURE: "marketing.provider.failure",
  LOCK_CONFLICT: "marketing.lock.conflict",
  LOCK_RENEWAL_FAILED: "marketing.lock.renewal_failed",
  LOCK_RESULT: "marketing.lock.result",
  CREATIVE_SCORING_COMPLETED: "marketing.creative_scoring.completed",
  RECOMMENDATIONS_EVALUATED: "marketing.recommendations.evaluated",
  ALERTS_EVALUATED: "marketing.alerts.evaluated",
  TASK_CONVERTED: "marketing.task.converted",
  EVALUATION_RUN_COMPLETED: "marketing.evaluation_run.completed",
  PROVIDER_FETCH_COMPLETED: "marketing.provider.fetch_completed",
  TOKEN_REFRESHED: "marketing.provider.token_refreshed",
  SCHEDULER_STATUS: "marketing.scheduler.status",
});

const PROVIDER_CATEGORY = Object.freeze({
  auth: "AUTHENTICATION", permission: "PERMISSION", rate_limit: "RATE_LIMIT",
  timeout: "TIMEOUT", unavailable: "UNAVAILABLE", provider: "UNAVAILABLE",
  invalid_request: "INVALID_REQUEST", config: "INVALID_REQUEST", malformed: "PROVIDER_DATA",
});

function providerFailure(error = {}) {
  const status = Number(error.statusCode || error.response?.status || 0) || null;
  let category = PROVIDER_CATEGORY[String(error.kind || error.category || "").toLowerCase()] || "UNKNOWN";
  if (status === 403) category = "PERMISSION";
  else if (status === 401) category = "AUTHENTICATION";
  else if (status === 429) category = "RATE_LIMIT";
  else if (status >= 500) category = "UNAVAILABLE";
  return {
    providerErrorCategory: category,
    sanitizedCode: sanitizePlainText(String(error.code || error.kind || "PROVIDER_FAILURE"), 100),
    retryable: Boolean(error.retryable || ["RATE_LIMIT", "TIMEOUT", "UNAVAILABLE"].includes(category)),
    status,
  };
}

function safeRequestId(value) {
  const cleaned = sanitizePlainText(value, 128);
  return cleaned && /^[A-Za-z0-9._:-]+$/.test(cleaned) ? cleaned : null;
}

function logEvent(event, payload = {}, { level = "info", log = logger } = {}) {
  const safe = sanitizeBoundedJson(redactLogPayload({ event, ...payload }), { maxBytes: 16 * 1024, maxString: 500, maxArray: 100 });
  const record = { timestamp: new Date().toISOString(), ...safe, event };
  const method = typeof log?.[level] === "function" ? log[level].bind(log) : log?.info?.bind(log);
  if (method) method(JSON.stringify(record));
  return record;
}

function structuredLogger(log = logger, event = "marketing.operation") {
  if (log?.__marketingStructured) return log;
  const wrap = (level) => (message, metadata = {}) => logEvent(event, {
    message: sanitizePlainText(message, 500),
    ...(metadata && typeof metadata === "object" ? metadata : {}),
  }, { log, level });
  return { __marketingStructured: true, info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") };
}

module.exports = { EVENTS, PROVIDER_CATEGORY, providerFailure, safeRequestId, logEvent, structuredLogger };
