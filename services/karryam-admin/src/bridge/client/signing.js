"use strict";

// Karryam Backoffice Bridge signing profile v1 (ported from the validated
// PR #36 read-only client and checked against KarryGo staging a4adee68):
//
//  - HMAC v2 (shared/go/serviceauth.signatureFor): LF-joined
//    "2", service, METHOD, exact request URI, unix seconds, nonce,
//    hex(sha256(body)); hex HMAC-SHA256.
//  - request_digest (internal/security.Digest): hex sha256 of
//    METHOD LF request URI LF "karryam" LF hex(sha256(body)).
//  - Staff assertion: Ed25519 JWS, header exactly {alg:EdDSA, typ:JWT, kid},
//    claims per schemas/StaffAssertion.json.

const { createHash, createHmac, randomBytes, randomUUID, sign } = require("node:crypto");

const HQ_PRINCIPAL = "cosmicforge-hq-karryam-admin";
const PRODUCT = "karryam";
const PERMISSION = "bridge.capabilities.read";
const BRIDGE_BASE = "/internal/karryam-admin/v1";
const ASSERTION_TTL_SECONDS = 20;

const b64 = (data) => Buffer.from(data).toString("base64url");
const sha = (data) => createHash("sha256").update(data).digest("hex");

function bridgeSignature({ secret, method, uri, timestamp, nonce, body = Buffer.alloc(0) }) {
  const canonical = ["2", HQ_PRINCIPAL, method.toUpperCase(), uri, String(timestamp), nonce, sha(body)].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function requestDigest(method, uri, body = Buffer.alloc(0)) {
  return sha([method.toUpperCase(), uri, PRODUCT, sha(body)].join("\n"));
}

// staff: { sub, sessionId, authTime, acr, role, market, organization }
function staffAssertion({ privateKey, kid, issuer, audience, staff, method, uri, now = Math.floor(Date.now() / 1000) }) {
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const claims = {
    iss: issuer, sub: staff.sub, aud: audience, product: PRODUCT,
    roles: [staff.role], permissions: [PERMISSION],
    market_scopes: [staff.market], organization_scopes: [staff.organization],
    session_id: staff.sessionId, auth_time: staff.authTime, acr: staff.acr,
    jti: randomUUID(), iat: now, nbf: now, exp: now + ASSERTION_TTL_SECONDS, request_digest: requestDigest(method, uri),
  };
  const data = header + "." + b64(JSON.stringify(claims));
  return data + "." + b64(sign(null, Buffer.from(data), privateKey));
}

function bridgeHeaders({ serviceKey, serviceKid, privateKey, staffKid, issuer, audience, staff, method, uri, now = Math.floor(Date.now() / 1000) }) {
  const nonce = randomBytes(16).toString("hex");
  return {
    "X-HQ-Key-ID": serviceKid,
    "X-Service-Name": HQ_PRINCIPAL,
    "X-Service-Timestamp": String(now),
    "X-Service-Nonce": nonce,
    "X-Service-Signature-Version": "2",
    "X-Service-Signature": bridgeSignature({ secret: serviceKey, method, uri, timestamp: now, nonce }),
    Authorization: "Bearer " + staffAssertion({ privateKey, kid: staffKid, issuer, audience, staff, method, uri, now }),
    Accept: "application/json",
  };
}

function capabilitiesUri(market, organization) {
  return BRIDGE_BASE + "/capabilities?market=" + encodeURIComponent(market) + "&organization=" + encodeURIComponent(organization) + "&purpose=admin_ui_capabilities";
}

module.exports = { HQ_PRINCIPAL, PRODUCT, PERMISSION, BRIDGE_BASE, ASSERTION_TTL_SECONDS, bridgeSignature, requestDigest, staffAssertion, bridgeHeaders, capabilitiesUri, sha };
