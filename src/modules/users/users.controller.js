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
  const {
    role,
    status,
    search,
    tier,
    dateFrom,
    dateTo,
    sortBy,
    sortOrder,
    page,
    limit,
  } = req.query;

  const data = await usersService.listUsers({
    role,
    status,
    search,
    tier,
    dateFrom,
    dateTo,
    sortBy,
    sortOrder,
    page: Number(page) || 1,
    limit: Math.min(Number(limit) || 20, 100),
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

const getUserActivity = asyncHandler(async (req, res) => {
  try {
    const data = await usersService.getUserActivity(req.params.id);
    return ApiResponse.success(res, 200, "User activity retrieved", data);
  } catch (err) {
    throw new ApiError(404, err.message);
  }
});

const getUserTransactions = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  try {
    const data = await usersService.getUserTransactions(req.params.id, {
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 20, 100),
    });
    return ApiResponse.success(res, 200, "User transactions retrieved", data);
  } catch (err) {
    throw new ApiError(404, err.message);
  }
});

const getUserAppointments = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  try {
    const data = await usersService.getUserAppointments(req.params.id, {
      page: Number(page) || 1,
      limit: Math.min(Number(limit) || 20, 100),
    });
    return ApiResponse.success(res, 200, "User appointments retrieved", data);
  } catch (err) {
    throw new ApiError(404, err.message);
  }
});

const getUserSubscriptions = asyncHandler(async (req, res) => {
  try {
    const data = await usersService.getUserSubscriptions(req.params.id);
    return ApiResponse.success(res, 200, "User subscriptions retrieved", data);
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
    if (
      err.message.includes("Invalid status") ||
      err.message.includes("not found")
    ) {
      throw new ApiError(400, err.message);
    }
    throw err;
  }
});

const bulkUpdateStatus = asyncHandler(async (req, res) => {
  const { ids, status } = req.body;
  if (!ids || !status) throw new ApiError(400, "ids and status are required");
  try {
    const data = await usersService.bulkUpdateStatus(
      ids,
      status,
      req.adminUser,
    );
    return ApiResponse.success(res, 200, "Users status updated", data);
  } catch (err) {
    throw new ApiError(400, err.message);
  }
});

const deleteUser = asyncHandler(async (req, res) => {
  try {
    const data = await usersService.deleteUser(req.params.id, req.adminUser);
    return ApiResponse.success(res, 200, "User deleted", data);
  } catch (err) {
    throw new ApiError(404, err.message);
  }
});

const forcePasswordReset = asyncHandler(async (req, res) => {
  try {
    const data = await usersService.forcePasswordReset(
      req.params.id,
      req.adminUser,
    );
    return ApiResponse.success(res, 200, "Password reset flagged", data);
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
  getUserActivity,
  getUserTransactions,
  getUserAppointments,
  getUserSubscriptions,
  updateUserStatus,
  bulkUpdateStatus,
  deleteUser,
  forcePasswordReset,
};
