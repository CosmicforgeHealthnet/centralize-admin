const logisticsService = require("./logistics.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getPrescription = asyncHandler(async (req, res) => {
  const data = await logisticsService.getPrescription(req.params.id);
  return ApiResponse.success(res, 200, "Prescription retrieved", data);
});

const listPrescriptions = asyncHandler(async (req, res) => {
  const { status, patientId, pharmacyId, page, limit } = req.query;
  const data = await logisticsService.listPrescriptions({
    status,
    patientId,
    pharmacyId,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Prescriptions retrieved", data);
});

const transitionDelivery = asyncHandler(async (req, res) => {
  const data = await logisticsService.transitionDelivery(
    req.params.id,
    req.body.status,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Delivery status updated", data);
});

const retryDelivery = asyncHandler(async (req, res) => {
  const data = await logisticsService.retryDelivery(req.params.id);
  return ApiResponse.success(res, 200, "Delivery retried", data);
});

const getDeliveryStats = asyncHandler(async (req, res) => {
  const data = await logisticsService.getDeliveryStats();
  return ApiResponse.success(res, 200, "Delivery stats retrieved", data);
});

module.exports = {
  getPrescription,
  listPrescriptions,
  transitionDelivery,
  retryDelivery,
  getDeliveryStats,
};
