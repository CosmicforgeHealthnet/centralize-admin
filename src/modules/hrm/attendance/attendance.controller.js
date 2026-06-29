const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const attendanceService = require("./attendance.service");

const getStats = asyncHandler(async (req, res) => {
  const data = await attendanceService.getStats(req.query);
  return ApiResponse.success(res, 200, "HRM attendance stats retrieved", data);
});

const listAttendance = asyncHandler(async (req, res) => {
  const data = await attendanceService.listAttendance(req.query);
  return ApiResponse.success(res, 200, "HRM attendance retrieved", data);
});

const getEmployeeOverview = asyncHandler(async (req, res) => {
  const data = await attendanceService.getEmployeeOverview(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee attendance retrieved", data);
});

const getEmployeeLogs = asyncHandler(async (req, res) => {
  const data = await attendanceService.getEmployeeLogs(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee attendance logs retrieved", data);
});

const createAttendance = asyncHandler(async (req, res) => {
  const data = await attendanceService.createAttendance({
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 201, "Attendance recorded", data);
});

const updateAttendance = asyncHandler(async (req, res) => {
  const data = await attendanceService.updateAttendance({
    id: req.params.id,
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "Attendance updated", data);
});

const downloadReport = asyncHandler(async (req, res) => {
  const report = await attendanceService.downloadReport(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
  return res.status(200).send(report.csv);
});

module.exports = {
  createAttendance,
  downloadReport,
  getEmployeeLogs,
  getEmployeeOverview,
  getStats,
  listAttendance,
  updateAttendance,
};

