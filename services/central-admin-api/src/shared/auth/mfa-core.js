"use strict";

// Shared MFA core (TOTP RFC 6238, encrypted secrets, recovery codes).
// Deliberately free of HTTP and Prisma model knowledge beyond the AdminUser
// columns it documents, so other modules (e.g. Mail step-up) can adopt it.
//
// Verified MFA = an admin_mfa_enrollments row with enrolledAt AND
// secretEncrypted. `admin_users.twoFactorEnabled` alone is NEVER MFA evidence.

const crypto = require("node:crypto");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;
const ENVELOPE_PREFIX = "cfmfa1";

const ApiError = require("../utils/ApiError");

// Surfaces through the standard error envelope ({ code, message }).
class MfaError extends ApiError {
  constructor(code, status = 400, message = code) {
    super(status, message, [{ code }]);
  }
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(text) {
  const clean = String(text || "").toUpperCase().replace(/[\s=-]/g, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

// Returns the matching time-step (window +/-1) or null. Constant-time compare.
function matchTotp(secret, code, nowMs = Date.now(), window = 1) {
  const candidate = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate) || !secret) return null;
  const step = currentStep(nowMs);
  let matched = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = Buffer.from(totpAt(secret, step + delta));
    if (crypto.timingSafeEqual(expected, Buffer.from(candidate)) && matched === null) matched = step + delta;
  }
  return matched;
}

function generateSecret() {
  return crypto.randomBytes(SECRET_BYTES);
}

function otpauthUri({ secretBase32, accountName, issuer = "CosmicForge HQ" }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Secret encryption (AES-256-GCM, keyring with rotation) ───────────────
// AUTH_MFA_ENCRYPTION_KEYS = "k1:<base64 32 bytes>,k2:<base64 32 bytes>"
// AUTH_MFA_ENCRYPTION_ACTIVE_KEY = "k2"   (defaults to the last key listed)
function loadKeyring(env = process.env) {
  const keys = new Map();
  for (const entry of String(env.AUTH_MFA_ENCRYPTION_KEYS || "").split(",")) {
    const [id, material] = entry.trim().split(":");
    if (!id || !material) continue;
    const key = Buffer.from(material, "base64");
    if (key.length === 32 && /^[A-Za-z0-9_-]{1,32}$/.test(id)) keys.set(id, key);
  }
  const ids = [...keys.keys()];
  const activeId = String(env.AUTH_MFA_ENCRYPTION_ACTIVE_KEY || ids[ids.length - 1] || "");
  return { available: keys.has(activeId), activeId, keys };
}

function aadFor(userId) {
  return Buffer.from(`hq-mfa-secret:${userId}`, "utf8");
}

function encryptSecret(secret, userId, env = process.env) {
  const ring = loadKeyring(env);
  if (!ring.available) throw new MfaError("MFA_UNAVAILABLE", 503, "MFA is not configured on this server");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ring.keys.get(ring.activeId), iv);
  cipher.setAAD(aadFor(userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [ENVELOPE_PREFIX, ring.activeId, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

function decryptSecret(envelope, userId, env = process.env) {
  const parts = String(envelope || "").split(":");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX) throw new MfaError("MFA_SECRET_INVALID", 500);
  const ring = loadKeyring(env);
  const key = ring.keys.get(parts[1]);
  if (!key) throw new MfaError("MFA_UNAVAILABLE", 503, "MFA key for this enrollment is not configured");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64"));
  decipher.setAAD(aadFor(userId));
  decipher.setAuthTag(Buffer.from(parts[3], "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64")), decipher.final()]);
}

function needsRewrap(envelope, env = process.env) {
  const ring = loadKeyring(env);
  return ring.available && String(envelope || "").split(":")[1] !== ring.activeId;
}

function isMfaEnrolled(enrollment) {
  return Boolean(enrollment && enrollment.enrolledAt && enrollment.secretEncrypted);
}

// Resolve the TOTP secret from a verified enrollment row. `allowLegacyPlaintext`
// exists solely for a staged migration of callers that previously read the
// plaintext `admin_users.twoFactorSecret`; it defaults to off.
function resolveTotpSecret({ enrollment, user }, { env = process.env, allowLegacyPlaintext = false } = {}) {
  if (isMfaEnrolled(enrollment)) return decryptSecret(enrollment.secretEncrypted, enrollment.adminUserId, env);
  if (allowLegacyPlaintext && user?.twoFactorEnabled && user?.twoFactorSecret) return decodeBase32(user.twoFactorSecret);
  return null;
}

// ── Recovery codes ────────────────────────────────────────────────────────
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
function generateRecoveryCode() {
  const bytes = crypto.randomBytes(10);
  let raw = "";
  for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(code, salt) {
  return crypto.createHash("sha256").update(`${salt}:${normalizeRecoveryCode(code)}`).digest("hex");
}

function looksLikeRecoveryCode(code) {
  return normalizeRecoveryCode(code).length === 10 && !/^\d+$/.test(normalizeRecoveryCode(code));
}

module.exports = {
  MfaError,
  STEP_SECONDS,
  encodeBase32,
  decodeBase32,
  totpAt,
  currentStep,
  matchTotp,
  generateSecret,
  otpauthUri,
  loadKeyring,
  encryptSecret,
  decryptSecret,
  needsRewrap,
  isMfaEnrolled,
  resolveTotpSecret,
  generateRecoveryCode,
  normalizeRecoveryCode,
  hashRecoveryCode,
  looksLikeRecoveryCode,
};
