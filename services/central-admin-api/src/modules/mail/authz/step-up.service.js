"use strict";

// Fresh MFA (step-up) verification for privileged Mail actions. Checks a TOTP
// code against the HQ account's enrolled 2FA secret (RFC 6238, SHA-1, 30 s,
// 6 digits, +/-1 step). Merely having twoFactorEnabled=true is NOT accepted.
// Verified codes are recorded per time-step to block replay, and each step-up
// is purpose-bound, short-lived and single use.

const crypto = require("crypto");
const { mailError } = require("../mail.errors");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PURPOSES = new Set(["BREAK_GLASS_REQUEST", "BREAK_GLASS_APPROVAL", "MARKETING_CAMPAIGN_APPROVAL", "MAIL_EXPORT"]);

function decodeBase32(value) {
  const clean = String(value || "").toUpperCase().replace(/[\s=-]/g, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = "";
  for (const char of clean) bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return bytes.length >= 10 ? Buffer.from(bytes) : null;
}

function totpAt(secret, counter, digits = 6) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function matchTotp(secret, code, { now = Date.now(), window = 1, step = 30 } = {}) {
  const normalized = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = Math.floor(now / 1000 / step);
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = totpAt(secret, current + delta);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) return current + delta;
  }
  return null;
}

function createStepUpService({ client, config, clock = () => new Date(), audit }) {
  const ttlSeconds = config.stepUpTtlSeconds || 300;

  async function verify(user, { code, purpose }, context = {}) {
    if (!PURPOSES.has(purpose)) throw mailError("MAIL_VALIDATION_FAILED", { field: "purpose" });
    const row = await client.adminUser.findUnique({
      where: { id: user.id },
      select: { id: true, status: true, twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!row || row.status !== "ACTIVE") throw mailError("MAIL_IDENTITY_INACTIVE");
    const secret = row.twoFactorEnabled ? decodeBase32(row.twoFactorSecret) : null;
    if (!secret) throw mailError("MAIL_MFA_NOT_ENROLLED");
    const now = clock();
    const counter = matchTotp(secret, code, { now: now.getTime() });
    if (counter == null) {
      await audit?.record({ actorAdminUserId: user.id, action: "MAIL_STEP_UP_FAILED", targetType: "admin_user", targetId: user.id, outcome: "DENIED", metadata: { purpose } }, context);
      throw mailError("MAIL_MFA_INVALID");
    }
    try {
      const record = await client.mailStepUpVerification.create({
        data: {
          adminUserId: user.id,
          method: "TOTP",
          purpose,
          verifiedAt: now,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
          totpCounter: BigInt(counter),
          ipAddress: context.ipAddress || null,
        },
      });
      await audit?.record({ actorAdminUserId: user.id, action: "MAIL_STEP_UP_VERIFIED", targetType: "step_up", targetId: record.id, metadata: { purpose } }, context);
      return { stepUpId: record.id, expiresAt: record.expiresAt.toISOString(), purpose };
    } catch (error) {
      if (error?.code === "P2002") throw mailError("MAIL_MFA_INVALID", { reason: "CODE_ALREADY_USED" });
      throw error;
    }
  }

  // Atomically consumes an unexpired, unused step-up for the purpose.
  async function consume(tx, user, stepUpId, purpose) {
    if (!stepUpId) throw mailError("MAIL_STEP_UP_REQUIRED", { purpose });
    const now = clock();
    const result = await tx.mailStepUpVerification.updateMany({
      where: { id: String(stepUpId), adminUserId: user.id, purpose, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (result.count !== 1) throw mailError("MAIL_STEP_UP_REQUIRED", { purpose });
    return String(stepUpId);
  }

  return { verify, consume };
}

module.exports = { createStepUpService, decodeBase32, totpAt, matchTotp, PURPOSES };
