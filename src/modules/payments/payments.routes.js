const express = require("express");
const router = express.Router();
const controller = require("./payments.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  readOnly,
} = require("../../shared/middlewares/rbac.middleware");

router.use(authenticate);
router.use(readOnly); // EXECUTIVE can read but not write

// Analytics — all tiers can view (EXECUTIVE included)
router.get("/statistics", requireTier("EMPLOYEE"), controller.getStatistics);
router.get(
  "/analytics/dashboard",
  requireTier("EMPLOYEE"),
  controller.getDashboardAnalytics,
);
router.get(
  "/analytics/services",
  requireTier("EMPLOYEE"),
  controller.getServiceAnalytics,
);
router.get(
  "/analytics/currency",
  requireTier("EMPLOYEE"),
  controller.getCurrencyAnalytics,
);
router.get(
  "/analytics/providers",
  requireTier("EMPLOYEE"),
  controller.getProviderPerformance,
);
router.get(
  "/cancelled",
  requireTier("EMPLOYEE"),
  controller.getCancelledTransactions,
);
router.get("/:id", requireTier("EMPLOYEE"), controller.getTransactionById);

// Refunds — SUPER only
router.post(
  "/:id/refund",
  requireTier("SUPER"),
  controller.processManualRefund,
);

module.exports = router;
