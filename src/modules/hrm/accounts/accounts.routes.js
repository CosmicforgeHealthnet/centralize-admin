const express = require("express");
const accountsController = require("./accounts.controller");
const {
  requireExactTier,
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const {
  accountCreateSchema,
  accountStatusSchema,
  accountUpdateSchema,
  validateBody,
} = require("./accounts.validator");

const router = express.Router();

router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.listAccounts,
);
router.get(
  "/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.getAccount,
);
router.post(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  validateBody(accountCreateSchema),
  accountsController.createAccount,
);
router.put(
  "/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  validateBody(accountUpdateSchema),
  accountsController.updateAccount,
);
router.delete(
  "/:id",
  requireExactTier("SUPER"),
  accountsController.deleteAccount,
);
router.patch(
  "/:id/status",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  validateBody(accountStatusSchema),
  accountsController.updateStatus,
);
router.post(
  "/:id/invite",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  accountsController.resendInvite,
);

module.exports = router;
