const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const attendanceController = require("./attendance.controller");
const {
  attendanceCreateSchema,
  attendanceUpdateSchema,
  validateBody,
} = require("./attendance.validator");

const router = express.Router();

router.get("/stats", requireTier("ADMIN"), attendanceController.getStats);
router.get("/report/download", requireTier("ADMIN"), attendanceController.downloadReport);
router.get("/", requireTier("ADMIN"), attendanceController.listAttendance);
router.post(
  "/",
  requireTier("ADMIN"),
  validateBody(attendanceCreateSchema),
  attendanceController.createAttendance,
);
router.get("/:employeeId/logs", requireTier("ADMIN"), attendanceController.getEmployeeLogs);
router.get("/:employeeId", requireTier("ADMIN"), attendanceController.getEmployeeOverview);
router.put(
  "/:id",
  requireTier("ADMIN"),
  validateBody(attendanceUpdateSchema),
  attendanceController.updateAttendance,
);

module.exports = router;
