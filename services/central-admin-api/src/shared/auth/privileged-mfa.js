"use strict";

// Evidence check for privileged operations outside HTTP middleware (services
// receive an `actor`). Requires BOTH a verified MFA enrollment and a fresh
// step-up on the caller's current session. `twoFactorEnabled` is ignored.

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

// Built by controllers from req.authSession.
function mfaEvidenceFromRequest(req) {
  const session = req?.authSession || {};
  return { enrolled: session.mfaEnrolled === true, sessionId: session.id || null, verifiedAt: session.mfaVerifiedAt || null };
}

function hasFreshVerifiedMfa(actor, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const evidence = actor?.mfa;
  if (!evidence || evidence.enrolled !== true || !evidence.sessionId || !evidence.verifiedAt) return false;
  const at = new Date(evidence.verifiedAt).getTime();
  return Number.isFinite(at) && now - at <= maxAgeMs && at <= now + 5000;
}

function evidenceReference(actor) {
  return `admin-session-step-up:${actor.mfa.sessionId}:${new Date(actor.mfa.verifiedAt).toISOString()}`;
}

module.exports = { mfaEvidenceFromRequest, hasFreshVerifiedMfa, evidenceReference, DEFAULT_MAX_AGE_MS };
