const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const leavesService = require("./leaves.service");

const getStats = asyncHandler(async (req, res) => {
  const data = await leavesService.getStats(req.query);
  return ApiResponse.success(res, 200, "HRM leave stats retrieved", data);
});

const getChart = asyncHandler(async (req, res) => {
  const data = await leavesService.getChart(req.query);
  return ApiResponse.success(res, 200, "HRM leave chart retrieved", data);
});

const listLeaves = asyncHandler(async (req, res) => {
  const data = await leavesService.listLeaves(req.query);
  return ApiResponse.success(res, 200, "HRM leaves retrieved", data);
});

const getLeave = asyncHandler(async (req, res) => {
  const data = await leavesService.getLeave(req.params.id);
  return ApiResponse.success(res, 200, "HRM leave retrieved", data);
});

const getEmployeeLeaves = asyncHandler(async (req, res) => {
  const data = await leavesService.getEmployeeLeaves(req.params.employeeId, req.query);
  return ApiResponse.success(res, 200, "HRM employee leaves retrieved", data);
});

const getEmployeeBalance = asyncHandler(async (req, res) => {
  const data = await leavesService.getEmployeeBalance(req.params.employeeId);
  return ApiResponse.success(res, 200, "HRM employee leave balance retrieved", data);
});

const approveLeave = asyncHandler(async (req, res) => {
  const data = await leavesService.approveLeave({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Leave request approved", data);
});

const denyLeave = asyncHandler(async (req, res) => {
  const data = await leavesService.denyLeave({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Leave request denied", data);
});

const approveAll = asyncHandler(async (req, res) => {
  const data = await leavesService.approveAll({ actor: req.adminUser, req });
  return ApiResponse.success(res, 200, "All pending leave requests approved", data);
});

const downloadReport = asyncHandler(async (req, res) => {
  const report = await leavesService.downloadReport(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
  return res.status(200).send(report.csv);
});

module.exports = {
  approveAll,
  approveLeave,
  denyLeave,
  downloadReport,
  getChart,
  getEmployeeBalance,
  getEmployeeLeaves,
  getLeave,
  getStats,
  listLeaves,
};

