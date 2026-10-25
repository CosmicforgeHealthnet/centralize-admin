"use strict";

// MFA lifecycle for HQ admins: enrollment, login challenge, step-up,
// recovery codes, disable and admin-assisted reset.
//
// Security properties:
// - enrollment requires the current password; the pending secret is encrypted
//   at rest and only becomes active after a valid TOTP;
// - verified MFA = mfaEnrolledAt + mfaSecretEncrypted (twoFactorEnabled alone
//   is never accepted);
// - each TOTP time-step is accepted at most once per user (replay guard,
//   enforced atomically in the database);
// - 5 consecutive failures lock MFA for 15 minutes; challenges allow 5 tries;
// - recovery codes are random, shown once, stored salted+hashed and consumed
//   atomically;
// - every MFA event is written to the audit log.

const crypto = require("node:crypto");
const { comparePassword } = require("../../shared/utils/password.util");
const core = require("../../shared/auth/mfa-core");
const { authError } = require("../../shared/auth/session.service");

const PENDING_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const USER_MAX_FAILURES = 5;
const USER_LOCK_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

// Who may reset another admin's MFA: SUPER, or the HR admin rule already used
// for approving password resets (MANAGEMENT department team-lead ADMIN).
function canResetOthersMfa(actor) {
  if (!actor || actor.status !== "ACTIVE") return false;
  if (actor.tier === "SUPER") return true;
  return actor.tier === "ADMIN" && actor.department === "MANAGEMENT" && actor.isTeamLead === true;
}

