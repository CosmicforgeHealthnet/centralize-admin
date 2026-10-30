"use strict";

// Local signer for the HQ -> Product Integration Core delegation token
// (cf-hq-delegation+jwt). Byte-compatible with
// packages/identity-and-permissions verifyDelegation(typ HQ); kept local
// because this service's image contains only services/central-admin-api.
//
// The token is HS256, lives 30 seconds, carries a fresh jti, and is bound to
// the exact PIC method, path-with-query and body. Its key is server-side only
// and distinct from every browser session/JWT secret.

const { createHash, createHmac, randomUUID } = require("node:crypto");

const TYP = "cf-hq-delegation+jwt";
const ISSUER = "central-admin-api";
const AUDIENCE = "product-integration-core";
const TTL_SECONDS = 30;
const ALLOWED_CLAIMS = new Set(["iss", "aud", "sub", "sid", "iat", "exp", "jti", "auth_time", "mfa_at", "bnd", "tier", "dept"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const b64 = (value) => Buffer.from(value).toString("base64url");

function requestBinding(method, pathWithQuery, body = Buffer.alloc(0)) {
  return sha256([String(method).toUpperCase(), pathWithQuery, sha256(body)].join("\n"));
}

function signHqDelegation({ claims, key, kid, now = Date.now() }) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error("DELEGATION_KEY_INVALID");
  const iat = Math.floor(now / 1000);
  const payload = { jti: randomUUID(), iat, exp: iat + TTL_SECONDS, mfa_at: null, ...claims, iss: ISSUER, aud: AUDIENCE };
  for (const name of Object.keys(payload)) {
    if (!ALLOWED_CLAIMS.has(name)) throw new Error("DELEGATION_CLAIM_NOT_ALLOWED");
    if (payload[name] === undefined) delete payload[name];
  }
  const header = b64(JSON.stringify({ alg: "HS256", typ: TYP, kid }));
  const body = b64(JSON.stringify(payload));
  return header + "." + body + "." + createHmac("sha256", key).update(header + "." + body).digest("base64url");
}

module.exports = { TYP, ISSUER, AUDIENCE, TTL_SECONDS, requestBinding, signHqDelegation };
