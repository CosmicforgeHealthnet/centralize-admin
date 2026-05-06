const usersService = require("./users.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const ApiError = require("../../shared/utils/ApiError");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getStats = asyncHandler(async (req, res) => {
  const data = await usersService.getStats();
  return ApiResponse.success(res, 200, "User stats retrieved", data);
});

const getGrowthChart = asyncHandler(async (req, res) => {
  const data = await usersService.getGrowthChart();
  return ApiResponse.success(res, 200, "Growth chart retrieved", data);
});

const getSignUpTrends = asyncHandler(async (req, res) => {
  const data = await usersService.getSignUpTrends();
  return ApiResponse.success(res, 200, "Sign up trends retrieved", data);
});

const listUsers = asyncHandler(async (req, res) => {
  const { role, status, search, page, limit } = req.query;
  const data = await usersService.listUsers({
    role,
    status,
    search,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Users retrieved", data);
});

const getUser = asyncHandler(async (req, res) => {
  try {
    const data = await usersService.getUser(req.params.id);
    return ApiResponse.success(res, 200, "User retrieved", data);
  } catch (err) {
    throw new ApiError(404, err.message);
  }
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) throw new ApiError(400, "Status is required");
  try {
    const data = await usersService.updateUserStatus(
      req.params.id,
      status,
      req.adminUser,
    );
    return ApiResponse.success(res, 200, "User status updated", data);
  } catch (err) {
    throw new ApiError(404, err.message);
  }
});

module.exports = {
  getStats,
  getGrowthChart,
  getSignUpTrends,
  listUsers,
  getUser,
  updateUserStatus,
};
