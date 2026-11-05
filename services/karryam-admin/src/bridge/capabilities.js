"use strict";

// Maps a verified HQ product delegation onto the Bridge staff assertion.
// Every check happens locally before any network call:
//  - recent MFA (mfa_at within the configured window, at most 300 s)
//    becomes the assertion auth_time;
//  - the HQ *product grant role* must map to an approved Bridge role
//    (staff tier is never consulted);
//  - the enrolled Bridge market/organization must be inside the delegated
//    scope;
//  - for zone/tenant-scoped routes the requested zone and tenant must be
//    explicitly delegated AND enrolled for this Bridge. A delegation that
//    does not name zones/tenants never means "every zone".

const MAX_MFA_AGE_SECONDS = 300;

class StaffContextError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StaffContextError";
    this.reason = reason;
  }
}

function bridgeStaffContext(delegation, bridge, nowSeconds = Math.floor(Date.now() / 1000), { zone, tenant } = {}) {
  if (!delegation) throw new StaffContextError("DELEGATION_REQUIRED");
  const mfaAt = delegation.mfa_at;
  const maxAge = Math.min(bridge.mfaMaxAgeSeconds || MAX_MFA_AGE_SECONDS, MAX_MFA_AGE_SECONDS);
  if (!Number.isInteger(mfaAt) || mfaAt <= 0 || mfaAt > nowSeconds + 5 || nowSeconds - mfaAt > maxAge) {
    throw new StaffContextError("RECENT_MFA_REQUIRED");
  }
  const role = delegation.role && Object.prototype.hasOwnProperty.call(bridge.roleMap, delegation.role) ? bridge.roleMap[delegation.role] : null;
  if (!role) throw new StaffContextError("ROLE_NOT_APPROVED");
  const scope = delegation.scope || {};
  if (!Array.isArray(scope.market) || !scope.market.includes(bridge.market) ||
      !Array.isArray(scope.organization) || !scope.organization.includes(bridge.organization)) {
    throw new StaffContextError("SCOPE_NOT_GRANTED");
  }
  const context = {
    sub: delegation.sub,
    sessionId: delegation.sid,
    authTime: Math.min(mfaAt, nowSeconds),
    acr: bridge.acr,
    role,
    market: bridge.market,
    organization: bridge.organization,
  };
  if (zone !== undefined || tenant !== undefined) {
    if (typeof zone !== "string" || typeof tenant !== "string") throw new StaffContextError("ZONE_AND_TENANT_REQUIRED");
    if (!Array.isArray(scope.zone) || !scope.zone.includes(zone)) throw new StaffContextError("ZONE_NOT_GRANTED");
    if (!Array.isArray(scope.tenant) || !scope.tenant.includes(tenant)) throw new StaffContextError("TENANT_NOT_GRANTED");
    if (!(bridge.zones || []).includes(zone)) throw new StaffContextError("ZONE_NOT_ENROLLED");
    if (!(bridge.tenants || []).includes(tenant)) throw new StaffContextError("TENANT_NOT_ENROLLED");
    context.zone = zone;
    context.tenant = tenant;
  }
  return context;
}

function bridgeCapabilityState(bridge) {
  return bridge && bridge.enabled ? "READ_ONLY" : "BLOCKED_DEPENDENCY";
}

module.exports = { bridgeStaffContext, bridgeCapabilityState, StaffContextError, MAX_MFA_AGE_SECONDS };
