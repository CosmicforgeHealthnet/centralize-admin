"use strict";

const { T } = require("../db");

const SAFE_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const SECRETISH = /(token|secret|password|key|signature|authorization|cookie|otp|nin|bank|iban|card|gps|phone|email)/i;

// Metadata is reduced to short scalar values under safe keys; anything that
// looks like a credential or personal datum is dropped, not masked.
function sanitize(metadata = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metadata || {}).slice(0, 24)) {
    if (!SAFE_KEY.test(key) || SECRETISH.test(key)) continue;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 160);
    else if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === "string").slice(0, 16).map((v) => v.slice(0, 64));
  }
  return out;
}

/**
 * Appends a security audit record. Throws on failure: callers on sensitive
 * paths must fail closed when audit persistence is unavailable.
 */
async function recordAudit(db, { correlationId = null, actorType, actorId, productId = null, productAdminId = null, action, outcome, reasonCode = null, metadata = {} }) {
  await db.query(
    `INSERT INTO ${T}hq_product_admin_security_audit (correlation_id, actor_type, actor_id, product_id, product_admin_id, action, outcome, reason_code, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [correlationId, actorType, String(actorId).slice(0, 128), productId, productAdminId, action, outcome, reasonCode, JSON.stringify(sanitize(metadata))]);
}

module.exports = { recordAudit, sanitize };
