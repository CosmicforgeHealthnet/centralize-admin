"use strict";
const { createHash, createHmac, randomBytes, randomUUID, sign, timingSafeEqual } = require("node:crypto");

const HQ_PRINCIPAL = "cosmicforge-hq-karryam-admin";
const PRODUCT = "karryam";
const PERMISSION = "bridge.capabilities.read";
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function b64(data) { return Buffer.from(data).toString("base64url"); }
function sha(data) { return createHash("sha256").update(data).digest("hex"); }
function hmac(key, value) { return createHmac("sha256", key).update(value).digest(); }
function same(expected, supplied) {
  return Buffer.isBuffer(supplied) && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
function signDelegation(payload, secret) {
  const raw = b64(Buffer.from(JSON.stringify(payload)));
  return raw + "." + b64(hmac(secret, raw));
}
function verifyDelegation(token, secret, expected, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error("delegation_denied");
  const parts = token.split(".");
  const signature = Buffer.from(parts[1], "base64url");
  if (!same(hmac(secret, parts[0]), signature)) throw new Error("delegation_denied");
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new Error("delegation_denied"); }
  const plain = payload && typeof payload === "object" && !Array.isArray(payload);
  const allowed = ["iss","aud","product","sub","session_id","role","permission","market","organization","acr","auth_time","iat","exp","operation"];
  if (!plain || Object.keys(payload).some((k) => !allowed.includes(k))) throw new Error("delegation_denied");
  if (payload.iss !== "central-admin-api" || payload.aud !== "karryam-admin-local" || payload.product !== PRODUCT ||
      payload.operation !== "capabilities.read" || payload.permission !== PERMISSION ||
      payload.market !== expected.market || payload.organization !== expected.organization ||
      payload.acr !== expected.acr || ![payload.sub,payload.session_id,payload.role,payload.market,payload.organization].every((v) => typeof v === "string" && OPAQUE.test(v)) ||
      !Number.isInteger(payload.auth_time) || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
      payload.auth_time <= 0 || payload.auth_time > payload.iat || now - payload.auth_time > 300 ||
      payload.iat > now || payload.iat < now - 30 || payload.exp <= now || payload.exp > payload.iat + 20) {
    throw new Error("delegation_denied");
  }
  return payload;
}
function bridgeSignature({ secret, method, uri, timestamp, nonce, body = Buffer.alloc(0) }) {
  const canonical = ["2", HQ_PRINCIPAL, method.toUpperCase(), uri, String(timestamp), nonce, sha(body)].join("\n");
  return hmac(secret, canonical).toString("hex");
}
function requestDigest(method, uri, body = Buffer.alloc(0)) {
  return sha([method.toUpperCase(), uri, PRODUCT, sha(body)].join("\n"));
}
function staffAssertion({ privateKey, kid, issuer, audience, role, delegation, method, uri, now = Math.floor(Date.now() / 1000) }) {
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const claims = {
    iss: issuer, sub: delegation.sub, aud: audience, product: PRODUCT,
    roles: [role], permissions: [PERMISSION],
    market_scopes: [delegation.market], organization_scopes: [delegation.organization],
    session_id: delegation.session_id, auth_time: delegation.auth_time, acr: delegation.acr,
    jti: randomUUID(), iat: now, nbf: now, exp: now + 20, request_digest: requestDigest(method, uri)
  };
  const payload = b64(JSON.stringify(claims));
  const data = header + "." + payload;
  return data + "." + b64(sign(null, Buffer.from(data), privateKey));
}
function bridgeHeaders({ serviceKey, serviceKid, privateKey, staffKid, issuer, audience, role, delegation, method, uri, now = Math.floor(Date.now() / 1000) }) {
  const nonce = randomBytes(16).toString("hex");
  return {
    "X-HQ-Key-ID": serviceKid,
    "X-Service-Name": HQ_PRINCIPAL,
    "X-Service-Timestamp": String(now),
    "X-Service-Nonce": nonce,
    "X-Service-Signature-Version": "2",
    "X-Service-Signature": bridgeSignature({ secret: serviceKey, method, uri, timestamp: now, nonce }),
    "Authorization": "Bearer " + staffAssertion({ privateKey, kid: staffKid, issuer, audience, role, delegation, method, uri, now }),
    "Accept": "application/json"
  };
}
module.exports = { HQ_PRINCIPAL, PRODUCT, PERMISSION, OPAQUE, b64, sha, signDelegation, verifyDelegation, bridgeSignature, requestDigest, staffAssertion, bridgeHeaders };
