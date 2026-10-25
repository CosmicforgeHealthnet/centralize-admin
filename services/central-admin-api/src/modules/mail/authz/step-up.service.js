"use strict";

// Fresh MFA (step-up) verification for privileged Mail actions, built on the
// shared HQ MFA system (src/shared/auth/mfa-core + src/shared/auth/mfa.service).
//
// Evidence required for a Mail step-up:
// - a verified HQ MFA enrollment (admin_mfa_enrollments.enrolled_at + an
//   encrypted secret). `admin_users.twoFactorEnabled` / the legacy plaintext
//   `twoFactorSecret` are NEVER accepted;
// - a valid TOTP code, checked by the shared verifier, which enforces the
//   per-user time-step replay guard, the failure lockout and auth-event audit;
// - a live server-side HQ session. The step-up is bound to that session, so a
//   step-up cannot be replayed from another session, and revoking the session
//   (logout, password change, MFA reset, deactivation) voids it.
//
// Each step-up is purpose-bound, short-lived (MAIL_STEP_UP_TTL_SECONDS) and
// single use. It does not mark the HQ session as generally MFA-verified, so a
// Mail step-up cannot be reused for unrelated privileged actions.
// Recovery codes are refused for Mail step-ups: they are meant for sign-in
// recovery, not for authorising privileged mail access.

const { mailError } = require("../mail.errors");
const { isMfaEnrolled, totpAt, decodeBase32 } = require("../../../shared/auth/mfa-core");

const PURPOSES = new Set([
  "BREAK_GLASS_REQUEST",
  "BREAK_GLASS_APPROVAL",
  "MARKETING_CAMPAIGN_APPROVAL",
  "MARKETING_AUTOMATION_PUBLISH",
  "MARKETING_BROADCAST_OVERRIDE",
  "MAIL_EXPORT",
  "MAIL_RETENTION_EXECUTE",
  "MAIL_EMERGENCY_STOP_RELEASE",
  "MAIL_INTEGRATION_ACTIVATE",
]);

// Shared-MFA error codes -> Mail error codes (same envelope, Mail semantics).
const MFA_ERROR_MAP = {
  MFA_NOT_ENROLLED: "MAIL_MFA_NOT_ENROLLED",
  MFA_CODE_INVALID: "MAIL_MFA_INVALID",
  MFA_LOCKED: "MAIL_MFA_LOCKED",
  MFA_UNAVAILABLE: "MAIL_MFA_UNAVAILABLE",
  MFA_SECRET_INVALID: "MAIL_MFA_UNAVAILABLE",
};

function defaultMfaDependencies(client, { clock, env, logger }) {
  // Lazily built from the same Prisma client the Mail app uses.
  const { createMfaService } = require("../../../shared/auth/mfa.service");
  const { createAuthEvents } = require("../../../shared/auth/auth-events");
  const { createSchemaReadiness } = require("../../../shared/auth/schema-readiness");
  const events = createAuthEvents({ client, logger });
  return {
    mfa: createMfaService({ client, sessions: null, events, clock, env }),
    authSchema: createSchemaReadiness({ client, logger }),
  };
}

