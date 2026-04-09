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
  validate,
} = require("./auth.validator");

// Reads refreshToken from HttpOnly cookie instead of request body
// Reads refreshToken from HttpOnly cookie instead of request body
const extractRefreshTokenFromCookie = (req, res, next) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Refresh token missing",
    });
  }
  req.body = req.body || {}; // ← add this line
  req.body.refreshToken = token;
  next();
};

// Public routes
router.post("/login", authLimiter, validate(loginSchema), controller.login);
router.post(
  "/refresh-token",
  authLimiter,
  extractRefreshTokenFromCookie, // ← replaced validate(refreshTokenSchema)
  controller.refreshToken,
);

// Google OAuth routes
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

// Protected routes
router.post("/logout", controller.logout);
router.post(
  "/change-password",
  authenticate,
  validate(changePasswordSchema),
  controller.changePassword,
);
router.get("/me", authenticate, controller.getMe);

module.exports = router;
