const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const leavesController = require("./leaves.controller");

const router = express.Router();

router.get("/stats", requireTier("ADMIN"), leavesController.getStats);
router.get("/chart", requireTier("ADMIN"), leavesController.getChart);
router.patch("/approve-all", requireTier("EXECUTIVE"), leavesController.approveAll);
router.get("/report/download", requireTier("ADMIN"), leavesController.downloadReport);
router.get(
  "/employee/:employeeId/balance",
  requireTier("ADMIN"),
  leavesController.getEmployeeBalance,
);
router.get("/employee/:employeeId", requireTier("ADMIN"), leavesController.getEmployeeLeaves);
router.get("/", requireTier("ADMIN"), leavesController.listLeaves);
router.patch("/:id/approve", requireTier("EXECUTIVE"), leavesController.approveLeave);
router.patch("/:id/deny", requireTier("EXECUTIVE"), leavesController.denyLeave);
router.get("/:id", requireTier("ADMIN"), leavesController.getLeave);

module.exports = router;

