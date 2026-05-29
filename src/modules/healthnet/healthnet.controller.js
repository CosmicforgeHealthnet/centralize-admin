const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");
const healthnetService = require("./healthnet.service");

const getAppointments = asyncHandler(async (req, res) => {
  const data = await healthnetService.getAppointments(req.query);

  return ApiResponse.success(res, 200, "HealthNet appointments retrieved", data);
});

const searchAppointments = asyncHandler(async (req, res) => {
  const data = await healthnetService.searchAppointments(req.query);

  return ApiResponse.success(
    res,
    200,
    "HealthNet appointments search retrieved",
    data,
  );
});

const getDashboardMetrics = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDashboardMetrics();
  return ApiResponse.success(
    res,
    200,
    "HealthNet dashboard metrics retrieved",
    data,
  );
});

const getActivityChart = asyncHandler(async (req, res) => {
  const data = await healthnetService.getActivityChart({
    month: req.query.month,
  });

  return ApiResponse.success(
    res,
    200,
    "HealthNet activity chart retrieved",
    data,
  );
});

const getPatientsChart = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatientsChart({
    month: req.query.month,
  });

  return ApiResponse.success(
    res,
    200,
    "HealthNet patients chart retrieved",
    data,
  );
});

const getRevenueChart = asyncHandler(async (req, res) => {
  const data = await healthnetService.getRevenueChart();
  return ApiResponse.success(
    res,
    200,
    "HealthNet revenue chart retrieved",
    data,
  );
});

module.exports = {
  getAppointments,
  searchAppointments,
  getDashboardMetrics,
  getActivityChart,
  getPatientsChart,
  getRevenueChart,
};
