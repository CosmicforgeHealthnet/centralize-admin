const authService = require("./auth.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const {
  setSessionCookies,
  clearSessionCookies,
  setMfaChallengeCookie,
  legacyRefreshOptions,
  legacyHintOptions,
} = require("../../shared/auth/cookies");
const { assertTrustedOrigin } = require("../../shared/middlewares/auth.middleware");
const { mfaService } = require("./mfa.instance");
const { sessionService, getAuthRuntime } = require("../../shared/auth");

const REFRESH_TOKEN_COOKIE = "refreshToken";

const clientMeta = (req) => ({ ipAddress: req.ip, userAgent: req.headers["user-agent"] });

function sessionSummary(result, config) {
  return {
    id: result.session.id,
    mode: config.mode,
    authMethod: result.session.authMethod,
    accessExpiresInSeconds: result.accessTtlSeconds,
    idleExpiresAt: result.session.idleExpiresAt,
    absoluteExpiresAt: result.session.absoluteExpiresAt,
    mfaVerifiedAt: result.session.mfaVerifiedAt,
  };
}

// Writes the credentials for the configured mode and returns the body fields.
// legacy: body token + legacy refresh cookie (unchanged contract)
// dual:   body token + httpOnly cookies + CSRF token
// cookie: httpOnly cookies + CSRF token, no token in the body
function deliverSession(res, result, config) {
  // Schema not migrated: exact pre-release response (no session summary).
  const body = result.session ? { session: sessionSummary(result, config) } : {};
  if (config.mode === "legacy") {
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, legacyRefreshOptions());
    res.cookie("isLoggedIn", "true", legacyHintOptions());
  } else {
    setSessionCookies(res, result, config);
    body.csrfToken = result.csrfToken;
    // Rollout: stop issuing the legacy refresh cookie once sessions are cookie-based.
    res.clearCookie(REFRESH_TOKEN_COOKIE, { ...legacyRefreshOptions(), maxAge: undefined });
  }
  if (config.bodyTokenEnabled) body.accessToken = result.accessToken;
  return body;
}

function mfaRequiredBody(challenge) {
  return { mfaRequired: true, challengeToken: challenge.challengeToken, challengeExpiresAt: challenge.expiresAt, methods: ["totp", "recovery_code"] };
}

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const result = await authService.login({ email, password, ...clientMeta(req) });

  if (result.mfaRequired) {
    return ApiResponse.success(res, 200, "Two-factor authentication required", mfaRequiredBody(result));
  }

  const { config } = await getAuthRuntime();
  const body = deliverSession(res, result, config);
  return ApiResponse.success(res, 200, "Login successful", {
    ...body,
    mustChangePassword: result.mustChangePassword,
    user: result.user,
  });
});

const loginMfa = asyncHandler(async (req, res) => {
  const { config } = await getAuthRuntime();
  const challengeToken = req.body?.challengeToken || req.cookies?.[config.cookie.mfaChallengeName];
  const result = await authService.completeMfaLogin({
    challengeToken,
    code: req.body?.code,
    recoveryCode: req.body?.recoveryCode,
    ...clientMeta(req),
    req,
  });
  res.clearCookie(config.cookie.mfaChallengeName, { httpOnly: true, secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: config.cookie.refreshPath });
  const body = deliverSession(res, result, config);
  return ApiResponse.success(res, 200, "Login successful", {
    ...body,
    mustChangePassword: result.mustChangePassword,
    user: result.user,
  });
});

const googleCallback = asyncHandler(async (req, res) => {
  const result = await authService.googleLogin({ user: req.user, ...clientMeta(req) });
  const { config } = await getAuthRuntime();
  const frontendURL = process.env.CORS_ORIGINS.split(",")[0].trim();

  if (result.mfaRequired) {
    // The challenge travels in an httpOnly cookie, never in the URL.
    setMfaChallengeCookie(res, result.challengeToken, result.ttlMs, config);
    return res.redirect(`${frontendURL}/auth/google/callback?mfa=1`);
  }

  if (config.mode === "legacy") {
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, legacyRefreshOptions());
    res.cookie("isLoggedIn", "true", legacyHintOptions());
    return res.redirect(`${frontendURL}/auth/google/callback?token=${result.accessToken}`);
  }

  // dual/cookie: credentials are httpOnly cookies; the page loads /session.
  setSessionCookies(res, result, config);
  return res.redirect(`${frontendURL}/auth/google/callback?session=1`);
});

