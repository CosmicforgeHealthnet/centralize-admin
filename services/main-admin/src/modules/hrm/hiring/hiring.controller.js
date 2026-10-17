const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const hiringService = require("./hiring.service");

const getStats = asyncHandler(async (req, res) => {
  const data = await hiringService.getStats(req.query);
  return ApiResponse.success(res, 200, "HRM hiring stats retrieved", data);
});

const listVacancies = asyncHandler(async (req, res) => {
  const data = await hiringService.listVacancies(req.query);
  return ApiResponse.success(res, 200, "HRM vacancies retrieved", data);
});

const createVacancy = asyncHandler(async (req, res) => {
  const data = await hiringService.createVacancy({
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 201, "HRM vacancy created", data);
});

const getVacancy = asyncHandler(async (req, res) => {
  const data = await hiringService.getVacancy(req.params.id);
  return ApiResponse.success(res, 200, "HRM vacancy retrieved", data);
});

const updateVacancy = asyncHandler(async (req, res) => {
  const data = await hiringService.updateVacancy({
    id: req.params.id,
    data: req.body,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM vacancy updated", data);
});

const updateVacancyStatus = asyncHandler(async (req, res) => {
  const data = await hiringService.updateVacancyStatus({
    id: req.params.id,
    status: req.body.status,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM vacancy status updated", data);
});

const deleteVacancy = asyncHandler(async (req, res) => {
  await hiringService.deleteVacancy({
    id: req.params.id,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM vacancy deleted");
});

const listApplicants = asyncHandler(async (req, res) => {
  const data = await hiringService.listApplicants(req.params.id, req.query);
  return ApiResponse.success(res, 200, "HRM vacancy applicants retrieved", data);
});

const getApplicant = asyncHandler(async (req, res) => {
  const data = await hiringService.getApplicant(req.params.id);
  return ApiResponse.success(res, 200, "HRM applicant retrieved", data);
});

const updateApplicantStage = asyncHandler(async (req, res) => {
  const data = await hiringService.updateApplicantStage({
    id: req.params.id,
    stage: req.body.stage,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM applicant stage updated", data);
});

module.exports = {
  createVacancy,
  deleteVacancy,
  getApplicant,
  getStats,
  getVacancy,
  listApplicants,
  listVacancies,
  updateApplicantStage,
  updateVacancy,
  updateVacancyStatus,
};