function createMfaService({ client, sessions, audit = async () => {}, notify = async () => {}, clock = () => new Date(), env = process.env }) {
  const now = () => clock();

  async function loadUser(id) {
    const user = await client.adminUser.findUnique({ where: { id } });
    if (!user) throw authError(404, "USER_NOT_FOUND", "User not found");
    return user;
  }

  function assertNotLocked(user) {
    if (user.mfaLockedUntil && user.mfaLockedUntil > now()) {
      throw authError(429, "MFA_LOCKED", "Too many failed codes. Try again later");
    }
  }

  async function recordFailure(user, context) {
    const attempts = (user.mfaFailedAttempts || 0) + 1;
    const lock = attempts >= USER_MAX_FAILURES;
    await client.adminUser.update({
      where: { id: user.id },
      data: { mfaFailedAttempts: lock ? 0 : attempts, mfaLockedUntil: lock ? new Date(now().getTime() + USER_LOCK_MS) : user.mfaLockedUntil },
    });
    await audit({ adminUserId: user.id, action: lock ? "MFA_LOCKED" : "MFA_FAILED", targetId: user.id, targetType: "admin_user", metadata: { context, attempts }, req: context.req });
  }

  async function clearFailures(user) {
    if (user.mfaFailedAttempts || user.mfaLockedUntil) {
      await client.adminUser.update({ where: { id: user.id }, data: { mfaFailedAttempts: 0, mfaLockedUntil: null } });
    }
  }

  // Verify a TOTP against the user's ACTIVE secret with an atomic replay guard.
  async function acceptTotp(user, code) {
    const secret = core.resolveTotpSecret(user, { env });
    if (!secret) return false;
    const step = core.matchTotp(secret, code, now().getTime());
    if (step === null) return false;
    const claimed = await client.adminUser.updateMany({
      where: { id: user.id, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
      data: { mfaLastUsedStep: step },
    });
    return claimed.count === 1;
  }

  async function acceptRecoveryCode(user, code) {
    if (!core.looksLikeRecoveryCode(code)) return false;
    const rows = await client.adminMfaRecoveryCode.findMany({ where: { adminUserId: user.id, usedAt: null } });
    for (const row of rows) {
      const expected = Buffer.from(row.codeHash);
      const actual = Buffer.from(core.hashRecoveryCode(code, row.salt));
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        const consumed = await client.adminMfaRecoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now() } });
        return consumed.count === 1;
      }
    }
    return false;
  }

  // Shared factor check: TOTP or (when allowed) a recovery code.
  async function verifyFactor(user, { code, recoveryCode, allowRecovery = true, context }) {
    if (!core.isMfaEnrolled(user)) throw authError(400, "MFA_NOT_ENROLLED", "Two-factor authentication is not set up");
    assertNotLocked(user);
    let method = null;
    if (code && (await acceptTotp(user, code))) method = "totp";
    else if (allowRecovery && recoveryCode && (await acceptRecoveryCode(user, recoveryCode))) method = "recovery_code";
    if (!method) {
      await recordFailure(user, context);
      throw authError(401, "MFA_CODE_INVALID", "The code is not valid");
    }
    await clearFailures(user);
    if (method === "recovery_code") {
      const remaining = await client.adminMfaRecoveryCode.count({ where: { adminUserId: user.id, usedAt: null } });
      await audit({ adminUserId: user.id, action: "MFA_RECOVERY_CODE_USED", targetId: user.id, targetType: "admin_user", metadata: { context: context.kind, remaining }, req: context.req });
      await notify(user.id, { icon: "alert", title: "Recovery code used", subtitle: `A two-factor recovery code was used. ${remaining} remaining. If this wasn't you, contact security.` });
    }
    return method;
  }

  async function issueRecoveryCodes(userId) {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => core.generateRecoveryCode());
    await client.$transaction([
      client.adminMfaRecoveryCode.deleteMany({ where: { adminUserId: userId } }),
      client.adminMfaRecoveryCode.createMany({
        data: codes.map((code) => {
          const salt = crypto.randomBytes(16).toString("hex");
          return { adminUserId: userId, salt, codeHash: core.hashRecoveryCode(code, salt) };
        }),
      }),
    ]);
    return codes;
  }

  async function status(userId) {
    const user = await loadUser(userId);
    const remaining = core.isMfaEnrolled(user) ? await client.adminMfaRecoveryCode.count({ where: { adminUserId: userId, usedAt: null } }) : 0;
    return {
      enrolled: core.isMfaEnrolled(user),
      enrolledAt: user.mfaEnrolledAt,
      pending: Boolean(user.mfaPendingSecretEncrypted && user.mfaPendingExpiresAt > now()),
      recoveryCodesRemaining: remaining,
      lockedUntil: user.mfaLockedUntil && user.mfaLockedUntil > now() ? user.mfaLockedUntil : null,
      available: core.loadKeyring(env).available,
    };
  }

  async function startEnrollment(userId, { password, req }) {
    const user = await loadUser(userId);
    if (core.isMfaEnrolled(user)) throw authError(409, "MFA_ALREADY_ENROLLED", "Two-factor authentication is already active. Disable it first to change devices");
    if (!password || !(await comparePassword(password, user.password))) throw authError(401, "AUTH_PASSWORD_INVALID", "Password is incorrect");
    const secret = core.generateSecret();
    const encrypted = core.encryptSecret(secret, user.id, env); // fails closed (503) without a key
    const expiresAt = new Date(now().getTime() + PENDING_TTL_MS);
    await client.adminUser.update({ where: { id: user.id }, data: { mfaPendingSecretEncrypted: encrypted, mfaPendingExpiresAt: expiresAt } });
    await audit({ adminUserId: user.id, action: "MFA_ENROLLMENT_STARTED", targetId: user.id, targetType: "admin_user", req });
    const secretBase32 = core.encodeBase32(secret);
    return { secret: secretBase32, otpauthUri: core.otpauthUri({ secretBase32, accountName: user.email }), expiresAt };
  }

  async function activate(userId, { code, sessionId, req }) {
    const user = await loadUser(userId);
    if (core.isMfaEnrolled(user)) throw authError(409, "MFA_ALREADY_ENROLLED", "Two-factor authentication is already active");
    if (!user.mfaPendingSecretEncrypted || !user.mfaPendingExpiresAt || user.mfaPendingExpiresAt <= now()) {
      throw authError(400, "MFA_ENROLLMENT_EXPIRED", "Start the setup again");
    }
    assertNotLocked(user);
    const secret = core.decryptSecret(user.mfaPendingSecretEncrypted, user.id, env);
    const step = core.matchTotp(secret, code, now().getTime());
    if (step === null) {
      await recordFailure(user, { kind: "enrollment", req });
      throw authError(401, "MFA_CODE_INVALID", "The code is not valid");
    }
    const activated = await client.adminUser.updateMany({
      where: { id: user.id, mfaEnrolledAt: null, mfaPendingSecretEncrypted: user.mfaPendingSecretEncrypted },
      data: {
        mfaEnrolledAt: now(),
        mfaSecretEncrypted: user.mfaPendingSecretEncrypted,
        mfaPendingSecretEncrypted: null,
        mfaPendingExpiresAt: null,
        mfaLastUsedStep: step,
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
        twoFactorEnabled: true,
        twoFactorSecret: null, // never keep a plaintext copy
      },
    });
    if (activated.count !== 1) throw authError(409, "MFA_ENROLLMENT_CHANGED", "Setup changed. Start again");
    const recoveryCodes = await issueRecoveryCodes(user.id);
    if (sessionId) await sessions.markMfaVerified(sessionId);
    await audit({ adminUserId: user.id, action: "MFA_ENROLLED", targetId: user.id, targetType: "admin_user", req });
    await notify(user.id, { icon: "check", title: "Two-factor authentication enabled", subtitle: "Your account now requires an authenticator code to sign in." });
    return { recoveryCodes };
  }

  async function stepUp(userId, { sessionId, code, recoveryCode, req }) {
    if (!sessionId) throw authError(403, "MFA_SESSION_REQUIRED", "Sign in again to confirm with two-factor authentication");
    const user = await loadUser(userId);
    const method = await verifyFactor(user, { code, recoveryCode, context: { kind: "step_up", req } });
    const verifiedAt = await sessions.markMfaVerified(sessionId);
    await audit({ adminUserId: user.id, action: "MFA_STEP_UP", targetId: sessionId, targetType: "admin_session", metadata: { method }, req });
    return { verifiedAt, method };
  }

  async function regenerateRecoveryCodes(userId, { req }) {
    const user = await loadUser(userId);
    if (!core.isMfaEnrolled(user)) throw authError(400, "MFA_NOT_ENROLLED", "Two-factor authentication is not set up");
    const recoveryCodes = await issueRecoveryCodes(user.id);
    await audit({ adminUserId: user.id, action: "MFA_RECOVERY_CODES_REGENERATED", targetId: user.id, targetType: "admin_user", req });
    await notify(user.id, { icon: "alert", title: "Recovery codes regenerated", subtitle: "Your previous recovery codes no longer work." });
    return { recoveryCodes };
  }

  async function clearEnrollment(userId) {
    await client.$transaction([
      client.adminUser.update({
        where: { id: userId },
        data: { mfaEnrolledAt: null, mfaSecretEncrypted: null, mfaPendingSecretEncrypted: null, mfaPendingExpiresAt: null, mfaLastUsedStep: null, mfaFailedAttempts: 0, mfaLockedUntil: null, twoFactorEnabled: false, twoFactorSecret: null },
      }),
      client.adminMfaRecoveryCode.deleteMany({ where: { adminUserId: userId } }),
      client.adminMfaChallenge.deleteMany({ where: { adminUserId: userId } }),
    ]);
  }

  async function disable(userId, { password, code, recoveryCode, sessionId, req }) {
    const user = await loadUser(userId);
    if (!core.isMfaEnrolled(user)) throw authError(400, "MFA_NOT_ENROLLED", "Two-factor authentication is not set up");
    if (!password || !(await comparePassword(password, user.password))) throw authError(401, "AUTH_PASSWORD_INVALID", "Password is incorrect");
    await verifyFactor(user, { code, recoveryCode, context: { kind: "disable", req } });
    await clearEnrollment(user.id);
    // Other sessions may have been opened with the old factor; end them.
    await sessions.revokeAllForUser(user.id, "MFA_DISABLED", { exceptSessionId: sessionId });
    await audit({ adminUserId: user.id, action: "MFA_DISABLED", targetId: user.id, targetType: "admin_user", req });
    await notify(user.id, { icon: "alert", title: "Two-factor authentication disabled", subtitle: "If this wasn't you, contact security immediately." });
    return { disabled: true };
  }

  async function adminReset(actor, { targetUserId, reason, req }) {
    const actorRow = await loadUser(actor.id);
    if (!canResetOthersMfa(actorRow)) throw authError(403, "MFA_RESET_FORBIDDEN", "You are not allowed to reset two-factor authentication");
    if (actorRow.id === targetUserId) throw authError(403, "MFA_RESET_SELF_FORBIDDEN", "Use your recovery codes or ask another administrator");
    const text = String(reason || "").trim();
    if (text.length < 10 || text.length > 500) throw authError(400, "MFA_RESET_REASON_REQUIRED", "Give a reason (10-500 characters)");
    const target = await loadUser(targetUserId);
    if (target.tier === "SUPER" && actorRow.tier !== "SUPER") throw authError(403, "MFA_RESET_FORBIDDEN", "Only a SUPER administrator can reset a SUPER account");
    const wasEnrolled = core.isMfaEnrolled(target);
    await clearEnrollment(target.id);
    const revoked = await sessions.revokeAllForUser(target.id, "MFA_ADMIN_RESET", { actorId: actorRow.id });
    await audit({ adminUserId: actorRow.id, action: "MFA_ADMIN_RESET", targetId: target.id, targetType: "admin_user", metadata: { reason: text, wasEnrolled, sessionsRevoked: revoked }, req });
    await notify(target.id, { icon: "alert", title: "Two-factor authentication was reset", subtitle: "An administrator reset your two-factor authentication. Set it up again after you sign in." });
    return { reset: true, wasEnrolled, sessionsRevoked: revoked };
  }

  // ── Login challenge ────────────────────────────────────────────────────
  async function createChallenge(user, { authMethod, ipAddress, userAgent }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS);
    await client.adminMfaChallenge.deleteMany({ where: { adminUserId: user.id, OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: now() } }] } });
    await client.adminMfaChallenge.create({
      data: { adminUserId: user.id, tokenHash: sha256(token), authMethod, expiresAt, ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null, userAgent: userAgent ? String(userAgent).slice(0, 512) : null },
    });
    await audit({ adminUserId: user.id, action: "MFA_CHALLENGE_ISSUED", targetId: user.id, targetType: "admin_user", metadata: { authMethod }, req: { ip: ipAddress, headers: { "user-agent": userAgent } } });
    return { challengeToken: token, expiresAt, ttlMs: CHALLENGE_TTL_MS };
  }

  // Complete the second login step. Returns the user + auth method; the caller
  // then mints a brand-new session (no session existed before this point).
  async function completeChallenge({ challengeToken, code, recoveryCode, req }) {
    if (!challengeToken) throw authError(401, "MFA_CHALLENGE_INVALID", "Sign in again");
    const challenge = await client.adminMfaChallenge.findUnique({ where: { tokenHash: sha256(challengeToken) } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now() || challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      throw authError(401, "MFA_CHALLENGE_INVALID", "Sign in again");
    }
    const bumped = await client.adminMfaChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, attempts: challenge.attempts }, data: { attempts: { increment: 1 } } });
    if (bumped.count !== 1) throw authError(401, "MFA_CHALLENGE_INVALID", "Sign in again");
    const user = await loadUser(challenge.adminUserId);
    if (user.status !== "ACTIVE" && user.status !== "PENDING") throw authError(403, "AUTH_ACCOUNT_INACTIVE", "Account is not active");
    const method = await verifyFactor(user, { code, recoveryCode, context: { kind: "login", req } });
    const consumed = await client.adminMfaChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now() } });
    if (consumed.count !== 1) throw authError(401, "MFA_CHALLENGE_INVALID", "Sign in again");
    await audit({ adminUserId: user.id, action: "MFA_VERIFIED", targetId: user.id, targetType: "admin_user", metadata: { method, context: "login" }, req });
    return { user, authMethod: `${challenge.authMethod}+MFA`, method };
  }

  return Object.freeze({ status, startEnrollment, activate, stepUp, regenerateRecoveryCodes, disable, adminReset, createChallenge, completeChallenge, verifyFactor, isEnrolled: core.isMfaEnrolled });
}

module.exports = { createMfaService, canResetOthersMfa, CHALLENGE_TTL_MS };
