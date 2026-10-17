const adminUsersService = require("./admin-users.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getAllUsers = asyncHandler(async (req, res) => {
  const { page, limit, tier, department, status } = req.query;
  const result = await adminUsersService.getAllUsers({
    page,
    limit,
    tier,
    department,
    status,
  });
  return ApiResponse.success(res, 200, "Users retrieved", result);
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await adminUsersService.getUserById(req.params.id);
  return ApiResponse.success(res, 200, "User retrieved", user);
});

const createUser = asyncHandler(async (req, res) => {
  const user = await adminUsersService.createUser({
    data: req.body,
    createdBy: req.adminUser.id,
    req,
  });
  return ApiResponse.success(res, 201, "User created successfully", user);
});

const updateUser = asyncHandler(async (req, res) => {
  const user = await adminUsersService.updateUser({
    id: req.params.id,
    data: req.body,
    updatedBy: req.adminUser.id,
    req,
  });
  return ApiResponse.success(res, 200, "User updated", user);
});

const deactivateUser = asyncHandler(async (req, res) => {
  await adminUsersService.deactivateUser({
    id: req.params.id,
    deactivatedBy: req.adminUser.id,
    reassignTo: req.body.reassignTo,
    req,
  });
  return ApiResponse.success(res, 200, "User deactivated");
});

const activateUser = asyncHandler(async (req, res) => {
  await adminUsersService.activateUser({
    id: req.params.id,
    activatedBy: req.adminUser.id,
    req,
  });
  return ApiResponse.success(res, 200, "User activated");
});

const resetUserPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body;
  await adminUsersService.resetUserPassword({
    id: req.params.id,
    newPassword,
    resetBy: req.adminUser.id,
    req,
  });
  return ApiResponse.success(
    res,
    200,
    "Password reset. User must change password on next login",
  );
});

const getAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, adminUserId, action } = req.query;
  const result = await adminUsersService.getAuditLogs({
    page,
    limit,
    adminUserId,
    action,
  });
  return ApiResponse.success(res, 200, "Audit logs retrieved", result);
});

module.exports = {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  resetUserPassword,
  getAuditLogs,
};
