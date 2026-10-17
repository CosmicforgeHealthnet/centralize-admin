const express = require("express");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
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
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceStatsQuerySchema),
  attendanceController.getStats,
);
router.get(
  "/report/download",
  requireTier("ADMIN"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceDownloadQuerySchema),
  attendanceController.downloadReport,
);
router.get(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceListQuerySchema),
  attendanceController.listAttendance,
);
router.post(
  "/",
  requireTier("ADMIN"),
  requireSection("hrm", "attendance", "EDIT"),
  validateBody(attendanceCreateSchema),
  attendanceController.createAttendance,
);
router.get(
  "/:employeeId/logs",
  requireTier("ADMIN"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceLogsQuerySchema),
  attendanceController.getEmployeeLogs,
);
router.get(
  "/:employeeId",
  requireTier("ADMIN"),
  requireSection("hrm", "attendance", "VIEW"),
  attendanceController.getEmployeeOverview,
);
router.put(
  "/:id",
  requireTier("ADMIN"),
  requireSection("hrm", "attendance", "EDIT"),
  validateBody(attendanceUpdateSchema),
  attendanceController.updateAttendance,
);

module.exports = router;
