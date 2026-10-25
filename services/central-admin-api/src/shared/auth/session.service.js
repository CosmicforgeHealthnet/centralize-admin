"use strict";

// Server-side HQ sessions.
// - A session is created only after a successful primary login (and MFA when
//   enrolled). Session ids are generated here, never accepted from clients,
//   so session fixation is not possible.
// - Refresh tokens are opaque random values, stored as SHA-256 hashes, linked
//   to a session ("family") and rotated on every use. Presenting an already
//   rotated token outside a short race window revokes the whole session.
// - Access JWTs carry `sid`; authenticate() rejects them once the session is
//   revoked or expired, so logout/revocation takes effect immediately.

const crypto = require("node:crypto");
const ApiError = require("../utils/ApiError");
const { generateAccessToken } = require("../utils/jwt.util");
const { loadSessionConfig } = require("./session.config");

const authError = (status, code, message) => new ApiError(status, message, [{ code }]);
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function csrfSecret(env = process.env) {
  if (env.AUTH_CSRF_SECRET) return Buffer.from(String(env.AUTH_CSRF_SECRET));
  if (!env.ADMIN_JWT_SECRET) throw authError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
  // Derived, domain-separated key so the JWT secret is never used directly.
  return crypto.createHmac("sha256", String(env.ADMIN_JWT_SECRET)).update("cf-hq-csrf-v1").digest();
}

function csrfTokenFor(session, env = process.env) {
  return crypto.createHmac("sha256", csrfSecret(env)).update(`${session.id}:${session.csrfNonce}`).digest("base64url");
}

