const express = require("express");
const router = express.Router();
const auditController = require("./audit.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");

router.use(authenticate);

router.get("/me", auditController.getMyActivityLogs);
router.get("/all", auditController.getAllActivityLogs);

module.exports = router;
