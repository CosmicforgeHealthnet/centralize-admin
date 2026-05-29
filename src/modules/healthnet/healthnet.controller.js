const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");
const healthnetService = require("./healthnet.service");

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
  getDashboardMetrics,
  getActivityChart,
  getPatientsChart,
  getRevenueChart,
};
