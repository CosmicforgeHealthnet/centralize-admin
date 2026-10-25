"use strict";

// Single-use, expiring account setup / password links.
//
// Replaces every emailed temporary password (spec section 3, P0): lab admin
// approval, HR account invitations and HR-approved password resets. A link is
// `<tokenId>.<32 random bytes, base64url>`; only SHA-256(link) is stored, so a
// database read never yields a usable link. Redemption is atomic (exactly one
// UPDATE can consume it), rate limited per link, and never logs the secret.
//
// The table arrives with migration 20261031_account_setup_tokens.sql. Until it
// is applied `isReady()` is false and callers must not fall back to sending a
// password: they report that the link is pending instead.

const crypto = require("crypto");
const ApiError = require("../utils/ApiError");

const PURPOSES = Object.freeze({
  ADMIN_INVITE: { subjectKind: "ADMIN_USER", ttlEnv: "ACCOUNT_SETUP_INVITE_TTL_HOURS", defaultHours: 48, maxHours: 168 },
  ADMIN_PASSWORD_RESET: { subjectKind: "ADMIN_USER", ttlEnv: "ACCOUNT_SETUP_RESET_TTL_MINUTES", defaultMinutes: 30, maxMinutes: 120 },
  LAB_ADMIN_SETUP: { subjectKind: "HEALTHNET_USER", ttlEnv: "ACCOUNT_SETUP_LAB_TTL_HOURS", defaultHours: 48, maxHours: 168 },
});
const MAX_ATTEMPTS = 10;
const TOKEN_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

class AccountSetupError extends ApiError {
  constructor(status, code, message, details = []) {
    super(status, message, [{ code, retryable: status === 503 }, ...details]);
  }
}

function ttlMs(purpose, env = process.env) {
  const spec = PURPOSES[purpose];
  const raw = Number.parseInt(String(env[spec.ttlEnv] ?? ""), 10);
  if (spec.defaultMinutes) {
    const minutes = Number.isFinite(raw) && raw >= 5 ? Math.min(raw, spec.maxMinutes) : spec.defaultMinutes;
    return minutes * 60 * 1000;
  }
  const hours = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, spec.maxHours) : spec.defaultHours;
  return hours * 3600 * 1000;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

// Unusable bcrypt input for accounts created before their owner sets a
// password: 64 random bytes that are never stored or disclosed.
function unusablePassword() {
  return crypto.randomBytes(48).toString("base64");
}

function parse(token) {
  const match = TOKEN_PATTERN.exec(String(token || "").trim());
  return match ? { id: match[1], token: match[0] } : null;
}

function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!local || !domain) return null;
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

function setupUrl(token, env = process.env) {
  const base = String(env.ACCOUNT_SETUP_URL || `${String(env.FRONTEND_URL || "").replace(/\/+$/, "")}/account-setup`).replace(/\/+$/, "");
  // The secret travels in the URL fragment, which browsers never send to
  // servers or put in Referer headers.
  return `${base}#token=${encodeURIComponent(token)}`;
}

