"use strict";

// Signed origin header for provider echoes (spec 11.8, GAP 8).
//
//   X-CosmicForge-Origin: <messageId>.<hmac>
//
// <messageId> is the sender's OUTBOUND mail_messages.id (UUID); <hmac> is the
// base64url HMAC-SHA256 of "cosmicforge-mail-origin:v1:<messageId>".
//
// Only used in MAIL_MIXED_RECIPIENT_MODE=full-headers: the provider request
// then carries the complete visible To/Cc, so the provider ALSO delivers to
// our own (internal) addresses through MX. Those internal recipients already
// received their single local copy at queue time, so the inbound echo must be
// dropped. The header lets the inbound pipeline recognise the echo even when
// the provider replaced our Message-ID.
//
// Key: MAIL_ORIGIN_HEADER_SECRET (>= 32 chars). Without it, a key is derived
// from every version of the env encryption keyring (MAIL_ENCRYPTION_KEYS,
// MAIL_KMS_PROVIDER=env only): signing uses the active version, verification
// accepts any version so a key rotation does not resurrect echoes. With KMS
// (keys unwrapped asynchronously) an explicit secret is required; config
// validation refuses full-headers mode otherwise.
//
// Security: verification is constant time. A forged or malformed header is
// "not an echo" and the mail is delivered normally, so an attacker without
// the key cannot suppress delivery. A valid header copied from mail an
// external recipient received only suppresses copies of THAT message in
// mailboxes that already hold it (and the inbound From must be the original
// sender), i.e. it can never hide a different message.

const crypto = require("crypto");
const { parseKeyring } = require("./mail-encryption.service");

const ORIGIN_HEADER = "X-CosmicForge-Origin";
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

function deriveKeys({ secret = "", encryptionKeys = "", activeKey = "", kmsProvider = "env" } = {}) {
  if (String(secret).length >= MIN_SECRET_LENGTH) {
    const key = crypto.createHash("sha256").update(`cosmicforge-mail-origin-key:v1:${secret}`).digest();
    return { signing: key, verifying: [key], source: "secret" };
  }
  if (String(kmsProvider || "env").toLowerCase() !== "env") return { signing: null, verifying: [], source: null };
  const keyring = parseKeyring(encryptionKeys, activeKey);
  if (!keyring.active) return { signing: null, verifying: [], source: null };
  const derive = (raw) => crypto.createHmac("sha256", raw).update("cosmicforge-mail-origin-key:v1").digest();
  const verifying = [...keyring.keys.values()].map(derive);
  return { signing: derive(keyring.keys.get(keyring.active)), verifying, source: "encryption-keyring" };
}

// Can full-headers mode be enabled with this configuration?
function originKeyAvailable(options) {
  return Boolean(deriveKeys(options).signing);
}

function mac(key, messageId) {
  return crypto.createHmac("sha256", key).update(`cosmicforge-mail-origin:v1:${String(messageId).toLowerCase()}`).digest();
}

function createOriginHeader(options = {}) {
  const keys = deriveKeys(options);

  function sign(messageId) {
    if (!keys.signing) throw Object.assign(new Error("origin header key not configured"), { code: "MAIL_ORIGIN_HEADER_SECRET_MISSING" });
    if (!UUID.test(String(messageId))) throw Object.assign(new Error("origin header needs a message UUID"), { code: "MAIL_VALIDATION_FAILED" });
    return `${String(messageId).toLowerCase()}.${mac(keys.signing, messageId).toString("base64url")}`;
  }

  // Returns the referenced message id, or null for anything not validly signed.
  function verify(value) {
    if (!keys.verifying.length || typeof value !== "string") return null;
    const match = VALUE.exec(value.trim());
    if (!match || !UUID.test(match[1])) return null;
    const presented = Buffer.from(match[2], "base64url");
    if (presented.length !== 32) return null;
    let ok = false;
    // Every key is compared (no early exit) so timing does not reveal which matched.
    for (const key of keys.verifying) ok = crypto.timingSafeEqual(presented, mac(key, match[1])) || ok;
    return ok ? match[1].toLowerCase() : null;
  }

  // Finds the header in an inbound header list ([{ name, value }]) or map.
  function extract(headers) {
    if (!headers) return null;
    const entries = Array.isArray(headers) ? headers.map((item) => [item?.name || item?.key, item?.value]) : Object.entries(headers);
    const found = entries.find(([name]) => String(name || "").toLowerCase() === ORIGIN_HEADER.toLowerCase());
    if (!found) return null;
    const value = Array.isArray(found[1]) ? found[1][0] : found[1];
    return value == null ? null : String(value).slice(0, 200);
  }

  return { available: Boolean(keys.signing), source: keys.source, sign, verify, extract, header: ORIGIN_HEADER };
}

function originHeaderFromConfig(config) {
  return createOriginHeader({
    secret: config?.mixedRecipients?.originSecret || "",
    encryptionKeys: config?.encryption?.keys || "",
    activeKey: config?.encryption?.activeKey || "",
    kmsProvider: config?.kms?.provider || "env",
  });
}

module.exports = { createOriginHeader, originHeaderFromConfig, originKeyAvailable, ORIGIN_HEADER, MIN_SECRET_LENGTH };
