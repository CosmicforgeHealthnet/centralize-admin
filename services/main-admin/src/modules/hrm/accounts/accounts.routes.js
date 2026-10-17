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
  createGrantSchema,
  syncGrantsSchema,
  updateGrantSchema,
  validateBody,
} = require("./accounts.validator");

const router = express.Router();

// ─── GRANT ROUTES - MUST COME FIRST ──────────────────────────────────────

// ✅ GET modules available
router.get(
  "/modules/available",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.getAvailableModules,
);

// ✅ DELETE grant - MUST COME BEFORE /:id routes
router.delete(
  "/grants/:grantId",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  accountsController.removeGrant,
);

// ✅ PUT update grant - MUST COME BEFORE /:id routes
router.put(
  "/grants/:grantId",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  validateBody(updateGrantSchema),
  accountsController.updateGrant,
);

// ─── ACCOUNT ROUTES ──────────────────────────────────────────────────────

router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.listAccounts,
);

// ⚠️ IMPORTANT: These :id routes come AFTER grant routes
router.get(
  "/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.getAccount,
);

router.get(
  "/:id/with-grants",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.getAccountWithGrants,
);

router.get(
  "/:id/grants",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "VIEW"),
  accountsController.getUserGrants,
);

router.post(
  "/:id/grants",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  validateBody(createGrantSchema),
  accountsController.addGrant,
);

router.put(
  "/:id/grants/sync",
  requireTier("ADMIN"),
  requireSection("hrm", "accounts", "EDIT"),
  validateBody(syncGrantsSchema),
  accountsController.syncGrants,
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