function verifyCsrfToken(session, presented, env = process.env) {
  if (!presented || typeof presented !== "string") return false;
  const expected = Buffer.from(csrfTokenFor(session, env));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function accessPayload(user, session) {
  return { sub: user.id, email: user.email, tier: user.tier, name: user.name, isTeamLead: user.isTeamLead, sid: session.id };
}

// Only call the service once getAuthRuntime().ready is true: it reads and
// writes the session tables added by migration 20261025.
function createSessionService({ client, clock = () => new Date(), env = process.env, events = async () => {} } = {}) {
  if (!client) throw new Error("createSessionService requires a Prisma client");
  const config = () => loadSessionConfig(env);

  function isLive(session, now = clock()) {
    return Boolean(session && !session.revokedAt && session.idleExpiresAt > now && session.absoluteExpiresAt > now);
  }

  async function revokeTokensOfSessions(ids, now = clock()) {
    if (!ids.length) return;
    await client.adminSessionRefreshToken.updateMany({ where: { sessionId: { in: ids }, revokedAt: null }, data: { revokedAt: now } });
  }

  async function enforceCap(adminUserId, cfg) {
    const now = clock();
    const active = await client.adminSession.findMany({
      where: { adminUserId, revokedAt: null, absoluteExpiresAt: { gt: now }, idleExpiresAt: { gt: now } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const excess = active.length - cfg.maxSessionsPerUser;
    if (excess > 0) {
      const ids = active.slice(0, excess).map((row) => row.id);
      await client.adminSession.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: now, revokeReason: "SESSION_LIMIT" } });
      await revokeTokensOfSessions(ids, now);
    }
  }

  async function issueTokens(session, user, { ipAddress, userAgent } = {}) {
    const cfg = config();
    const now = clock();
    const refreshToken = crypto.randomBytes(32).toString("base64url");
    await client.adminSessionRefreshToken.create({
      data: {
        sessionId: session.id,
        adminUserId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: session.absoluteExpiresAt,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
      },
    });
    const accessTtlSeconds = Math.max(1, Math.min(cfg.accessTokenTtlSeconds, Math.floor((session.absoluteExpiresAt - now) / 1000)));
    return {
      accessToken: generateAccessToken(accessPayload(user, session), { expiresInSeconds: accessTtlSeconds }),
      refreshToken,
      accessTtlSeconds,
      refreshTtlMs: Math.max(0, session.absoluteExpiresAt - now),
      csrfToken: csrfTokenFor(session, env),
    };
  }

  async function createSession(user, { authMethod, ipAddress, userAgent, mfaVerified = false }) {
    const cfg = config();
    const now = clock();
    const absoluteExpiresAt = new Date(now.getTime() + cfg.absoluteTimeoutSeconds * 1000);
    const idleExpiresAt = new Date(Math.min(absoluteExpiresAt.getTime(), now.getTime() + cfg.idleTimeoutSeconds * 1000));
    const session = await client.adminSession.create({
      data: {
        adminUserId: user.id,
        mode: cfg.mode,
        authMethod,
        csrfNonce: crypto.randomBytes(24).toString("base64url"),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
        mfaVerifiedAt: mfaVerified ? now : null,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
      },
    });
    await enforceCap(user.id, cfg);
    await events({ adminUserId: user.id, action: "SESSION_CREATED", targetId: session.id, targetType: "admin_session", metadata: { authMethod, mode: cfg.mode, mfaVerified } });
    const tokens = await issueTokens(session, user, { ipAddress, userAgent });
    return { session, ...tokens };
  }

  async function revokeSession(sessionId, reason, { actorId = null } = {}) {
    const now = clock();
    const changed = await client.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now, revokeReason: reason } });
    await revokeTokensOfSessions([sessionId], now);
    if (changed.count) {
      const session = await client.adminSession.findUnique({ where: { id: sessionId }, select: { adminUserId: true } });
      await events({ adminUserId: actorId || session?.adminUserId, action: "SESSION_REVOKED", targetId: sessionId, targetType: "admin_session", metadata: { reason } });
    }
    return changed.count > 0;
  }

  // Ends every session of a user AND their pre-session refresh tokens.
  async function revokeAllForUser(adminUserId, reason, { exceptSessionId = null, actorId = null } = {}) {
    const now = clock();
    const where = { adminUserId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) };
    const sessions = await client.adminSession.findMany({ where, select: { id: true } });
    await client.adminSession.updateMany({ where, data: { revokedAt: now, revokeReason: reason } });
    await revokeTokensOfSessions(sessions.map((row) => row.id), now);
    await client.refreshToken.updateMany({ where: { adminUserId, isRevoked: false }, data: { isRevoked: true } });
    await events({ adminUserId: actorId || adminUserId, action: "SESSIONS_REVOKED_ALL", targetId: adminUserId, targetType: "admin_user", metadata: { reason, count: sessions.length } });
    return sessions.length;
  }

  // Validate the session referenced by an access token. Throws 401 when the
  // session is unknown, revoked, expired or belongs to someone else.
  async function validateAccess(decoded) {
    const session = await client.adminSession.findUnique({ where: { id: String(decoded.sid) } });
    const now = clock();
    if (!session || session.adminUserId !== decoded.sub) throw authError(401, "AUTH_SESSION_INVALID", "Session is not valid");
    if (session.revokedAt) throw authError(401, "AUTH_SESSION_REVOKED", "Session has ended. Please log in again");
    if (session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) throw authError(401, "AUTH_SESSION_EXPIRED", "Session expired. Please log in again");
    const cfg = config();
    if (now - session.lastSeenAt >= cfg.lastSeenWriteIntervalSeconds * 1000) {
      const idleExpiresAt = new Date(Math.min(session.absoluteExpiresAt.getTime(), now.getTime() + cfg.idleTimeoutSeconds * 1000));
      await client.adminSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } });
      session.lastSeenAt = now;
      session.idleExpiresAt = idleExpiresAt;
    }
    return session;
  }

  // A refresh token minted before activation lives in admin_refresh_tokens.
  // Upgrade it into a tracked session (same semantics as the old rotation).
  async function upgradeLegacyRefresh(token, { ipAddress, userAgent }) {
    const now = clock();
    const legacy = await client.refreshToken.findUnique({ where: { token: sha256(token) }, include: { adminUser: true } });
    if (!legacy || legacy.isRevoked || legacy.expiresAt <= now) throw authError(401, "AUTH_REFRESH_INVALID", "Invalid or expired refresh token");
    if (legacy.adminUser.status !== "ACTIVE") throw authError(403, "AUTH_ACCOUNT_INACTIVE", "Account is not active");
    const claimed = await client.refreshToken.updateMany({ where: { id: legacy.id, isRevoked: false }, data: { isRevoked: true } });
    if (claimed.count !== 1) throw authError(401, "AUTH_REFRESH_INVALID", "Invalid or expired refresh token");
    const created = await createSession(legacy.adminUser, { authMethod: "LEGACY_REFRESH", ipAddress, userAgent });
    return { user: legacy.adminUser, ...created };
  }

  async function rotateRefresh(token, { ipAddress, userAgent }) {
    const cfg = config();
    const now = clock();
    const stored = await client.adminSessionRefreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { session: { include: { adminUser: true } } } });
    if (!stored) return upgradeLegacyRefresh(token, { ipAddress, userAgent });

    const session = stored.session;
    if (stored.rotatedAt) {
      const withinGrace = now - stored.rotatedAt <= cfg.refreshReuseGraceSeconds * 1000;
      if (withinGrace && isLive(session, now)) {
        // Two tabs refreshed at once; the browser already holds the newer cookie.
        throw authError(401, "AUTH_REFRESH_RACE", "Session was just refreshed. Retry the request");
      }
      if (!session.revokedAt) await revokeSession(session.id, "REFRESH_TOKEN_REUSE");
      await events({ adminUserId: stored.adminUserId, action: "REFRESH_TOKEN_REUSE_DETECTED", targetId: session.id, targetType: "admin_session", metadata: { ipAddress } });
      throw authError(401, "AUTH_REFRESH_REUSED", "Refresh token was already used. Please log in again");
    }
    if (stored.revokedAt || stored.expiresAt <= now) throw authError(401, "AUTH_REFRESH_INVALID", "Invalid or expired refresh token");
    if (session.adminUser.status !== "ACTIVE") throw authError(403, "AUTH_ACCOUNT_INACTIVE", "Account is not active");
    if (!isLive(session, now)) throw authError(401, "AUTH_SESSION_EXPIRED", "Session expired. Please log in again");

    const claimed = await client.adminSessionRefreshToken.updateMany({ where: { id: stored.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: now } });
    if (claimed.count !== 1) throw authError(401, "AUTH_REFRESH_RACE", "Session was just refreshed. Retry the request");

    const idleExpiresAt = new Date(Math.min(session.absoluteExpiresAt.getTime(), now.getTime() + cfg.idleTimeoutSeconds * 1000));
    const updated = await client.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: now, idleExpiresAt } });
    const tokens = await issueTokens(updated, session.adminUser, { ipAddress, userAgent });
    return { user: session.adminUser, session: updated, ...tokens };
  }

  // Logout by refresh token, whichever table it lives in.
  async function revokeByRefreshToken(token, reason) {
    const hash = sha256(token);
    const stored = await client.adminSessionRefreshToken.findUnique({ where: { tokenHash: hash } });
    if (stored) {
      await revokeSession(stored.sessionId, reason);
      return { adminUserId: stored.adminUserId, sessionId: stored.sessionId };
    }
    const legacy = await client.refreshToken.findUnique({ where: { token: hash } });
    if (legacy) {
      await client.refreshToken.update({ where: { id: legacy.id }, data: { isRevoked: true } });
      return { adminUserId: legacy.adminUserId, sessionId: null };
    }
    return null;
  }

  async function listActive(adminUserId) {
    const now = clock();
    return client.adminSession.findMany({
      where: { adminUserId, revokedAt: null, absoluteExpiresAt: { gt: now }, idleExpiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, authMethod: true, mode: true, createdAt: true, lastSeenAt: true, idleExpiresAt: true, absoluteExpiresAt: true, mfaVerifiedAt: true, ipAddress: true, userAgent: true },
    });
  }

  async function markMfaVerified(sessionId) {
    const now = clock();
    await client.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { mfaVerifiedAt: now } });
    return now;
  }

  return Object.freeze({ config, isLive, createSession, issueTokens, rotateRefresh, revokeSession, revokeAllForUser, revokeByRefreshToken, validateAccess, listActive, markMfaVerified, csrfTokenFor: (session) => csrfTokenFor(session, env) });
}

module.exports = { createSessionService, csrfTokenFor, verifyCsrfToken, hashRefreshToken: sha256, authError };
