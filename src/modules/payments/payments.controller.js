const { mainPrisma } = require("../../shared/config/mainDatabase");
const paymentsService = require("./payments.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getTransaction = asyncHandler(async (req, res) => {
  const data = await paymentsService.getTransaction(req.params.id);
  return ApiResponse.success(res, 200, "Transaction retrieved", data);
});

const listTransactions = asyncHandler(async (req, res) => {
  const { status, serviceType, patientId, page, limit } = req.query;
  const data = await paymentsService.listTransactions({
    status,
    serviceType,
    patientId,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Transactions retrieved", data);
});

const transitionPayment = asyncHandler(async (req, res) => {
  const data = await paymentsService.transitionPayment(
    req.params.id,
    req.body.status,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Transaction updated", data);
});

const getPaymentStats = asyncHandler(async (req, res) => {
  const data = await paymentsService.getPaymentStats();
  return ApiResponse.success(res, 200, "Payment stats retrieved", data);
});

const flagTransaction = asyncHandler(async (req, res) => {
  const data = await paymentsService.flagTransaction(
    req.params.id,
    req.body.reason,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Transaction flagged", data);
});

const healthCheck = asyncHandler(async (req, res) => {
  try {
    await mainPrisma.$queryRaw`SELECT 1`;
    return ApiResponse.success(res, 200, "Payments service healthy", {
      status: "up",
      timestamp: new Date().toISOString(),
      service: "payments",
      database: "connected",
      version: "1.0.0",
    });
  } catch (error) {
    return res.status(503).json({
      status: "down",
      service: "payments",
      database: "disconnected",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = {
  getTransaction,
  listTransactions,
  transitionPayment,
  getPaymentStats,
  flagTransaction,
  healthCheck,
};
