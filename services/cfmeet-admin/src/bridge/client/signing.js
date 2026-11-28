"use strict";

// CF Meet Admin Bridge signing profile v1 (interface v1, agreed with Track A;
// cfmeet services/admin-bridge/docs/contract/signing-profile.md, pinned at the
// commit recorded in cfmeet-backoffice-v1.json):
//
//  - HMAC v2 (shared/go/serviceauth.signatureFor): LF-joined
//    "2", service, METHOD, exact request URI, unix seconds, nonce,
//    hex(sha256(exact body bytes)); hex HMAC-SHA256.
//  - request_digest (internal/security.Digest): hex sha256 of
//    METHOD LF request URI LF "cfmeet" LF hex(sha256(exact body bytes)).
//  - Staff assertion: Ed25519 JWS, header exactly {alg:EdDSA, typ:JWT, kid};
//    zone_scopes/tenant_scopes are always present (every CF Meet route is
//    zone- and tenant-scoped); exp - iat = 20 s (Bridge limit 60 s).
//  - approval claim on TWO_PERSON capabilities: {approval_id, capability,
//    requester_ref, approver_ref, intent_digest, decided_at, expires_at}.
//
// Every attempt gets a fresh nonce, timestamp, JTI and assertion; a permitted
// retry re-signs the identical body bytes.

const { createHash, createHmac, randomBytes, randomUUID, sign } = require("node:crypto");

const HQ_PRINCIPAL = "cosmicforge-hq-cfmeet-admin";
const PRODUCT = "cfmeet";
const PERMISSION = "bridge.capabilities.read";
const BRIDGE_BASE = "/internal/cfmeet-admin/v1";
const ASSERTION_TTL_SECONDS = 20;
const EMPTY = Buffer.alloc(0);

const b64 = (data) => Buffer.from(data).toString("base64url");
const sha = (data) => createHash("sha256").update(data).digest("hex");

function bridgeSignature({ secret, method, uri, timestamp, nonce, body = EMPTY }) {
  const canonical = ["2", HQ_PRINCIPAL, method.toUpperCase(), uri, String(timestamp), nonce, sha(body)].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function requestDigest(method, uri, body = EMPTY) {
  return sha([method.toUpperCase(), uri, PRODUCT, sha(body)].join("\n"));
}

const APPROVAL_KEYS = Object.freeze(["approval_id", "capability", "requester_ref", "approver_ref", "intent_digest", "decided_at", "expires_at"]);

// staff: { sub, sessionId, authTime, acr, role, market, organization, zone, tenant }
// approval: the claim above, or undefined for capabilities without TWO_PERSON.
function staffAssertion({ privateKey, kid, issuer, audience, staff, method, uri, body = EMPTY, permissions = [PERMISSION], approval, now = Math.floor(Date.now() / 1000) }) {
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const claims = {
    iss: issuer, sub: staff.sub, aud: audience, product: PRODUCT,
    roles: [staff.role], permissions: [...new Set(permissions)],
    market_scopes: [staff.market], organization_scopes: [staff.organization],
    session_id: staff.sessionId, auth_time: staff.authTime, acr: staff.acr,
    jti: randomUUID(), iat: now, nbf: now, exp: now + ASSERTION_TTL_SECONDS, request_digest: requestDigest(method, uri, body),
  };
  if (staff.zone && staff.tenant) {
    claims.zone_scopes = [staff.zone];
    claims.tenant_scopes = [staff.tenant];
  }
  if (approval) claims.approval = Object.fromEntries(APPROVAL_KEYS.map((k) => [k, approval[k]]));
  const data = header + "." + b64(JSON.stringify(claims));
  return data + "." + b64(sign(null, Buffer.from(data), privateKey));
}

function bridgeHeaders({ serviceKey, serviceKid, privateKey, staffKid, issuer, audience, staff, method, uri, body = EMPTY, permissions, approval, now = Math.floor(Date.now() / 1000) }) {
  const nonce = randomBytes(16).toString("hex");
  const headers = {
    "X-HQ-Key-ID": serviceKid,
    "X-Service-Name": HQ_PRINCIPAL,
    "X-Service-Timestamp": String(now),
    "X-Service-Nonce": nonce,
    "X-Service-Signature-Version": "2",
    "X-Service-Signature": bridgeSignature({ secret: serviceKey, method, uri, timestamp: now, nonce, body }),
    Authorization: "Bearer " + staffAssertion({ privateKey, kid: staffKid, issuer, audience, staff, method, uri, body, permissions, approval, now }),
    Accept: "application/json",
  };
  if (body.length) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(body.length);
  }
  return headers;
}

// Discovery is SCOPED like every CF Meet route.
function capabilitiesUri({ market, organization, zone, tenant }) {
  return BRIDGE_BASE + "/capabilities?market=" + encodeURIComponent(market) + "&organization=" + encodeURIComponent(organization) +
    "&zone=" + encodeURIComponent(zone) + "&tenant=" + encodeURIComponent(tenant) + "&purpose=admin-ui-capabilities";
}

module.exports = { HQ_PRINCIPAL, PRODUCT, PERMISSION, BRIDGE_BASE, ASSERTION_TTL_SECONDS, APPROVAL_KEYS, bridgeSignature, requestDigest, staffAssertion, bridgeHeaders, capabilitiesUri, sha };
