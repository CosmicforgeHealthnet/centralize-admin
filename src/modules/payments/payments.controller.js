const paymentsService = require("./payments.service");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getStatistics = asyncHandler(async (req, res) => {
  const result = await paymentsService.getStatistics();

  await createAuditLog({
    adminUserId: req.adminUser.id,
    action: "PAYMENT_VIEWED",
    targetType: "payment_statistics",
    req,
  });

  return ApiResponse.success(res, 200, "Payment statistics retrieved", result);
});

const getDashboardAnalytics = asyncHandler(async (req, res) => {
  const result = await paymentsService.getDashboardAnalytics();
  return ApiResponse.success(res, 200, "Dashboard analytics retrieved", result);
});

const getServiceAnalytics = asyncHandler(async (req, res) => {
  const result = await paymentsService.getServiceAnalytics(
    req.query.serviceType,
  );
  return ApiResponse.success(res, 200, "Service analytics retrieved", result);
});

const getCurrencyAnalytics = asyncHandler(async (req, res) => {
  const result = await paymentsService.getCurrencyAnalytics();
  return ApiResponse.success(res, 200, "Currency analytics retrieved", result);
});

const getProviderPerformance = asyncHandler(async (req, res) => {
  const result = await paymentsService.getProviderPerformance();
  return ApiResponse.success(
    res,
    200,
    "Provider performance retrieved",
    result,
  );
});

const getTransactionById = asyncHandler(async (req, res) => {
  const result = await paymentsService.getTransactionById(req.params.id);
  return ApiResponse.success(res, 200, "Transaction retrieved", result);
});

const getCancelledTransactions = asyncHandler(async (req, res) => {
  const result = await paymentsService.getCancelledTransactions();
  return ApiResponse.success(
    res,
    200,
    "Cancelled transactions retrieved",
    result,
  );
});

const processManualRefund = asyncHandler(async (req, res) => {
  const { reason, refundAmount } = req.body;
  const result = await paymentsService.processManualRefund(req.params.id, {
    reason,
    refundAmount,
  });
  return ApiResponse.success(res, 200, "Refund processed", result);
});

module.exports = {
  getStatistics,
  getDashboardAnalytics,
  getServiceAnalytics,
  getCurrencyAnalytics,
  getProviderPerformance,
  getTransactionById,
  getCancelledTransactions,
  processManualRefund,
};