const refreshToken = asyncHandler(async (req, res) => {
  const { config } = await getAuthRuntime();
  const sessionCookie = config.cookiesEnabled ? req.cookies?.[config.cookie.refreshName] : null;
  const token = sessionCookie || req.cookies?.[REFRESH_TOKEN_COOKIE];

  if (!token) {
    return ApiResponse.error(res, 401, "No refresh token provided");
  }
  if (config.cookiesEnabled) assertTrustedOrigin(req);

  const result = await authService.refreshToken({ token, ...clientMeta(req) });
  const body = deliverSession(res, result, config);
  return ApiResponse.success(res, 200, "Token refreshed", body);
});

const logout = asyncHandler(async (req, res) => {
  const { config } = await getAuthRuntime();
  const token = (config.cookiesEnabled && req.cookies?.[config.cookie.refreshName]) || req.cookies?.[REFRESH_TOKEN_COOKIE];
  if (config.cookiesEnabled && (token || req.cookies?.[config.cookie.accessName])) assertTrustedOrigin(req);

  let sessionId = null;
  const accessCookie = config.cookiesEnabled ? req.cookies?.[config.cookie.accessName] : null;
  if (accessCookie) {
    try {
      sessionId = require("../../shared/utils/jwt.util").verifyAccessToken(accessCookie).sid || null;
    } catch {
      sessionId = null;
    }
  }

  if (token || sessionId) {
    await authService.logout({ refreshToken: token, sessionId, req });
  }

  clearSessionCookies(res, config);
  return ApiResponse.success(res, 200, "Logged out successfully");
});

const logoutAll = asyncHandler(async (req, res) => {
  const count = await authService.logoutAll({ adminUserId: req.adminUser.id, req });
  clearSessionCookies(res, (await getAuthRuntime()).config);
  return ApiResponse.success(res, 200, "Signed out of all sessions", { sessionsRevoked: count });
});

const getSession = asyncHandler(async (req, res) => {
  const { ready, config } = await getAuthRuntime();
  const mfa = ready ? await mfaService.status(req.adminUser.id) : { enrolled: false, recoveryCodesRemaining: 0 };
  const data = {
    user: req.adminUser,
    mode: config.mode,
    schemaReady: ready,
    session: req.authSession,
    mfa: { available: ready, enrolled: mfa.enrolled, recoveryCodesRemaining: mfa.recoveryCodesRemaining },
  };
  if (req.authSession?.id && config.cookiesEnabled) {
    const session = await require("../../shared/config/database").prisma.adminSession.findUnique({ where: { id: req.authSession.id } });
    data.csrfToken = sessionService.csrfTokenFor(session);
  }
  return ApiResponse.success(res, 200, "Current session", data);
});

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await authService.listSessions({ adminUserId: req.adminUser.id, currentSessionId: req.authSession?.id });
  return ApiResponse.success(res, 200, "Active sessions", sessions);
});

const revokeSession = asyncHandler(async (req, res) => {
  await authService.revokeOwnSession({ adminUserId: req.adminUser.id, sessionId: req.params.sessionId, req });
  if (req.params.sessionId === req.authSession?.id) clearSessionCookies(res, (await getAuthRuntime()).config);
  return ApiResponse.success(res, 200, "Session revoked");
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  await authService.changePassword({
    adminUserId: req.adminUser.id,
    currentPassword,
    newPassword,
    req,
  });

  clearSessionCookies(res, (await getAuthRuntime()).config);

  return ApiResponse.success(
    res,
    200,
    "Password changed successfully. Please log in again",
  );
});

