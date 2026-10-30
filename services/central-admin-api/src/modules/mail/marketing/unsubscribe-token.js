"use strict";

// Signed, stateless unsubscribe / preference tokens for marketing email.
// token = base64url(JSON {v,o,c,t}) + "." + base64url(HMAC-SHA256(secret, body))
// - o: organization (brand) id, c: contact id, t: topic or "*"
// - no expiry: unsubscribe links must keep working long after the send;
// - a previous secret is accepted for verification during rotation;
// - the token carries no email address (links do not leak PII in logs).

const crypto = require("crypto");

const VERSION = 1;

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function mac(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest();
}

function signUnsubscribeToken({ organizationId, contactId, topic }, secret) {
  if (!secret || secret.length < 32) throw Object.assign(new Error("Unsubscribe secret is not configured"), { code: "MAIL_UNSUBSCRIBE_NOT_CONFIGURED" });
  const body = b64url(JSON.stringify({ v: VERSION, o: organizationId, c: contactId, t: topic || "*" }));
  return `${body}.${b64url(mac(secret, body))}`;
}

function verifyUnsubscribeToken(token, secrets) {
  const value = String(token || "");
  if (value.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
  const [body, signature] = value.split(".");
  const provided = Buffer.from(signature, "base64url");
  const valid = secrets.filter((secret) => secret && secret.length >= 32).some((secret) => {
    const expected = mac(secret, body);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.v !== VERSION || typeof payload.o !== "string" || typeof payload.c !== "string" || typeof payload.t !== "string") return null;
    return { organizationId: payload.o, contactId: payload.c, topic: payload.t };
  } catch {
    return null;
  }
}

function unsubscribeUrl(config, claims) {
  if (!config.publicApiUrl) return null;
  return `${config.publicApiUrl}/api/mail/v1/public/unsubscribe/${signUnsubscribeToken(claims, config.unsubscribe.secret)}`;
}

module.exports = { signUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl };
