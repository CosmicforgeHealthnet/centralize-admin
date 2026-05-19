const express = require("express");
const router = express.Router();
const controller = require("./auth.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const passport = require("../../shared/config/google.strategy");
const {
  authLimiter,
  passwordResetLimiter,
} = require("../../shared/middlewares/rateLimiter.middleware");
const {
  loginSchema,
  changePasswordSchema,
  requestPasswordResetSchema,
  approveRejectPasswordResetSchema,
  validate,
} = require("./auth.validator");

const extractRefreshTokenFromCookie = (req, res, next) => {
  const token = req.cookies?.refreshToken;
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
  passport.authenticate("google", {
    session: false,
    scope: ["profile", "email"],
  }),
);
router.get(
  "/google/callback",
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