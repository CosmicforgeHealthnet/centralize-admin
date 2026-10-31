"use strict";

// Bridge outcome classification. A Bridge answer is mapped to one stable
// category; nothing here ever turns a failure into success or zero.
//
// For COMMAND/RETRIEVAL capabilities the question is "did the source act?".
// Only a definite answer settles that: 4xx refusals and an explicit
// capability_blocked/blocked_policy/remote_*_disabled refusal are definite
// rejections; every other 5xx, timeout or broken response after the request
// may have been delivered is UNKNOWN_OUTCOME and is resolved only by
// authoritative readback of the original operation.

const CATEGORY_BY_CODE = Object.freeze({
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  invalid_query: "INVALID_SCOPE_OR_QUERY",
  invalid_request: "INVALID_REQUEST",
  purpose_required: "INVALID_REQUEST",
  invalid_reference: "INVALID_REQUEST",
  invalid_operation_id: "INVALID_REQUEST",
  invalid_cursor: "INVALID_REQUEST",
  invalid_command: "INVALID_REQUEST",
  json_required: "INVALID_REQUEST",
  request_too_large: "INVALID_REQUEST",
  not_found: "NOT_FOUND",
  capability_blocked: "CAPABILITY_DISABLED",
  remote_disabled: "CAPABILITY_DISABLED",
  remote_writes_disabled: "CAPABILITY_DISABLED",
  blocked_policy: "POLICY_UNAVAILABLE",
  owner_unavailable: "SOURCE_UNAVAILABLE",
  operation_unavailable: "SOURCE_UNAVAILABLE",
  owner_contract_invalid: "CONTRACT_MISMATCH",
  rate_limited: "RATE_LIMITED",
  conflict: "VERSION_CONFLICT",
  idempotency_conflict: "IDEMPOTENCY_CONFLICT",
  approval_unusable: "APPROVAL_UNUSABLE",
  replay_rejected: "REPLAY_REJECTED",
  owner_refused: "OWNER_REFUSED",
  expired: "EXPIRED",
  audit_unavailable: "BRIDGE_UNAVAILABLE",
  authentication_unavailable: "BRIDGE_UNAVAILABLE",
  authorization_unavailable: "BRIDGE_UNAVAILABLE",
  bridge_unavailable: "BRIDGE_UNAVAILABLE",
});

// Refusals that prove nothing was executed even on a 503.
const DEFINITE_REFUSALS = new Set(["capability_blocked", "remote_disabled", "remote_writes_disabled", "blocked_policy"]);

// Protocol v1 error code, HTTP-retryability and sanitized reason per category.
const PROTOCOL = Object.freeze({
  UNAUTHORIZED: ["UNAVAILABLE", false, "BRIDGE_AUTHENTICATION_REJECTED"],
  FORBIDDEN: ["FORBIDDEN", false, "SOURCE_FORBIDDEN"],
  INVALID_SCOPE_OR_QUERY: ["INVALID_REQUEST", false, "SOURCE_REJECTED_SCOPE_OR_QUERY"],
  INVALID_REQUEST: ["INVALID_REQUEST", false, "SOURCE_REJECTED_REQUEST"],
  NOT_FOUND: ["NOT_FOUND", false, "SOURCE_NOT_FOUND"],
  CAPABILITY_DISABLED: ["DISABLED", false, "SOURCE_CAPABILITY_DISABLED"],
  POLICY_UNAVAILABLE: ["BLOCKED_POLICY", false, "SOURCE_POLICY_UNAVAILABLE"],
  SOURCE_UNAVAILABLE: ["UNAVAILABLE", true, "SOURCE_UNAVAILABLE"],
  CONTRACT_MISMATCH: ["CONTRACT_MISMATCH", false, "BRIDGE_CONTRACT_MISMATCH"],
  RATE_LIMITED: ["UNAVAILABLE", true, "SOURCE_RATE_LIMITED"],
  VERSION_CONFLICT: ["CONFLICT", false, "SOURCE_VERSION_CONFLICT"],
  IDEMPOTENCY_CONFLICT: ["CONFLICT", false, "SOURCE_IDEMPOTENCY_CONFLICT"],
  APPROVAL_UNUSABLE: ["CONFLICT", false, "SOURCE_APPROVAL_UNUSABLE"],
  REPLAY_REJECTED: ["UNAVAILABLE", true, "BRIDGE_REPLAY_REJECTED"],
  OWNER_REFUSED: ["CONFLICT", false, "OWNER_REFUSED"],
  EXPIRED: ["CONFLICT", false, "SOURCE_EXPIRED"],
  BRIDGE_UNAVAILABLE: ["UNAVAILABLE", true, "BRIDGE_UNAVAILABLE"],
  BRIDGE_TIMEOUT: ["UNAVAILABLE", true, "BRIDGE_TIMEOUT"],
  TRANSPORT_SECURITY: ["UNAVAILABLE", false, "BRIDGE_TRANSPORT_SECURITY_FAILURE"],
  RESPONSE_TOO_LARGE: ["CONTRACT_MISMATCH", false, "BRIDGE_RESPONSE_TOO_LARGE"],
  UNKNOWN_OUTCOME: ["UNAVAILABLE", false, "UNKNOWN_OUTCOME"],
  BRIDGE_DISABLED: ["UNAVAILABLE", false, "BRIDGE_TRUST_NOT_ENROLLED"],
  REQUEST_REFUSED: ["INVALID_REQUEST", false, "REQUEST_OUTSIDE_PINNED_CONTRACT"],
});

class BridgeError extends Error {
  constructor(category, { status = null, code = null, operationId = null, reason } = {}) {
    super(category);
    this.name = "BridgeError";
    this.category = category;
    this.reason = reason || category;
    this.status = status;
    this.bridgeCode = code;
    this.operationId = operationId;
  }

  get unknownOutcome() {
    return this.category === "UNKNOWN_OUTCOME";
  }
}

function fromResponse(status, code, { mutating = false, operationId = null } = {}) {
  const category = CATEGORY_BY_CODE[code] || (status === 429 ? "RATE_LIMITED" : status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status >= 500 ? "BRIDGE_UNAVAILABLE" : "INVALID_REQUEST");
  if (mutating && status >= 500 && !DEFINITE_REFUSALS.has(code)) return new BridgeError("UNKNOWN_OUTCOME", { status, code, operationId });
  return new BridgeError(category, { status, code, operationId });
}

function protocolMapping(err) {
  const [code, retryable, reason] = PROTOCOL[err && err.category] || ["UNAVAILABLE", true, "BRIDGE_UNAVAILABLE"];
  return { code, retryable, reason };
}

module.exports = { BridgeError, fromResponse, protocolMapping, CATEGORY_BY_CODE, DEFINITE_REFUSALS, PROTOCOL };
