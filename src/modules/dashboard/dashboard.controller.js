const dashboardService = require("./dashboard.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getOverview = asyncHandler(async (req, res) => {
  const data = await dashboardService.getOverview();
  return ApiResponse.success(res, 200, "Dashboard overview retrieved", data);
});

const getRevenueChart = asyncHandler(async (req, res) => {
  const data = await dashboardService.getRevenueChart();
  return ApiResponse.success(res, 200, "Revenue chart data retrieved", data);
});

const getPlatformUsageChart = asyncHandler(async (req, res) => {
  const data = await dashboardService.getPlatformUsageChart();
  return ApiResponse.success(res, 200, "Platform usage data retrieved", data);
});

module.exports = { getOverview, getRevenueChart, getPlatformUsageChart };
