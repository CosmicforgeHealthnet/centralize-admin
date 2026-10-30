"use strict";

// Maps a verified HQ product delegation onto the bridge's staff assertion
// requirements. Every check happens locally before any network call:
//  - recent MFA (mfa_at within 300 s) becomes the assertion auth_time;
//  - the HQ *product grant role* must map to an approved bridge role
//    (staff tier is never consulted);
//  - the configured bridge market/organization must be inside the
//    delegation's effective scope.

const MAX_MFA_AGE_SECONDS = 300;

class StaffContextError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StaffContextError";
    this.reason = reason;
  }
}

function bridgeStaffContext(delegation, bridge, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!delegation) throw new StaffContextError("DELEGATION_REQUIRED");
  const mfaAt = delegation.mfa_at;
  if (!Number.isInteger(mfaAt) || mfaAt <= 0 || mfaAt > nowSeconds + 5 || nowSeconds - mfaAt > MAX_MFA_AGE_SECONDS) {
    throw new StaffContextError("RECENT_MFA_REQUIRED");
  }
  const role = delegation.role && Object.prototype.hasOwnProperty.call(bridge.roleMap, delegation.role) ? bridge.roleMap[delegation.role] : null;
  if (!role) throw new StaffContextError("ROLE_NOT_APPROVED");
  const scope = delegation.scope || {};
  if (!Array.isArray(scope.market) || !scope.market.includes(bridge.market) ||
      !Array.isArray(scope.organization) || !scope.organization.includes(bridge.organization)) {
    throw new StaffContextError("SCOPE_NOT_GRANTED");
  }
  return {
    sub: delegation.sub,
    sessionId: delegation.sid,
    authTime: Math.min(mfaAt, nowSeconds),
    acr: bridge.acr,
    role,
    market: bridge.market,
    organization: bridge.organization,
  };
}

function bridgeCapabilityState(bridge) {
  return bridge && bridge.enabled ? "READ_ONLY" : "BLOCKED_DEPENDENCY";
}

module.exports = { bridgeStaffContext, bridgeCapabilityState, StaffContextError, MAX_MFA_AGE_SECONDS };
