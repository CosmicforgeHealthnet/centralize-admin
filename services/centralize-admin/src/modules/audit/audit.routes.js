const express = require("express");
const router = express.Router();
const auditController = require("./audit.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");

router.use(authenticate);

router.get("/me", auditController.getMyActivityLogs);
router.get("/all", requireTier("SUPER"), auditController.getAllActivityLogs);

module.exports = router;
