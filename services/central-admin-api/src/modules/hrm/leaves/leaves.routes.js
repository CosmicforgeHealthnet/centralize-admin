const express = require("express");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
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
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getStats,
);
router.get(
  "/chart",
  requireTierOrDepartment("ADMIN", "hrm"),
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
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "leaves", "VIEW"),
  validateQuery(leavesDownloadQuerySchema),
  leavesController.downloadReport,
);
router.get(
  "/employee/:employeeId/balance",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getEmployeeBalance,
);
router.get(
  "/employee/:employeeId",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getEmployeeLeaves,
);
router.get(
  "/",
  requireTierOrDepartment("ADMIN", "hrm"),
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
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "leaves", "VIEW"),
  leavesController.getLeave,
);

module.exports = router;
