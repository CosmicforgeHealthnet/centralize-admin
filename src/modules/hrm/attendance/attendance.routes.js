const express = require("express");
const { requireTier } = require("../../../shared/middlewares/rbac.middleware");
const attendanceController = require("./attendance.controller");
const {
  attendanceCreateSchema,
  attendanceDownloadQuerySchema,
  attendanceListQuerySchema,
  attendanceLogsQuerySchema,
  attendanceStatsQuerySchema,
  attendanceUpdateSchema,
  validateBody,
  validateQuery,
} = require("./attendance.validator");

const router = express.Router();

router.get(
  "/stats",
  requireTier("ADMIN"),
  validateQuery(attendanceStatsQuerySchema),
  attendanceController.getStats,
);
router.get(
  "/report/download",
  requireTier("ADMIN"),
  validateQuery(attendanceDownloadQuerySchema),
  attendanceController.downloadReport,
);
router.get(
  "/",
  requireTier("ADMIN"),
  validateQuery(attendanceListQuerySchema),
  attendanceController.listAttendance,
);
router.post(
  "/",
  requireTier("ADMIN"),
  validateBody(attendanceCreateSchema),
  attendanceController.createAttendance,
);
router.get(
  "/:employeeId/logs",
  requireTier("ADMIN"),
  validateQuery(attendanceLogsQuerySchema),
  attendanceController.getEmployeeLogs,
);
router.get("/:employeeId", requireTier("ADMIN"), attendanceController.getEmployeeOverview);
router.put(
  "/:id",
  requireTier("ADMIN"),
  validateBody(attendanceUpdateSchema),
  attendanceController.updateAttendance,
);

module.exports = router;