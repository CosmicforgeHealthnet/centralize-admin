const PLAN_STATES = Object.freeze([
  "DRAFT", "VALIDATING", "VALIDATED", "PENDING_APPROVAL", "APPROVED",
  "QUEUED", "EXECUTING", "PARTIAL_SUCCESS", "SUCCEEDED", "FAILED",
  "ROLLBACK_PENDING", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED", "EXPIRED",
]);

const PLAN_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(["VALIDATING", "CANCELLED"]),
  VALIDATING: Object.freeze(["VALIDATED"]),
  VALIDATED: Object.freeze(["PENDING_APPROVAL", "DRAFT"]),
  PENDING_APPROVAL: Object.freeze(["APPROVED", "CANCELLED", "EXPIRED"]),
  APPROVED: Object.freeze(["QUEUED", "EXPIRED"]),
  QUEUED: Object.freeze(["EXECUTING"]),
  EXECUTING: Object.freeze(["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED"]),
  PARTIAL_SUCCESS: Object.freeze(["ROLLBACK_PENDING"]),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze(["ROLLBACK_PENDING"]),
  ROLLBACK_PENDING: Object.freeze(["ROLLED_BACK", "ROLLBACK_FAILED"]),
  ROLLED_BACK: Object.freeze([]),
  ROLLBACK_FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
});

const TERMINAL_PLAN_STATES = Object.freeze([
  "SUCCEEDED", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED", "EXPIRED",
]);

const OPERATION_STATES = Object.freeze([
  "PENDING", "VALIDATED", "READY", "EXECUTING", "SUCCEEDED", "VERIFYING",
  "VERIFIED", "FAILED", "UNKNOWN", "DRIFTED", "RETRY_SCHEDULED",
]);

const OPERATION_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(["VALIDATED"]),
  VALIDATED: Object.freeze(["READY"]),
  READY: Object.freeze(["EXECUTING"]),
  EXECUTING: Object.freeze(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  SUCCEEDED: Object.freeze(["VERIFYING"]),
  VERIFYING: Object.freeze(["VERIFIED", "DRIFTED", "FAILED"]),
  VERIFIED: Object.freeze([]),
  FAILED: Object.freeze(["RETRY_SCHEDULED"]),
  UNKNOWN: Object.freeze(["VERIFYING"]),
  DRIFTED: Object.freeze([]),
  RETRY_SCHEDULED: Object.freeze(["EXECUTING"]),
});

const ACTOR_ROLES = Object.freeze([
  "VIEWER", "AUTHOR", "APPROVER", "EXECUTION_ADMINISTRATOR", "SYSTEM_WORKER", "AUDITOR",
]);

const PROVIDERS = Object.freeze(["GOOGLE_ADS", "META", "TIKTOK", "LINKEDIN", "X"]);

module.exports = {
  PLAN_STATES,
  PLAN_TRANSITIONS,
  TERMINAL_PLAN_STATES,
  OPERATION_STATES,
  OPERATION_TRANSITIONS,
  ACTOR_ROLES,
  PROVIDERS,
};
