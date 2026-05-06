const telemedicineService = require("./telemedicine.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getConsultation = asyncHandler(async (req, res) => {
  const data = await telemedicineService.getConsultation(req.params.id);
  return ApiResponse.success(res, 200, "Consultation retrieved", data);
});

const listConsultations = asyncHandler(async (req, res) => {
  const { status, doctorId, patientId, page, limit } = req.query;
  const data = await telemedicineService.listConsultations({
    status,
    doctorId,
    patientId,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Consultations retrieved", data);
});

const transitionConsultation = asyncHandler(async (req, res) => {
  const data = await telemedicineService.transitionConsultation(
    req.params.id,
    req.body.status,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Consultation updated", data);
});

const getConsultationStats = asyncHandler(async (req, res) => {
  const data = await telemedicineService.getConsultationStats();
  return ApiResponse.success(res, 200, "Consultation stats retrieved", data);
});

module.exports = {
  getConsultation,
  listConsultations,
  transitionConsultation,
  getConsultationStats,
};
