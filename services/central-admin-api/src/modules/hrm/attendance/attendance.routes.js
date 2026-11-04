const express = require("express");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
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
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceStatsQuerySchema),
  attendanceController.getStats,
);
router.get(
  "/report/download",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceDownloadQuerySchema),
  attendanceController.downloadReport,
);
router.get(
  "/",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceListQuerySchema),
  attendanceController.listAttendance,
);
router.post(
  "/",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "EDIT"),
  validateBody(attendanceCreateSchema),
  attendanceController.createAttendance,
);
router.get(
  "/:employeeId/logs",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "VIEW"),
  validateQuery(attendanceLogsQuerySchema),
  attendanceController.getEmployeeLogs,
);
router.get(
  "/:employeeId",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "VIEW"),
  attendanceController.getEmployeeOverview,
);
router.put(
  "/:id",
  requireTierOrDepartment("ADMIN", "hrm"),
  requireSection("hrm", "attendance", "EDIT"),
  validateBody(attendanceUpdateSchema),
  attendanceController.updateAttendance,
);

module.exports = router;
