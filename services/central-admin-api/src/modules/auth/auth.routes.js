const express = require("express");
const router = express.Router();
const controller = require("./auth.controller");
const { authenticate, requireAuthSchema, requireRecentMfa } = require("../../shared/middlewares/auth.middleware");
const passport = require("../../shared/config/google.strategy");
const {
  requireGoogleOAuthConfigured,
} = require("../../shared/config/google.strategy");
const {
  authLimiter,
  passwordResetLimiter,
} = require("../../shared/middlewares/rateLimiter.middleware");
const {
  loginSchema,
  changePasswordSchema,
  requestPasswordResetSchema,
  approveRejectPasswordResetSchema,
  mfaLoginSchema,
  mfaCodeSchema,
  mfaPasswordSchema,
  mfaDisableSchema,
  mfaAdminResetSchema,
  validate,
} = require("./auth.validator");

const { loadSessionConfig } = require("../../shared/auth/session.config");

const extractRefreshTokenFromCookie = (req, res, next) => {
  // Cookie names only; the controller decides what the token is valid for.
  const config = loadSessionConfig();
  const token = req.cookies?.refreshToken || (config.cookiesEnabled && req.cookies?.[config.cookie.refreshName]);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Refresh token missing",
    });
  }
  req.body = req.body || {};
  req.body.refreshToken = token;
  next();
};

// ── Public routes ────────────────────────────────────────────────
router.post("/login", authLimiter, validate(loginSchema), controller.login);
router.post("/login/mfa", authLimiter, requireAuthSchema, validate(mfaLoginSchema), controller.loginMfa);
router.post(
  "/refresh-token",
  authLimiter,
  extractRefreshTokenFromCookie,
  controller.refreshToken,
);
router.post(
  "/request-password-reset",
  passwordResetLimiter,
  validate(requestPasswordResetSchema),
  controller.requestPasswordReset,
);

// ── Google OAuth routes ──────────────────────────────────────────
router.get(
  "/google",
  requireGoogleOAuthConfigured,
  passport.authenticate("google", {
    session: false,
    scope: ["profile", "email"],
  }),
);
router.get(
  "/google/callback",
  requireGoogleOAuthConfigured,
  passport.authenticate("google", { session: false, failWithError: true }),
  controller.googleCallback,
);

// ── Protected routes ─────────────────────────────────────────────
router.post("/logout", controller.logout);
router.post(
  "/change-password",
  authenticate,
  validate(changePasswordSchema),
  controller.changePassword,
);
router.get("/me", authenticate, controller.getMe);
router.get("/session", authenticate, controller.getSession);
router.get("/sessions", requireAuthSchema, authenticate, controller.listSessions);
router.delete("/sessions/:sessionId", requireAuthSchema, authenticate, controller.revokeSession);
router.post("/logout-all", requireAuthSchema, authenticate, controller.logoutAll);

// ── MFA (enrollment, step-up, recovery, reset) ──────────────────
const MFA_STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;
router.get("/mfa/status", requireAuthSchema, authenticate, controller.mfaStatus);
router.post("/mfa/enroll", authLimiter, requireAuthSchema, authenticate, validate(mfaPasswordSchema), controller.mfaEnroll);
router.post("/mfa/activate", authLimiter, requireAuthSchema, authenticate, validate(mfaCodeSchema), controller.mfaActivate);
router.post("/mfa/step-up", authLimiter, requireAuthSchema, authenticate, validate(mfaCodeSchema), controller.mfaStepUp);
router.post("/mfa/recovery-codes/regenerate", authLimiter, requireAuthSchema, authenticate, requireRecentMfa(MFA_STEP_UP_MAX_AGE_MS), controller.mfaRegenerate);
router.post("/mfa/disable", authLimiter, requireAuthSchema, authenticate, validate(mfaDisableSchema), controller.mfaDisable);
router.post("/mfa/admin-reset", authLimiter, requireAuthSchema, authenticate, requireRecentMfa(MFA_STEP_UP_MAX_AGE_MS), validate(mfaAdminResetSchema), controller.mfaAdminReset);

// ── HR Admin — password reset management ────────────────────────
router.get(
  "/pending-reset-requests",
  authenticate,
  controller.getPendingResetRequests,
);
router.post(
  "/approve-password-reset",
  authenticate,
  validate(approveRejectPasswordResetSchema),
  controller.approvePasswordReset,
);
router.post(
  "/reject-password-reset",
  authenticate,
  validate(approveRejectPasswordResetSchema),
  controller.rejectPasswordReset,
);

module.exports = router;
