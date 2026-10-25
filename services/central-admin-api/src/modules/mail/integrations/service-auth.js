"use strict";

// Service-to-service authentication for product integrations. Byte-for-byte
// compatible with Karryam Go's shared/go/serviceauth so the existing Go
// client can call HQ without new crypto:
//   X-Service-Name       registered service identity
//   X-Service-Timestamp  unix seconds (max skew MAIL_INTEGRATION_MAX_SKEW_SECONDS)
//   X-Service-Signature  hex HMAC-SHA256(secret, METHOD \n REQUEST_URI \n timestamp \n hex(sha256(body)))
// Secrets: MAIL_INTEGRATION_SERVICE_SECRETS="service-a=secret,service-b=secret"
// (same format as Karryam's ParseSecrets). Secrets never reach the database.
// Replays inside the skew window are harmless: event ids are idempotent.

const crypto = require("crypto");

const HEADERS = Object.freeze({ name: "x-service-name", timestamp: "x-service-timestamp", signature: "x-service-signature" });

function parseServiceSecrets(value) {
  const secrets = new Map();
  for (const part of String(value || "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    let index = entry.indexOf("=");
    if (index === -1) index = entry.indexOf(":");
    if (index <= 0) continue;
    const name = entry.slice(0, index).trim();
    const secret = entry.slice(index + 1).trim();
    if (name && secret) secrets.set(name, Buffer.from(secret, "utf8"));
  }
  return secrets;
}

function signatureFor(method, requestUri, timestamp, body, secret) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [String(method).toUpperCase(), requestUri, timestamp, bodyHash].join("\n");
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

function signServiceRequest({ method, requestUri, body, serviceName, secret, now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000));
  return { "X-Service-Name": serviceName, "X-Service-Timestamp": timestamp, "X-Service-Signature": signatureFor(method, requestUri, timestamp, Buffer.from(body || ""), Buffer.from(secret, "utf8")) };
}

/**
 * Returns { ok: true, serviceName } or { ok: false, status, code }.
 * Unknown services and bad signatures look identical (401) to callers.
 */
function verifyServiceRequest({ method, requestUri, headers, rawBody, secrets, maxSkewSeconds = 300, now = Date.now() }) {
  const name = String(headers[HEADERS.name] || "");
  const timestamp = String(headers[HEADERS.timestamp] || "");
  const signature = String(headers[HEADERS.signature] || "");
  if (!name || !timestamp || !signature) return { ok: false, status: 401, code: "SERVICE_AUTH_REQUIRED" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, status: 401, code: "SERVICE_AUTH_INVALID" };
  const skew = Math.abs(now / 1000 - Number(timestamp));
  if (skew > maxSkewSeconds) return { ok: false, status: 401, code: "SERVICE_AUTH_EXPIRED" };
  const secret = secrets.get(name);
  // Compute anyway so timing does not reveal whether the service exists.
  const expected = signatureFor(method, requestUri, timestamp, rawBody, secret || Buffer.from("unknown-service"));
  const provided = Buffer.from(signature, "utf8");
  const match = provided.length === expected.length && crypto.timingSafeEqual(provided, Buffer.from(expected, "utf8"));
  if (!secret || !match) return { ok: false, status: 401, code: "SERVICE_AUTH_INVALID" };
  return { ok: true, serviceName: name };
}

module.exports = { parseServiceSecrets, signatureFor, signServiceRequest, verifyServiceRequest, HEADERS };
