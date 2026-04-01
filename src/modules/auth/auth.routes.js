const express = require("express");
const router = express.Router();
const controller = require("./auth.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  authLimiter,
  passwordResetLimiter,
} = require("../../shared/middlewares/rateLimiter.middleware");
const {
  loginSchema,
  changePasswordSchema,
  refreshTokenSchema,
  validate,
} = require("./auth.validator");

// Public routes
router.post("/login", authLimiter, validate(loginSchema), controller.login);
router.post(
  "/refresh-token",
  authLimiter,
  validate(refreshTokenSchema),
  controller.refreshToken,
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
