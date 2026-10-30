"use strict";

// Universal onboarding lifecycle. Pure: no I/O, no product names.
//
//   DRAFT -> REQUESTED -> IDENTITY_VERIFIED -> CONTRACT_VALIDATED
//         -> POLICY_REVIEWED -> CERTIFIED_STAGING -> ENABLED
//   plus REJECTED (terminal), SUSPENDED, REVOKED (terminal).
//
// A suspended product returns only to REQUESTED and must pass every gate
// again; nothing a product sends (e.g. a new manifest) moves it forward.

const STATES = Object.freeze(["DRAFT", "REQUESTED", "IDENTITY_VERIFIED", "CONTRACT_VALIDATED", "POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED", "REJECTED", "SUSPENDED", "REVOKED"]);
const TERMINAL = Object.freeze(["REJECTED", "REVOKED"]);

const TRANSITIONS = Object.freeze({
  DRAFT: ["REQUESTED", "REJECTED"],
  REQUESTED: ["IDENTITY_VERIFIED", "REJECTED", "SUSPENDED", "REVOKED"],
  IDENTITY_VERIFIED: ["CONTRACT_VALIDATED", "REJECTED", "SUSPENDED", "REVOKED"],
  CONTRACT_VALIDATED: ["POLICY_REVIEWED", "REJECTED", "SUSPENDED", "REVOKED"],
  POLICY_REVIEWED: ["CERTIFIED_STAGING", "REJECTED", "SUSPENDED", "REVOKED"],
  CERTIFIED_STAGING: ["ENABLED", "REJECTED", "SUSPENDED", "REVOKED"],
  ENABLED: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["REQUESTED", "REVOKED"],
  REJECTED: [],
  REVOKED: [],
});

// Platform action required to perform each transition (target state).
const TRANSITION_ACTION = Object.freeze({
  REQUESTED: "integration.request",
  IDENTITY_VERIFIED: "integration.verify",
  CONTRACT_VALIDATED: "integration.verify",
  POLICY_REVIEWED: "integration.review",
  CERTIFIED_STAGING: "integration.certify",
  ENABLED: "integration.approve",
  REJECTED: "integration.review",
  SUSPENDED: "integration.suspend",
  REVOKED: "integration.revoke",
});

// Transitions whose actor must differ from the requester (and, for
// ENABLED, also from whoever certified the contract).
const INDEPENDENT_FROM_REQUESTER = Object.freeze(["POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"]);

class TransitionError extends Error {
  constructor(reason, status = 409) {
    super(reason);
    this.name = "TransitionError";
    this.reason = reason;
    this.status = status;
  }
}

function assertTransition({ from, to, actorId, requestedBy, certifiedBy = null, expectedRevision, currentRevision, reviewedFromSuspension = false }) {
  if (!STATES.includes(from) || !STATES.includes(to)) throw new TransitionError("UNKNOWN_STATE", 400);
  if (!Number.isInteger(expectedRevision)) throw new TransitionError("EXPECTED_REVISION_REQUIRED", 400);
  if (expectedRevision !== currentRevision) throw new TransitionError("STALE_REVISION");
  if (TERMINAL.includes(from)) throw new TransitionError("TERMINAL_STATE");
  if (!TRANSITIONS[from].includes(to)) throw new TransitionError("TRANSITION_NOT_ALLOWED");
  if (from === "SUSPENDED" && to === "REQUESTED" && !reviewedFromSuspension) throw new TransitionError("EXPLICIT_REREVIEW_REQUIRED");
  if (INDEPENDENT_FROM_REQUESTER.includes(to) && actorId === requestedBy) throw new TransitionError("INDEPENDENT_REVIEWER_REQUIRED", 403);
  if (to === "ENABLED" && certifiedBy && actorId === certifiedBy) throw new TransitionError("INDEPENDENT_APPROVER_REQUIRED", 403);
  return { action: TRANSITION_ACTION[to] };
}

function canSynchronize(status) {
  return status === "ENABLED";
}

module.exports = { STATES, TERMINAL, TRANSITIONS, TRANSITION_ACTION, INDEPENDENT_FROM_REQUESTER, TransitionError, assertTransition, canSynchronize };
