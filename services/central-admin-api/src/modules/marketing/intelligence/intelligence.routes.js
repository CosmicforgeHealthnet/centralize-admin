const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../../shared/middlewares/auth.middleware");
const rbac = require("../../../shared/middlewares/rbac.middleware");
const { requireSection } = rbac;
const requireTier = rbac.requireTier || (() => (_req, _res, next) => next());
const intelligenceController = require("./intelligence.controller");
const { requirePhase2Enabled } = require("./phase2-feature");

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
  "/settings",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getSettings,
);

router.patch(
  "/settings",
  requireSection("marketing", "intelligence", "EDIT"),
  requireTier("ADMIN"),
  intelligenceController.updateSettings,
);

router.get(
  "/evaluation-runs",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listEvaluationRuns,
);

router.get(
  "/evaluation-runs/:id",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getEvaluationRun,
);

router.get(
  "/creatives",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listCreatives,
);

router.post(
  "/creatives/score",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.scoreCreatives,
);

router.post(
  "/creatives/sync",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.syncCreatives,
);

router.get(
  "/creatives/:id/scores/latest",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getLatestCreativeScore,
);

router.get(
  "/creatives/:id/scores",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listCreativeScores,
);

router.get(
  "/creatives/:id",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getCreative,
);

router.get(
  "/recommendations",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listRecommendations,
);

router.post(
  "/recommendations/evaluate",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.evaluateRecommendations,
);

router.patch(
  "/recommendations/:id/accept",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.acceptRecommendation,
);

router.patch(
  "/recommendations/:id/dismiss",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.dismissRecommendation,
);

router.post(
  "/recommendations/:id/convert-to-task",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.convertRecommendationToTask,
);

router.get(
  "/recommendations/:id",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getRecommendation,
);

router.get(
  "/alerts",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listAlerts,
);

router.post(
  "/alerts/evaluate",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.evaluateAlerts,
);

router.patch(
  "/alerts/:id/acknowledge",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.acknowledgeAlert,
);

router.patch(
  "/alerts/:id/resolve",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.resolveAlert,
);

router.get(
  "/alerts/:id",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getAlert,
);

router.post(
  "/experiments",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.createExperiment,
);

router.get(
  "/experiments",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listExperiments,
);

router.patch(
  "/experiments/:id",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.updateExperiment,
);

router.post(
  "/experiments/:id/start",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.startExperiment,
);

router.post(
  "/experiments/:id/complete",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.completeExperiment,
);

router.post(
  "/experiments/:id/cancel",
  requireSection("marketing", "intelligence", "EDIT"),
  requirePhase2Enabled,
  intelligenceController.cancelExperiment,
);

router.get(
  "/experiments/:id",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.getExperiment,
);

router.get(
  "/provider-validation",
  requireSection("marketing", "intelligence", "VIEW"),
  intelligenceController.listProviderValidationStatus,
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

router.post(
  "/connections/:id/validation-evidence",
  requireSection("marketing", "intelligence", "EDIT"),
  intelligenceController.recordProviderValidationEvidence,
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