// ── MFA ───────────────────────────────────────────────────────
const mfaStatus = asyncHandler(async (req, res) => {
  const data = await mfaService.status(req.adminUser.id);
  return ApiResponse.success(res, 200, "Two-factor status", data);
});

const mfaEnroll = asyncHandler(async (req, res) => {
  const data = await mfaService.startEnrollment(req.adminUser.id, { password: req.body?.password, req });
  res.set("Cache-Control", "no-store");
  return ApiResponse.success(res, 200, "Scan the key with your authenticator app, then confirm a code", data);
});

const mfaActivate = asyncHandler(async (req, res) => {
  const data = await mfaService.activate(req.adminUser.id, { code: req.body?.code, sessionId: req.authSession?.id, req });
  res.set("Cache-Control", "no-store");
  return ApiResponse.success(res, 200, "Two-factor authentication enabled. Save your recovery codes now", data);
});

const mfaStepUp = asyncHandler(async (req, res) => {
  const data = await mfaService.stepUp(req.adminUser.id, { sessionId: req.authSession?.id, code: req.body?.code, recoveryCode: req.body?.recoveryCode, req });
  return ApiResponse.success(res, 200, "Verified", data);
});

const mfaRegenerate = asyncHandler(async (req, res) => {
  const data = await mfaService.regenerateRecoveryCodes(req.adminUser.id, { req });
  res.set("Cache-Control", "no-store");
  return ApiResponse.success(res, 200, "New recovery codes generated. Previous codes no longer work", data);
});

const mfaDisable = asyncHandler(async (req, res) => {
  const data = await mfaService.disable(req.adminUser.id, { password: req.body?.password, code: req.body?.code, recoveryCode: req.body?.recoveryCode, sessionId: req.authSession?.id, req });
  return ApiResponse.success(res, 200, "Two-factor authentication disabled", data);
});

const mfaAdminReset = asyncHandler(async (req, res) => {
  const data = await mfaService.adminReset(req.adminUser, { targetUserId: req.body?.targetUserId, reason: req.body?.reason, req });
  return ApiResponse.success(res, 200, "Two-factor authentication reset", data);
});

const getMe = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "User profile", req.adminUser);
});

// ─────────────────────────────────────────────────────────────
// PASSWORD RESET
// ─────────────────────────────────────────────────────────────

const requestPasswordReset = asyncHandler(async (req, res) => {
  const { name, email, position } = req.body;

  await authService.requestPasswordReset({ name, email, position, req });

  // Always return success — don't reveal if email exists
  return ApiResponse.success(
    res,
    200,
    "If your details match our records, your request has been sent to HR for approval. You will receive an email once approved.",
  );
});

const approvePasswordReset = asyncHandler(async (req, res) => {
  const { targetUserId } = req.body;

  await authService.approvePasswordReset({
    targetUserId,
    approvedBy: req.adminUser.id,
    req,
  });

  return ApiResponse.success(
    res,
    200,
    "Password reset approved. Temporary password sent to user's email.",
  );
});

const rejectPasswordReset = asyncHandler(async (req, res) => {
  const { targetUserId, reason } = req.body;

  await authService.rejectPasswordReset({
    targetUserId,
    approvedBy: req.adminUser.id,
    reason,
    req,
  });

  return ApiResponse.success(res, 200, "Password reset request rejected.");
});

const getPendingResetRequests = asyncHandler(async (req, res) => {
  const requests = await authService.getPendingResetRequests();

  return ApiResponse.success(
    res,
    200,
    "Pending password reset requests",
    requests,
  );
});

module.exports = {
  login,
  loginMfa,
  googleCallback,
  refreshToken,
  logout,
  logoutAll,
  getSession,
  listSessions,
  revokeSession,
  mfaStatus,
  mfaEnroll,
  mfaActivate,
  mfaStepUp,
  mfaRegenerate,
  mfaDisable,
  mfaAdminReset,
  changePassword,
  getMe,
  requestPasswordReset,
  approvePasswordReset,
  rejectPasswordReset,
  getPendingResetRequests,
};