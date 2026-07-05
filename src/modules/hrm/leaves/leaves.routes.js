const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const leavesController = require("./leaves.controller");
const {
  leavesDownloadQuerySchema,
  leavesListQuerySchema,
  validateQuery,
} = require("./leaves.validator");

const router = express.Router();

router.get(
  "/stats",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getStats,
);
router.get(
  "/chart",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getChart,
);
router.patch(
  "/approve-all",
  requireTier("EXECUTIVE"),
  requireSection("hrm", "leaves", "EDIT"),
  leavesController.approveAll,
);
router.get(
  "/report/download",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  validateQuery(leavesDownloadQuerySchema),
  leavesController.downloadReport,
);
router.get(
  "/employee/:employeeId/balance",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getEmployeeBalance,
);
router.get(
  "/employee/:employeeId",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getEmployeeLeaves,
);
router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  validateQuery(leavesListQuerySchema),
  leavesController.listLeaves,
);
router.patch(
  "/:id/approve",
  requireTier("EXECUTIVE"),
  requireSection("hrm", "leaves", "EDIT"),
  leavesController.approveLeave,
);
router.patch(
  "/:id/deny",
  requireTier("EXECUTIVE"),
  requireSection("hrm", "leaves", "EDIT"),
  leavesController.denyLeave,
);
router.get(
  "/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getLeave,
);

module.exports = router;
