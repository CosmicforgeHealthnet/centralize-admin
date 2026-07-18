const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../../shared/middlewares/auth.middleware");
const { requireSection } = require("../../../shared/middlewares/rbac.middleware");
const intelligenceController = require("./intelligence.controller");

// Marketing Intelligence routes. Public click attribution is intentionally
// separate from protected dashboard/management endpoints. Dashboard access
// remains VIEW-protected; provider connection management uses EDIT because
// the repository RBAC model currently supports VIEW/EDIT, not MANAGE.

const router = express.Router();

const publicAttributionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many attribution requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  "/attribution/clicks",
  publicAttributionLimiter,
  intelligenceController.captureClickAttribution,
);

router.get(
  "/oauth/:platform/callback",
  publicAttributionLimiter,
  intelligenceController.callbackOAuth,
);

router.use(authenticate);
router.use(adminLimiter);

router.get(
  "/performance",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getPerformance,
);

router.get(
  "/connections",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.listConnections,
);

router.get(
  "/connections/:id",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.getConnection,
);

router.post(
  "/connections",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.upsertConnection,
);

router.patch(
  "/connections/:id",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.updateConnection,
);

router.post(
  "/connections/bootstrap",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.bootstrapConnections,
);

router.post(
  "/connections/:id/disable",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.disableConnection,
);

router.post(
  "/connections/:id/enable",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.enableConnection,
);

router.post(
  "/connections/:id/test",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.testConnection,
);

router.delete(
  "/connections/:id",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.deleteConnection,
);

router.get(
  "/oauth/:platform/start",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.startOAuth,
);

router.post(
  "/sync",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.syncMarketingInsights,
);

module.exports = router;
