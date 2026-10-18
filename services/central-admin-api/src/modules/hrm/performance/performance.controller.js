const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const performanceService = require("./performance.service");

const getStats = asyncHandler(async (req, res) => {
  const data = await performanceService.getStats();
  return ApiResponse.success(res, 200, "HRM performance stats retrieved", data);
});

const getScore = asyncHandler(async (req, res) => {
  const data = await performanceService.getScore();
  return ApiResponse.success(res, 200, "HRM performance score retrieved", data);
});

const getChart = asyncHandler(async (req, res) => {
  const data = await performanceService.getChart();
  return ApiResponse.success(res, 200, "HRM performance chart retrieved", data);
});

const getTasks = asyncHandler(async (req, res) => {
  const data = await performanceService.getTasks(req.query);
  return ApiResponse.success(res, 200, "HRM performance tasks retrieved", data);
});

const getTeams = asyncHandler(async (req, res) => {
  const data = await performanceService.getTeams(req.query);
  return ApiResponse.success(res, 200, "HRM performance teams retrieved", data);
});

const getProjects = asyncHandler(async (req, res) => {
  const data = await performanceService.getProjects(req.query);
  return ApiResponse.success(res, 200, "HRM performance projects retrieved", data);
});

const getEmployees = asyncHandler(async (req, res) => {
  const data = await performanceService.getEmployees(req.query);
  return ApiResponse.success(res, 200, "HRM performance employees retrieved", data);
});

const getEvents = asyncHandler(async (req, res) => {
  const data = await performanceService.getEvents(req.query);
  return ApiResponse.success(res, 200, "HRM performance events retrieved", data);
});

const createEvent = asyncHandler(async (req, res) => {
  const data = await performanceService.createEvent({
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 201, "HRM performance event created", data);
});

const getEvent = asyncHandler(async (req, res) => {
  const data = await performanceService.getEvent(req.params.id);
  return ApiResponse.success(res, 200, "HRM performance event retrieved", data);
});

module.exports = {
  createEvent,
  getChart,
  getEmployees,
  getEvent,
  getEvents,
  getProjects,
  getScore,
  getStats,
  getTasks,
  getTeams,
};