function createAccountSetupService({ client, readiness, subjects, clock = () => new Date(), env = process.env, logger = null }) {
  // subjects[kind] = { load(id) -> { email, name, active }, setPassword(id, hash, { purpose }) }
  async function isReady() {
    return readiness ? readiness.isReady() : true;
  }

  async function issue({ purpose, subjectId, email, createdBy = null }, tx = null) {
    const spec = PURPOSES[purpose];
    if (!spec) throw new Error(`unknown account setup purpose ${purpose}`);
    const db = tx || client;
    const id = crypto.randomUUID();
    const token = `${id}.${crypto.randomBytes(32).toString("base64url")}`;
    const now = clock();
    const expiresAt = new Date(now.getTime() + ttlMs(purpose, env));
    const write = async (inner) => {
      // Any earlier live link for the same subject/purpose stops working.
      await inner.accountSetupToken.updateMany({ where: { subjectKind: spec.subjectKind, subjectId: String(subjectId), purpose, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
      await inner.accountSetupToken.create({
        data: { id, purpose, subjectKind: spec.subjectKind, subjectId: String(subjectId), emailDomain: String(email || "").split("@")[1]?.toLowerCase().slice(0, 253) || null, tokenHash: hashToken(token), expiresAt, createdBy: createdBy ? String(createdBy).slice(0, 64) : null, createdAt: now },
      });
    };
    if (tx) await write(tx);
    else await db.$transaction(write);
    return { token, tokenId: id, expiresAt, url: setupUrl(token, env) };
  }

  async function revokeFor(purpose, subjectId) {
    const spec = PURPOSES[purpose];
    const result = await client.accountSetupToken.updateMany({ where: { subjectKind: spec.subjectKind, subjectId: String(subjectId), purpose, usedAt: null, revokedAt: null }, data: { revokedAt: clock() } });
    return result.count;
  }

  // Loads a live link or throws one uniform error (no oracle for which part failed).
  async function load(rawToken) {
    if (!(await isReady())) throw new AccountSetupError(503, "ACCOUNT_SETUP_NOT_READY", "Account setup links are not available yet");
    const parsed = parse(rawToken);
    const invalid = new AccountSetupError(400, "ACCOUNT_SETUP_LINK_INVALID", "This link is invalid or has expired. Ask your administrator for a new one.");
    if (!parsed) throw invalid;
    const row = await client.accountSetupToken.findUnique({ where: { id: parsed.id } });
    if (!row) throw invalid;
    const expected = Buffer.from(row.tokenHash, "hex");
    const actual = Buffer.from(hashToken(parsed.token), "hex");
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!matches) {
      await client.accountSetupToken.updateMany({ where: { id: row.id, usedAt: null }, data: { attempts: { increment: 1 } } }).catch(() => {});
      throw invalid;
    }
    if (row.usedAt || row.revokedAt || row.expiresAt <= clock() || row.attempts >= MAX_ATTEMPTS) throw invalid;
    const subject = await subjects[row.subjectKind].load(row.subjectId);
    if (!subject || subject.active === false) throw invalid;
    return { row, subject, token: parsed.token };
  }

  async function inspect(rawToken) {
    const { row, subject } = await load(rawToken);
    return { purpose: row.purpose, email: maskEmail(subject.email), name: subject.name || null, expiresAt: row.expiresAt.toISOString(), loginUrl: row.purpose === "LAB_ADMIN_SETUP" ? String(env.MAIN_APP_URL || "") || null : null };
  }

  async function complete(rawToken, password, { validatePassword, hashPassword }) {
    const { row, subject, token } = await load(rawToken);
    const strength = validatePassword(String(password || ""));
    if (!strength.valid) throw new AccountSetupError(400, "ACCOUNT_SETUP_PASSWORD_WEAK", "Choose a stronger password.", strength.errors.map((message) => ({ field: "password", message })));
    const passwordHash = await hashPassword(String(password));
    // Consume first: of two concurrent redemptions exactly one succeeds.
    const consumed = await client.accountSetupToken.updateMany({ where: { id: row.id, tokenHash: hashToken(token), usedAt: null, revokedAt: null, expiresAt: { gt: clock() } }, data: { usedAt: clock() } });
    if (consumed.count !== 1) throw new AccountSetupError(400, "ACCOUNT_SETUP_LINK_INVALID", "This link is invalid or has expired. Ask your administrator for a new one.");
    try {
      await subjects[row.subjectKind].setPassword(row.subjectId, passwordHash, { purpose: row.purpose });
    } catch (error) {
      // The password was not stored (e.g. the product database is offline):
      // give the link back so the person can retry before it expires.
      await client.accountSetupToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { usedAt: null } }).catch(() => {});
      logger?.error?.(`[AccountSetup] link ${row.id} could not set the password: ${error.code || error.message}`);
      throw new AccountSetupError(503, "ACCOUNT_SETUP_UNAVAILABLE", "We could not finish setting your password. Please try again shortly.");
    }
    logger?.info?.(`[AccountSetup] link ${row.id} redeemed (${row.purpose})`);
    return { purpose: row.purpose, subjectKind: row.subjectKind, subjectId: row.subjectId, email: subject.email, loginUrl: row.purpose === "LAB_ADMIN_SETUP" ? String(env.MAIN_APP_URL || "") || null : null };
  }

  return { isReady, issue, inspect, complete, revokeFor };
}

module.exports = { createAccountSetupService, AccountSetupError, PURPOSES, hashToken, maskEmail, setupUrl, unusablePassword, ttlMs, parse };