function createStepUpService({ client, config, clock = () => new Date(), audit, mfa, authSchema, env = process.env, logger = null }) {
  const ttlSeconds = config.stepUpTtlSeconds || 300;
  let deps = mfa ? { mfa, authSchema } : null;
  const dependencies = () => {
    if (!deps) deps = defaultMfaDependencies(client, { clock, env, logger });
    return deps;
  };

  async function schemaReady() {
    const { authSchema: readiness } = dependencies();
    if (!readiness) return true;
    try {
      return await readiness.isReady();
    } catch {
      return false;
    }
  }

  // The caller's session must still be live and belong to the caller.
  async function assertLiveSession(db, userId, sessionId) {
    if (!sessionId) throw mailError("MAIL_MFA_SESSION_REQUIRED");
    const now = clock();
    const session = await db.adminSession.findUnique({ where: { id: String(sessionId) } }).catch(() => null);
    if (!session || session.adminUserId !== userId || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
      throw mailError("MAIL_MFA_SESSION_REQUIRED", { reason: "SESSION_NOT_ACTIVE" });
    }
    return session;
  }

  async function verify(user, { code, purpose } = {}, context = {}) {
    if (!PURPOSES.has(purpose)) throw mailError("MAIL_VALIDATION_FAILED", { field: "purpose" });
    // Fail closed until the shared sessions/MFA migration is applied.
    if (!(await schemaReady())) throw mailError("MAIL_MFA_UNAVAILABLE", { reason: "AUTH_SCHEMA_NOT_READY" });
    const row = await client.adminUser.findUnique({ where: { id: user.id }, select: { id: true, status: true } });
    if (!row || row.status !== "ACTIVE") throw mailError("MAIL_IDENTITY_INACTIVE");
    // Legacy tokens without a server-side session can never step up.
    await assertLiveSession(client, user.id, context.sessionId);
    const enrollment = await client.adminMfaEnrollment.findUnique({ where: { adminUserId: user.id } });
    if (!isMfaEnrolled(enrollment)) throw mailError("MAIL_MFA_NOT_ENROLLED");

    try {
      await dependencies().mfa.verifyFactor(user.id, {
        code,
        allowRecovery: false,
        context: { kind: `mail_step_up:${purpose}`, req: { ip: context.ipAddress || null, headers: {} } },
      });
    } catch (error) {
      const mapped = MFA_ERROR_MAP[error?.code];
      if (!mapped) throw error;
      await audit?.record({ actorAdminUserId: user.id, action: "MAIL_STEP_UP_FAILED", targetType: "admin_user", targetId: user.id, outcome: "DENIED", metadata: { purpose, reason: error.code } }, context);
      throw mailError(mapped);
    }

    // The shared verifier advanced last_used_step atomically to the accepted step.
    const after = await client.adminMfaEnrollment.findUnique({ where: { adminUserId: user.id }, select: { lastUsedStep: true } });
    const now = clock();
    try {
      const record = await client.mailStepUpVerification.create({
        data: {
          adminUserId: user.id,
          method: "TOTP",
          purpose,
          verifiedAt: now,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
          totpCounter: after?.lastUsedStep != null ? BigInt(after.lastUsedStep) : null,
          sessionId: String(context.sessionId),
          ipAddress: context.ipAddress || null,
        },
      });
      await audit?.record({ actorAdminUserId: user.id, action: "MAIL_STEP_UP_VERIFIED", targetType: "step_up", targetId: record.id, metadata: { purpose, sessionBound: true } }, context);
      return { stepUpId: record.id, expiresAt: record.expiresAt.toISOString(), purpose };
    } catch (error) {
      if (error?.code === "P2002") throw mailError("MAIL_MFA_INVALID", { reason: "CODE_ALREADY_USED" });
      throw error;
    }
  }

  // Atomically consumes an unexpired, unused step-up for the purpose, issued on
  // the caller's current session. Re-checks that the account is active, the
  // session is still live and MFA is still enrolled (an MFA reset between
  // verification and use voids the step-up).
  async function consume(tx, user, stepUpId, purpose, context = {}) {
    if (!stepUpId) throw mailError("MAIL_STEP_UP_REQUIRED", { purpose });
    const db = tx || client;
    const account = await db.adminUser.findUnique({ where: { id: user.id }, select: { status: true } });
    if (!account || account.status !== "ACTIVE") throw mailError("MAIL_IDENTITY_INACTIVE");
    await assertLiveSession(db, user.id, context.sessionId).catch(() => {
      throw mailError("MAIL_STEP_UP_REQUIRED", { purpose, reason: "SESSION_NOT_ACTIVE" });
    });
    const enrollment = await db.adminMfaEnrollment.findUnique({ where: { adminUserId: user.id } });
    if (!isMfaEnrolled(enrollment)) throw mailError("MAIL_STEP_UP_REQUIRED", { purpose, reason: "MFA_NOT_ENROLLED" });
    const now = clock();
    const result = await db.mailStepUpVerification.updateMany({
      where: { id: String(stepUpId), adminUserId: user.id, purpose, sessionId: String(context.sessionId), consumedAt: null, expiresAt: { gt: now }, verifiedAt: { gte: enrollment.enrolledAt } },
      data: { consumedAt: now },
    });
    if (result.count !== 1) throw mailError("MAIL_STEP_UP_REQUIRED", { purpose });
    return String(stepUpId);
  }

  return { verify, consume };
}

module.exports = { createStepUpService, PURPOSES, totpAt, decodeBase32 };
