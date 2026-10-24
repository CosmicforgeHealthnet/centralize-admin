"use strict";

// Verifies Resend (Svix) webhook signatures over the exact raw request bytes.
// signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
// signature      = base64(HMAC-SHA256(secretBytes, signedContent))
// secret         = "whsec_<base64>"; header svix-signature = "v1,<sig> v1,<sig2>"

const crypto = require("crypto");

const ACCEPTED_EVENT_TYPES = new Set([
  "email.received",
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
]);
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,255}$/;

function decodeSecret(secret) {
  const value = String(secret || "");
  if (!value) return null;
  const raw = value.startsWith("whsec_") ? value.slice(6) : value;
  const bytes = Buffer.from(raw, "base64");
  return bytes.length >= 16 ? bytes : null;
}

function verifyResendWebhook({ rawBody, headers, secret, toleranceSeconds = 300, maxBodyBytes = 262144, now = Date.now() }) {
  const fail = (reason) => ({ ok: false, reason });
  const key = decodeSecret(secret);
  if (!key) return fail("SECRET_NOT_CONFIGURED");
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return fail("EMPTY_BODY");
  if (rawBody.length > maxBodyBytes) return fail("BODY_TOO_LARGE");
  const id = String(headers["svix-id"] || headers["webhook-id"] || "");
  const timestamp = String(headers["svix-timestamp"] || headers["webhook-timestamp"] || "");
  const signatureHeader = String(headers["svix-signature"] || headers["webhook-signature"] || "");
  if (!EVENT_ID.test(id) || !/^\d{1,12}$/.test(timestamp) || !signatureHeader) return fail("MISSING_HEADERS");
  const skew = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (skew > toleranceSeconds) return fail("TIMESTAMP_OUT_OF_TOLERANCE");
  const expected = crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), rawBody])).digest();
  const candidates = signatureHeader.split(" ").map((part) => part.trim()).filter(Boolean);
  const matched = candidates.some((candidate) => {
    const [version, signature] = candidate.split(",");
    if (version !== "v1" || !signature) return false;
    const provided = Buffer.from(signature, "base64");
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });
  if (!matched) return fail("SIGNATURE_MISMATCH");
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return fail("INVALID_JSON");
  }
  if (!payload || typeof payload !== "object" || typeof payload.type !== "string" || typeof payload.data !== "object" || payload.data === null) {
    return fail("INVALID_SCHEMA");
  }
  return { ok: true, eventId: id, timestamp: Number(timestamp), payload, accepted: ACCEPTED_EVENT_TYPES.has(payload.type) };
}

function signResendWebhook({ id, timestamp, rawBody, secret }) {
  const key = decodeSecret(secret);
  const signature = crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), Buffer.from(rawBody)])).digest("base64");
  return `v1,${signature}`;
}

module.exports = { verifyResendWebhook, signResendWebhook, ACCEPTED_EVENT_TYPES };
