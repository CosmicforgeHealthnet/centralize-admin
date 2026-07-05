const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const accountsService = require("./accounts.service");

const listAccounts = asyncHandler(async (req, res) => {
  const result = await accountsService.listAccounts(req.query);
  return ApiResponse.success(res, 200, "HRM accounts retrieved", result);
});

const getAccount = asyncHandler(async (req, res) => {
  const account = await accountsService.getAccount(req.params.id);
  return ApiResponse.success(res, 200, "HRM account retrieved", account);
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

module.exports = {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  resendInvite,
  updateAccount,
  updateStatus,
};
