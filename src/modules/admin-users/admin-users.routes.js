const express = require("express");
const router = express.Router();
const controller = require("./admin-users.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireExactTier,
  require2FA,
} = require("../../shared/middlewares/rbac.middleware");
const {
  createUserSchema,
  updateUserSchema,
  validate,
} = require("./admin-users.validator");

router.use(authenticate);

router.get("/", requireTier("ADMIN"), controller.getAllUsers);
router.get("/audit-logs", requireTier("ADMIN"), controller.getAuditLogs);
router.get("/:id", requireTier("ADMIN"), controller.getUserById);

router.post(
  "/",
  requireTier("ADMIN"),
  require2FA(),
  validate(createUserSchema),
  controller.createUser,
);

router.patch(
  "/:id",
  requireTier("ADMIN"),
  validate(updateUserSchema),
  controller.updateUser,
);

router.patch("/:id/activate", requireTier("ADMIN"), controller.activateUser);
router.patch(
  "/:id/deactivate",
  requireTier("ADMIN"),
  require2FA(),
  controller.deactivateUser,
);

router.post(
  "/:id/reset-password",
  requireTier("ADMIN"),
  require2FA(),
  controller.resetUserPassword,
);

module.exports = router;
