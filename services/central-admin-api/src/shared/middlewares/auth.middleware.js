const { verifyAccessToken } = require("../utils/jwt.util");
const { prisma } = require("../config/database");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { verifyCsrfToken } = require("../auth/session.service");
const { isMfaEnrolled } = require("../auth/mfa-core");
const { createOriginPolicy } = require("../config/cors-origins");

// FIX #11: Centralise the change-password path so it doesn't silently break
// if the route prefix changes. Update this constant if the route moves.
const CHANGE_PASSWORD_PATH = "/change-password";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const authError = (status, code, message) => new ApiError(status, message, [{ code }]);

// Unchanged public contract: req.adminUser has the same shape as before.
// Session details are exposed separately on req.authSession.
const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  tier: true,
  status: true,
  isTeamLead: true,
  department: true,
  mustChangePassword: true,
  passwordChangedAt: true,
  mainAppUserId: true, //
  twoFactorEnabled: true,
};

function requestOrigin(req) {
  const origin = req.get("origin");
  if (origin) return origin;
  const referer = req.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

// Cookie-authenticated, state-changing requests must come from an allowed
// frontend origin. Exported for the refresh/logout endpoints.
function assertTrustedOrigin(req, env = process.env) {
  const origin = requestOrigin(req);
  if (!origin || origin === "null" || !createOriginPolicy(env)(origin)) {
    throw authError(403, "AUTH_ORIGIN_REJECTED", "Request origin is not allowed");
  }
}

function extractCredential(req, config) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return { token: header.split(" ")[1], source: "bearer" };
  if (config.cookiesEnabled) {
    const cookieToken = req.cookies?.[config.cookie.accessName];
    if (cookieToken) return { token: cookieToken, source: "cookie" };
  }
  return null;
}

function buildAuthenticate({ client = prisma, sessions = null, runtime = null, env = process.env } = {}) {
  const auth = () => require("../auth");
  const sessionService = () => sessions || auth().sessionService;
  const getRuntime = () => (runtime ? runtime() : auth().getAuthRuntime(env));

  return asyncHandler(async (req, res, next) => {
    // Before the session/MFA migration, config is forced to legacy.
    const { ready, config } = await getRuntime();
    const credential = extractCredential(req, config);
    if (!credential) throw new ApiError(401, "No token provided");
    if (credential.source === "bearer" && !config.bearerAccepted) {
      throw authError(401, "AUTH_BEARER_DISABLED", "Bearer tokens are not accepted. Please log in again");
    }

    let decoded;
    try {
      decoded = verifyAccessToken(credential.token);
    } catch (err) {
      if (err.name === "TokenExpiredError")
        throw authError(401, "AUTH_TOKEN_EXPIRED", "Token expired");
      throw new ApiError(401, "Invalid token");
    }

    // Tokens minted before server-side sessions existed carry no `sid`. They
    // stay valid (Bearer only) until their natural expiry so a deploy does not
    // log everyone out; cookie mode never accepts them.
    let session = null;
    if (decoded.sid) {
      // A session-bound token while the schema is missing (e.g. after a
      // rollback) cannot be validated: refuse it.
      if (!ready) throw authError(401, "AUTH_SESSION_INVALID", "Session is not valid");
      session = await sessionService().validateAccess(decoded);
    } else if (credential.source === "cookie" || config.mode === "cookie") {
      throw authError(401, "AUTH_SESSION_INVALID", "Session is not valid");
    }

    if (credential.source === "cookie" && !SAFE_METHODS.has(req.method)) {
      assertTrustedOrigin(req, env);
      if (!verifyCsrfToken(session, req.get("x-csrf-token"), env)) {
        await auth().recordAuthEvent({ adminUserId: decoded.sub, action: "CSRF_REJECTED", targetId: session.id, targetType: "admin_session", metadata: { method: req.method, path: req.originalUrl?.split("?")[0] }, req });
        throw authError(403, "AUTH_CSRF_INVALID", "Missing or invalid CSRF token");
      }
    }

    // Verify user still exists and is active
    const adminUser = await client.adminUser.findUnique({
      where: { id: decoded.sub },
      select: ADMIN_USER_SELECT,
    });

    if (!adminUser) throw new ApiError(401, "User no longer exists");
    if (adminUser.status === "INACTIVE")
      throw new ApiError(403, "Account deactivated");
    if (adminUser.status === "LOCKED") throw new ApiError(403, "Account locked");

    // FIX #2: Reject access tokens issued before the last password change.
    // decoded.iat is in seconds; passwordChangedAt is a Date — align units.
    if (adminUser.passwordChangedAt) {
      const passwordChangedAtSeconds = Math.floor(
        adminUser.passwordChangedAt.getTime() / 1000,
      );
      if (decoded.iat < passwordChangedAtSeconds) {
        throw new ApiError(
          401,
          "Token invalidated due to password change. Please log in again",
        );
      }
    }

    // FIX #11: Use the constant instead of a hardcoded string
    if (
      adminUser.mustChangePassword &&
      !req.path.endsWith(CHANGE_PASSWORD_PATH)
    ) {
      throw new ApiError(403, "You must change your password before continuing");
    }

    // MFA facts go on req.authSession; req.adminUser keeps its exact shape.
    const mfaEnrolled = session
      ? isMfaEnrolled(await client.adminMfaEnrollment.findUnique({ where: { adminUserId: adminUser.id }, select: { adminUserId: true, enrolledAt: true, secretEncrypted: true } }))
      : false;

    req.adminUser = adminUser;
    req.authSession = session
      ? { id: session.id, mfaVerifiedAt: session.mfaVerifiedAt, mfaEnrolled, authMethod: session.authMethod, source: credential.source, mode: config.mode }
      : { id: null, mfaVerifiedAt: null, mfaEnrolled, authMethod: "LEGACY_TOKEN", source: credential.source, mode: config.mode };
    next();
  });
}

const authenticate = buildAuthenticate();

// Privileged operations require a fresh MFA verification on THIS session.
// Legacy tokens without a session can never satisfy it.
function hasRecentMfa(authSession, maxAgeMs, now = Date.now()) {
  const at = authSession?.mfaVerifiedAt ? new Date(authSession.mfaVerifiedAt).getTime() : 0;
  return Boolean(authSession?.id && at && now - at <= maxAgeMs && at <= now + 5000);
}

// Session/MFA endpoints answer 503 until the migration is applied.
const requireAuthSchema = asyncHandler(async (_req, _res, next) => {
  const { ready } = await require("../auth").getAuthRuntime();
  if (!ready) throw authError(503, "AUTH_SCHEMA_NOT_READY", "Sessions and two-factor authentication are not available yet");
  next();
});

function requireRecentMfa(maxAgeMs = 5 * 60 * 1000) {
  return (req, _res, next) => {
    if (hasRecentMfa(req.authSession, maxAgeMs)) return next();
    return next(authError(403, "MFA_STEP_UP_REQUIRED", "Confirm with your authenticator app to continue"));
  };
}

module.exports = { authenticate, buildAuthenticate, requireAuthSchema, requireRecentMfa, hasRecentMfa, assertTrustedOrigin };
