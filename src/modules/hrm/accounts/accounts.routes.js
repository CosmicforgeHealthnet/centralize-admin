const express = require("express");
const accountsController = require("./accounts.controller");
const { requireExactTier, requireTier } = require("../../../shared/middlewares/rbac.middleware");
const {
  accountCreateSchema,
  accountStatusSchema,
  accountUpdateSchema,
  validateBody,
} = require("./accounts.validator");

const router = express.Router();

router.get("/", requireTier("ADMIN"), accountsController.listAccounts);
router.get("/:id", requireTier("ADMIN"), accountsController.getAccount);
router.post(
  "/",
  requireTier("ADMIN"),
  validateBody(accountCreateSchema),
  accountsController.createAccount,
);
router.put(
  "/:id",
  requireTier("ADMIN"),
  validateBody(accountUpdateSchema),
  accountsController.updateAccount,
);
router.delete("/:id", requireExactTier("SUPER"), accountsController.deleteAccount);
router.patch(
  "/:id/status",
  requireTier("ADMIN"),
  validateBody(accountStatusSchema),
  accountsController.updateStatus,
);
router.post("/:id/invite", requireTier("ADMIN"), accountsController.resendInvite);

module.exports = router;
