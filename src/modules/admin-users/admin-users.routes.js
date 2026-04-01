const express = require("express");
const router = express.Router();
const controller = require("./admin-users.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireExactTier,
} = require("../../shared/middlewares/rbac.middleware");
const {
  createUserSchema,
  updateUserSchema,
  validate,
} = require("./admin-users.validator");

// All routes require authentication
router.use(authenticate);

// GET all users — ADMIN and above
router.get("/", requireTier("ADMIN"), controller.getAllUsers);
router.get("/audit-logs", requireTier("ADMIN"), controller.getAuditLogs);
router.get("/:id", requireTier("ADMIN"), controller.getUserById);

// Create user — ADMIN and above
router.post(
  "/",
  requireTier("ADMIN"),
  validate(createUserSchema),
  controller.createUser,
);

// Update user — ADMIN and above
router.patch(
  "/:id",
  requireTier("ADMIN"),
  validate(updateUserSchema),
  controller.updateUser,
);

// Activate / Deactivate — ADMIN and above
router.patch("/:id/activate", requireTier("ADMIN"), controller.activateUser);
router.patch(
  "/:id/deactivate",
  requireTier("ADMIN"),
  controller.deactivateUser,
);

// Reset password — ADMIN and above
router.post(
  "/:id/reset-password",
  requireTier("ADMIN"),
  controller.resetUserPassword,
);

module.exports = router;
