"use strict";

// Short-lived, operation-bound delegated staff identity.
//
// Two token types share one strict format (compact JWS, HS256):
//   cf-hq-delegation+jwt       Central Admin API  -> Product Integration Core
//   cf-product-delegation+jwt  Integration Core   -> one Product Admin
//
// Each hop signs with its own key (never a browser/session key), binds the
// token to the exact method, path and body, and caps lifetime at 60 seconds.
// Keys are server-side only; the browser never holds them.

const { createHash, createHmac, randomUUID, timingSafeEqual } = require("node:crypto");

const TYPES = Object.freeze({
  HQ: "cf-hq-delegation+jwt",
  PRODUCT: "cf-product-delegation+jwt",
});
const MAX_TTL_SECONDS = 60;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const COMMON_CLAIMS = ["iss", "aud", "sub", "sid", "iat", "exp", "jti", "auth_time", "mfa_at", "bnd"];
const CLAIMS = Object.freeze({
  [TYPES.HQ]: [...COMMON_CLAIMS, "tier", "dept"],
  [TYPES.PRODUCT]: [...COMMON_CLAIMS, "product_id", "action", "dataset_id", "scope", "role", "grant_id"],
});

class DelegationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "DelegationError";
    this.reason = reason;
  }
}

const b64 = (value) => Buffer.from(value).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Binding = sha256(METHOD \n path-with-query \n sha256(body)).
function requestBinding(method, pathWithQuery, body = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return sha256([String(method).toUpperCase(), pathWithQuery, sha256(bytes)].join("\n"));
}

function keyBytes(entry) {
  const key = Buffer.isBuffer(entry) ? entry : entry && entry.key;
  if (!Buffer.isBuffer(key) || key.length < 32) throw new DelegationError("KEY_INVALID");
  return key;
}

function signDelegation(claims, { key, kid, typ, now = Date.now(), ttlSeconds = 30 }) {
  if (!CLAIMS[typ]) throw new DelegationError("TYPE_INVALID");
  if (!OPAQUE.test(String(kid))) throw new DelegationError("KID_INVALID");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) throw new DelegationError("TTL_INVALID");
  const iat = Math.floor(now / 1000);
  const body = { jti: randomUUID(), iat, exp: iat + ttlSeconds, mfa_at: null, ...claims };
  for (const key of Object.keys(body)) if (!CLAIMS[typ].includes(key)) throw new DelegationError("CLAIM_NOT_ALLOWED:" + key);
  const header = b64(JSON.stringify({ alg: "HS256", typ, kid }));
  const payload = b64(JSON.stringify(body));
  const signature = createHmac("sha256", keyBytes(key)).update(header + "." + payload).digest("base64url");
  return header + "." + payload + "." + signature;
}

function parseSegment(segment) {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new DelegationError("MALFORMED");
  }
}

/**
 * Verifies a delegation token. `keys` maps kid -> { key: Buffer, notAfter? }.
 * `binding` must be the server-computed requestBinding of the actual request.
 * Replay (jti) protection is the caller's responsibility (durable store).
 */
function verifyDelegation(token, { keys, typ, issuer, audience, binding, now = Date.now(), maxTtlSeconds = MAX_TTL_SECONDS }) {
  if (typeof token !== "string" || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new DelegationError("MALFORMED");
  }
  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  const header = parseSegment(rawHeader);
  if (Object.keys(header).length !== 3 || header.alg !== "HS256" || header.typ !== typ || !OPAQUE.test(String(header.kid))) {
    throw new DelegationError("HEADER_INVALID");
  }
  const entry = keys && Object.prototype.hasOwnProperty.call(keys, header.kid) ? keys[header.kid] : null;
  if (!entry) throw new DelegationError("KEY_UNKNOWN");
  if (entry.notAfter && Date.parse(entry.notAfter) <= now) throw new DelegationError("KEY_EXPIRED");
  const expected = createHmac("sha256", keyBytes(entry)).update(rawHeader + "." + rawPayload).digest();
  const supplied = Buffer.from(rawSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new DelegationError("SIGNATURE_INVALID");

  const claims = parseSegment(rawPayload);
  const allowed = CLAIMS[typ];
  for (const key of Object.keys(claims)) if (!allowed.includes(key)) throw new DelegationError("CLAIM_NOT_ALLOWED");
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== issuer || claims.aud !== audience) throw new DelegationError("AUDIENCE_INVALID");
  if (!OPAQUE.test(String(claims.sub)) || !OPAQUE.test(String(claims.sid)) || !OPAQUE.test(String(claims.jti))) throw new DelegationError("SUBJECT_INVALID");
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > seconds + 5 || claims.exp <= seconds ||
      claims.exp <= claims.iat || claims.exp - claims.iat > Math.min(maxTtlSeconds, MAX_TTL_SECONDS)) {
    throw new DelegationError("LIFETIME_INVALID");
  }
  if (!Number.isInteger(claims.auth_time) || claims.auth_time <= 0 || claims.auth_time > claims.iat) throw new DelegationError("AUTH_TIME_INVALID");
  if (claims.mfa_at !== null && (!Number.isInteger(claims.mfa_at) || claims.mfa_at > claims.iat + 5)) throw new DelegationError("MFA_TIME_INVALID");
  if (typeof claims.bnd !== "string" || !/^[0-9a-f]{64}$/.test(claims.bnd)) throw new DelegationError("BINDING_MISSING");
  if (!binding || claims.bnd !== binding) throw new DelegationError("BINDING_MISMATCH");
  return claims;
}

module.exports = { TYPES, MAX_TTL_SECONDS, DelegationError, requestBinding, signDelegation, verifyDelegation };
