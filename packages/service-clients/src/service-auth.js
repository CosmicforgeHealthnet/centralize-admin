"use strict";

// cf-svc-v1 service request signatures (application-layer service identity).
// Modelled on the KarryGo serviceauth v2 canonical form, with the key ID in
// the signed bytes. Used together with private transport (Unix socket or
// TLS 1.3 mTLS); it is never a substitute for transport security.
//
// canonical = "cf-svc-v1" LF service_id LF key_id LF METHOD LF request_uri LF
//             unix_seconds LF nonce LF hex(sha256(body))

const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const VERSION = "cf-svc-v1";
const HEADERS = Object.freeze({
  service: "x-cf-service-id",
  keyId: "x-cf-key-id",
  timestamp: "x-cf-timestamp",
  nonce: "x-cf-nonce",
  signature: "x-cf-signature",
  version: "x-cf-signature-version",
});
const ID = /^[a-z0-9][a-z0-9.-]{2,63}$/;
const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const NONCE = /^[0-9a-f]{32}$/;
const SKEW_SECONDS = 30;

class ServiceAuthError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ServiceAuthError";
    this.reason = reason;
  }
}

function bodyHash(body) {
  return createHash("sha256").update(body || Buffer.alloc(0)).digest("hex");
}

function canonical({ serviceId, keyId, method, uri, timestamp, nonce, body }) {
  return [VERSION, serviceId, keyId, String(method).toUpperCase(), uri, String(timestamp), nonce, bodyHash(body)].join("\n");
}

function signServiceRequest({ serviceId, keyId, key, method, uri, body = Buffer.alloc(0), now = Date.now(), nonce = randomBytes(16).toString("hex") }) {
  if (!ID.test(serviceId) || !KID.test(keyId)) throw new ServiceAuthError("IDENTITY_INVALID");
  if (!Buffer.isBuffer(key) || key.length < 32) throw new ServiceAuthError("KEY_INVALID");
  const timestamp = Math.floor(now / 1000);
  const signature = createHmac("sha256", key).update(canonical({ serviceId, keyId, method, uri, timestamp, nonce, body })).digest("hex");
  return {
    [HEADERS.service]: serviceId,
    [HEADERS.keyId]: keyId,
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.nonce]: nonce,
    [HEADERS.version]: VERSION,
    [HEADERS.signature]: signature,
  };
}

// Reads a header that must appear exactly once (rawHeaders detects
// duplicates that Node would otherwise join or overwrite).
function single(rawHeaders, name) {
  const values = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if (String(rawHeaders[i]).toLowerCase() === name) values.push(rawHeaders[i + 1]);
  if (values.length !== 1) throw new ServiceAuthError(values.length ? "DUPLICATE_HEADER" : "MISSING_HEADER");
  if (values[0] !== values[0].trim() || values[0].length === 0) throw new ServiceAuthError("NONCANONICAL_HEADER");
  return values[0];
}

/**
 * Verifies a signed request. `keys` maps keyId -> { serviceId, key, notAfter }.
 * `nonceStore.claim(serviceId, nonce, expiresAtMs)` must durably record the
 * nonce and return false if it was already used. Returns { serviceId, keyId }.
 */
async function verifyServiceRequest({ rawHeaders, method, uri, body = Buffer.alloc(0), keys, nonceStore, allowedServices, now = Date.now() }) {
  if (!Array.isArray(rawHeaders)) throw new ServiceAuthError("MISSING_HEADER");
  const serviceId = single(rawHeaders, HEADERS.service);
  const keyId = single(rawHeaders, HEADERS.keyId);
  const timestamp = single(rawHeaders, HEADERS.timestamp);
  const nonce = single(rawHeaders, HEADERS.nonce);
  const version = single(rawHeaders, HEADERS.version);
  const signature = single(rawHeaders, HEADERS.signature);
  if (version !== VERSION) throw new ServiceAuthError("VERSION_UNSUPPORTED");
  if (!ID.test(serviceId) || !KID.test(keyId) || !NONCE.test(nonce) || !/^[0-9]{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new ServiceAuthError("HEADER_INVALID");
  }
  if (allowedServices && !allowedServices.includes(serviceId)) throw new ServiceAuthError("SERVICE_NOT_ALLOWED");
  const entry = keys && Object.prototype.hasOwnProperty.call(keys, keyId) ? keys[keyId] : null;
  if (!entry || entry.serviceId !== serviceId) throw new ServiceAuthError("KEY_UNKNOWN");
  if (entry.revoked) throw new ServiceAuthError("KEY_REVOKED");
  if (entry.notAfter && Date.parse(entry.notAfter) <= now) throw new ServiceAuthError("KEY_EXPIRED");
  const seconds = Math.floor(now / 1000);
  if (Math.abs(seconds - Number(timestamp)) > SKEW_SECONDS) throw new ServiceAuthError("TIMESTAMP_SKEW");
  const expected = createHmac("sha256", entry.key).update(canonical({ serviceId, keyId, method, uri, timestamp, nonce, body })).digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ServiceAuthError("SIGNATURE_INVALID");
  if (!nonceStore || typeof nonceStore.claim !== "function") throw new ServiceAuthError("REPLAY_STORE_UNAVAILABLE");
  let fresh;
  try { fresh = await nonceStore.claim(serviceId, nonce, (Number(timestamp) + SKEW_SECONDS * 2) * 1000); }
  catch { throw new ServiceAuthError("REPLAY_STORE_UNAVAILABLE"); }
  if (!fresh) throw new ServiceAuthError("REPLAYED");
  return { serviceId, keyId };
}

// In-memory nonce store for tests and single-process development only.
function memoryNonceStore() {
  const seen = new Map();
  return {
    async claim(serviceId, nonce, expiresAt) {
      const now = Date.now();
      for (const [k, exp] of seen) if (exp < now) seen.delete(k);
      const key = serviceId + ":" + nonce;
      if (seen.has(key)) return false;
      seen.set(key, expiresAt);
      return true;
    },
  };
}

module.exports = { VERSION, HEADERS, SKEW_SECONDS, ServiceAuthError, signServiceRequest, verifyServiceRequest, memoryNonceStore, bodyHash };
