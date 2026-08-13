const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const accountsService = require("./accounts.service");

// ─── Account Controllers ──────────────────────────────────────────────────

const listAccounts = asyncHandler(async (req, res) => {
  const result = await accountsService.listAccounts(req.query);
  return ApiResponse.success(res, 200, "HRM accounts retrieved", result);
});

const getAccount = asyncHandler(async (req, res) => {
  const account = await accountsService.getAccount(req.params.id);
  return ApiResponse.success(res, 200, "HRM account retrieved", account);
});

const getAccountWithGrants = asyncHandler(async (req, res) => {
  const account = await accountsService.getAccountWithGrants(req.params.id);
  return ApiResponse.success(
    res,
    200,
    "HRM account with grants retrieved",
    account,
  );
});

const createAccount = asyncHandler(async (req, res) => {
  const account = await accountsService.createAccount({
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 201, "HRM account created", account);
});

const updateAccount = asyncHandler(async (req, res) => {
  const account = await accountsService.updateAccount({
    id: req.params.id,
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM account updated", account);
});

const deleteAccount = asyncHandler(async (req, res) => {
  await accountsService.deleteAccount({
    id: req.params.id,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM account deleted");
});

const updateStatus = asyncHandler(async (req, res) => {
  const account = await accountsService.updateStatus({
    id: req.params.id,
    status: req.body.status,
    reassignTo: req.body.reassignTo,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM account status updated", account);
});

const resendInvite = asyncHandler(async (req, res) => {
  await accountsService.resendInvite({
    id: req.params.id,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM account invite resent");
});

// ─── Grant Controllers ──────────────────────────────────────────────────

const getUserGrants = asyncHandler(async (req, res) => {
  const grants = await accountsService.getUserGrants(req.params.id);
  return ApiResponse.success(res, 200, "User grants retrieved", grants);
});

const addGrant = asyncHandler(async (req, res) => {
  const grant = await accountsService.addGrant({
    userId: req.params.id,
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 201, "Grant added successfully", grant);
});

const syncGrants = asyncHandler(async (req, res) => {
  const grants = await accountsService.syncGrants({
    userId: req.params.id,
    grants: req.body.grants,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "Grants synced successfully", grants);
});

const updateGrant = asyncHandler(async (req, res) => {
  const grant = await accountsService.updateGrant({
    grantId: req.params.grantId,
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "Grant updated successfully", grant);
});

const removeGrant = asyncHandler(async (req, res) => {
  await accountsService.removeGrant({
    grantId: req.params.grantId,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "Grant removed successfully");
});

const getAvailableModules = asyncHandler(async (req, res) => {
  const modules = await accountsService.getAvailableModules();
  return ApiResponse.success(res, 200, "Available modules retrieved", {
    modules,
  });
});

module.exports = {
  // Account
  createAccount,
  deleteAccount,
  getAccount,
  getAccountWithGrants,
  listAccounts,
  resendInvite,
  updateAccount,
  updateStatus,
  // Grants
  getUserGrants,
  addGrant,
  syncGrants,
  updateGrant,
  removeGrant,
  getAvailableModules,
};
