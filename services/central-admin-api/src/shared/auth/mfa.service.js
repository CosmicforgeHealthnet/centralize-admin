"use strict";

// MFA lifecycle for HQ admins: enrollment, login challenge, step-up,
// recovery codes, disable and admin-assisted reset.
//
// Security properties:
// - enrollment requires the current password; the pending secret is encrypted
//   at rest and only becomes active after a valid TOTP;
// - verified MFA = an admin_mfa_enrollments row with enrolledAt + an encrypted
//   secret (admin_users.twoFactorEnabled alone is never accepted);
// - each TOTP time-step is accepted at most once per user (replay guard,
//   enforced atomically in the database);
// - 5 consecutive failures lock MFA for 15 minutes; challenges allow 5 tries;
// - recovery codes are random, shown once, stored salted+hashed and consumed
//   atomically;
// - every MFA event is written to admin_auth_events.
// Only call this service once the session/MFA schema is ready.

const crypto = require("node:crypto");
const { comparePassword } = require("../utils/password.util");
const core = require("./mfa-core");
const { authError } = require("./session.service");

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

function createMfaService({ client, sessions, events = async () => {}, notify = async () => {}, clock = () => new Date(), env = process.env }) {
  const now = () => clock();
  const audit = events;

  async function loadUser(id) {
    const user = await client.adminUser.findUnique({ where: { id } });
    if (!user) throw authError(404, "USER_NOT_FOUND", "User not found");
    return user;
  }

  const loadEnrollment = (adminUserId) => client.adminMfaEnrollment.findUnique({ where: { adminUserId } });

  async function isEnrolled(userId) {
    return core.isMfaEnrolled(await loadEnrollment(userId));
  }

  function assertNotLocked(enrollment) {
    if (enrollment?.lockedUntil && enrollment.lockedUntil > now()) {
      throw authError(429, "MFA_LOCKED", "Too many failed codes. Try again later");
    }
  }

  async function recordFailure(enrollment, context) {
    const attempts = (enrollment.failedAttempts || 0) + 1;
    const lock = attempts >= USER_MAX_FAILURES;
    await client.adminMfaEnrollment.update({
      where: { adminUserId: enrollment.adminUserId },
      data: { failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(now().getTime() + USER_LOCK_MS) : enrollment.lockedUntil },
    });
    await audit({ adminUserId: enrollment.adminUserId, action: lock ? "MFA_LOCKED" : "MFA_FAILED", targetId: enrollment.adminUserId, targetType: "admin_user", metadata: { context: context.kind, attempts }, req: context.req });
  }

  async function clearFailures(enrollment) {
    if (enrollment.failedAttempts || enrollment.lockedUntil) {
      await client.adminMfaEnrollment.update({ where: { adminUserId: enrollment.adminUserId }, data: { failedAttempts: 0, lockedUntil: null } });
    }
  }

  // Verify a TOTP against the ACTIVE secret with an atomic replay guard.
  async function acceptTotp(enrollment, code) {
    const secret = core.resolveTotpSecret({ enrollment }, { env });
    if (!secret) return false;
    const step = core.matchTotp(secret, code, now().getTime());
    if (step === null) return false;
    const claimed = await client.adminMfaEnrollment.updateMany({
      where: { adminUserId: enrollment.adminUserId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    return claimed.count === 1;
  }

  async function acceptRecoveryCode(userId, code) {
    if (!core.looksLikeRecoveryCode(code)) return false;
    const rows = await client.adminMfaRecoveryCode.findMany({ where: { adminUserId: userId, usedAt: null } });
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
  async function verifyFactor(userId, { code, recoveryCode, allowRecovery = true, context }) {
    const enrollment = await loadEnrollment(userId);
    if (!core.isMfaEnrolled(enrollment)) throw authError(400, "MFA_NOT_ENROLLED", "Two-factor authentication is not set up");
    assertNotLocked(enrollment);
    let method = null;
    if (code && (await acceptTotp(enrollment, code))) method = "totp";
    else if (allowRecovery && recoveryCode && (await acceptRecoveryCode(userId, recoveryCode))) method = "recovery_code";
    if (!method) {
      await recordFailure(enrollment, context);
      throw authError(401, "MFA_CODE_INVALID", "The code is not valid");
    }
    await clearFailures(enrollment);
    if (method === "recovery_code") {
      const remaining = await client.adminMfaRecoveryCode.count({ where: { adminUserId: userId, usedAt: null } });
      await audit({ adminUserId: userId, action: "MFA_RECOVERY_CODE_USED", targetId: userId, targetType: "admin_user", metadata: { context: context.kind, remaining }, req: context.req });
      await notify(userId, { icon: "alert", title: "Recovery code used", subtitle: `A two-factor recovery code was used. ${remaining} remaining. If this wasn't you, contact security.` });
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
    const enrollment = await loadEnrollment(userId);
    const enrolled = core.isMfaEnrolled(enrollment);
    const remaining = enrolled ? await client.adminMfaRecoveryCode.count({ where: { adminUserId: userId, usedAt: null } }) : 0;
    return {
      enrolled,
      enrolledAt: enrolled ? enrollment.enrolledAt : null,
      pending: Boolean(enrollment?.pendingSecretEncrypted && enrollment.pendingExpiresAt > now()),
      recoveryCodesRemaining: remaining,
      lockedUntil: enrollment?.lockedUntil && enrollment.lockedUntil > now() ? enrollment.lockedUntil : null,
      available: core.loadKeyring(env).available,
    };
  }

  async function startEnrollment(userId, { password, req }) {
    const user = await loadUser(userId);
    if (await isEnrolled(user.id)) throw authError(409, "MFA_ALREADY_ENROLLED", "Two-factor authentication is already active. Disable it first to change devices");
    if (!password || !(await comparePassword(password, user.password))) throw authError(401, "AUTH_PASSWORD_INVALID", "Password is incorrect");
    const secret = core.generateSecret();
    const encrypted = core.encryptSecret(secret, user.id, env); // fails closed (503) without a key
    const expiresAt = new Date(now().getTime() + PENDING_TTL_MS);
    await client.adminMfaEnrollment.upsert({
      where: { adminUserId: user.id },
      create: { adminUserId: user.id, pendingSecretEncrypted: encrypted, pendingExpiresAt: expiresAt },
      update: { pendingSecretEncrypted: encrypted, pendingExpiresAt: expiresAt },
    });
    await audit({ adminUserId: user.id, action: "MFA_ENROLLMENT_STARTED", targetId: user.id, targetType: "admin_user", req });
    const secretBase32 = core.encodeBase32(secret);
    return { secret: secretBase32, otpauthUri: core.otpauthUri({ secretBase32, accountName: user.email }), expiresAt };
  }

  async function activate(userId, { code, sessionId, req }) {
    const enrollment = await loadEnrollment(userId);
    if (core.isMfaEnrolled(enrollment)) throw authError(409, "MFA_ALREADY_ENROLLED", "Two-factor authentication is already active");
    if (!enrollment?.pendingSecretEncrypted || !enrollment.pendingExpiresAt || enrollment.pendingExpiresAt <= now()) {
      throw authError(400, "MFA_ENROLLMENT_EXPIRED", "Start the setup again");
    }
    assertNotLocked(enrollment);
    const secret = core.decryptSecret(enrollment.pendingSecretEncrypted, userId, env);
    const step = core.matchTotp(secret, code, now().getTime());
    if (step === null) {
      await recordFailure(enrollment, { kind: "enrollment", req });
      throw authError(401, "MFA_CODE_INVALID", "The code is not valid");
    }
    const activated = await client.adminMfaEnrollment.updateMany({
      where: { adminUserId: userId, enrolledAt: null, pendingSecretEncrypted: enrollment.pendingSecretEncrypted },
      data: { enrolledAt: now(), secretEncrypted: enrollment.pendingSecretEncrypted, pendingSecretEncrypted: null, pendingExpiresAt: null, lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
    });
    if (activated.count !== 1) throw authError(409, "MFA_ENROLLMENT_CHANGED", "Setup changed. Start again");
    // Compatibility flag only (existing column); never keep a plaintext secret.
    await client.adminUser.update({ where: { id: userId }, data: { twoFactorEnabled: true, twoFactorSecret: null } });
    const recoveryCodes = await issueRecoveryCodes(userId);
    if (sessionId) await sessions.markMfaVerified(sessionId);
    await audit({ adminUserId: userId, action: "MFA_ENROLLED", targetId: userId, targetType: "admin_user", req });
    await notify(userId, { icon: "check", title: "Two-factor authentication enabled", subtitle: "Your account now requires an authenticator code to sign in." });
    return { recoveryCodes };
  }

  async function stepUp(userId, { sessionId, code, recoveryCode, req }) {
    if (!sessionId) throw authError(403, "MFA_SESSION_REQUIRED", "Sign in again to confirm with two-factor authentication");
    const method = await verifyFactor(userId, { code, recoveryCode, context: { kind: "step_up", req } });
    const verifiedAt = await sessions.markMfaVerified(sessionId);
    await audit({ adminUserId: userId, action: "MFA_STEP_UP", targetId: sessionId, targetType: "admin_session", metadata: { method }, req });
    return { verifiedAt, method };
  }

  async function regenerateRecoveryCodes(userId, { req }) {
    if (!(await isEnrolled(userId))) throw authError(400, "MFA_NOT_ENROLLED", "Two-factor authentication is not set up");
    const recoveryCodes = await issueRecoveryCodes(userId);
    await audit({ adminUserId: userId, action: "MFA_RECOVERY_CODES_REGENERATED", targetId: userId, targetType: "admin_user", req });
    await notify(userId, { icon: "alert", title: "Recovery codes regenerated", subtitle: "Your previous recovery codes no longer work." });
    return { recoveryCodes };
  }

  async function clearEnrollment(userId) {
    await client.$transaction([
      client.adminMfaEnrollment.deleteMany({ where: { adminUserId: userId } }),
      client.adminMfaRecoveryCode.deleteMany({ where: { adminUserId: userId } }),
      client.adminMfaChallenge.deleteMany({ where: { adminUserId: userId } }),
      client.adminUser.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } }),
    ]);
  }

  async function disable(userId, { password, code, recoveryCode, sessionId, req }) {
    const user = await loadUser(userId);
    if (!(await isEnrolled(userId))) throw authError(400, "MFA_NOT_ENROLLED", "Two-factor authentication is not set up");
    if (!password || !(await comparePassword(password, user.password))) throw authError(401, "AUTH_PASSWORD_INVALID", "Password is incorrect");
    await verifyFactor(userId, { code, recoveryCode, context: { kind: "disable", req } });
    await clearEnrollment(userId);
    // Other sessions may have been opened with the old factor; end them.
    await sessions.revokeAllForUser(userId, "MFA_DISABLED", { exceptSessionId: sessionId });
    await audit({ adminUserId: userId, action: "MFA_DISABLED", targetId: userId, targetType: "admin_user", req });
    await notify(userId, { icon: "alert", title: "Two-factor authentication disabled", subtitle: "If this wasn't you, contact security immediately." });
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
    const wasEnrolled = await isEnrolled(target.id);
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
    const method = await verifyFactor(user.id, { code, recoveryCode, context: { kind: "login", req } });
    const consumed = await client.adminMfaChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now() } });
    if (consumed.count !== 1) throw authError(401, "MFA_CHALLENGE_INVALID", "Sign in again");
    await audit({ adminUserId: user.id, action: "MFA_VERIFIED", targetId: user.id, targetType: "admin_user", metadata: { method, context: "login" }, req });
    return { user, authMethod: `${challenge.authMethod}+MFA`, method };
  }

  return Object.freeze({ status, startEnrollment, activate, stepUp, regenerateRecoveryCodes, disable, adminReset, createChallenge, completeChallenge, verifyFactor, isEnrolled });
}

module.exports = { createMfaService, canResetOthersMfa, CHALLENGE_TTL_MS };
