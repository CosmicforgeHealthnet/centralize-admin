const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");
const healthnetService = require("./healthnet.service");

const getLabs = asyncHandler(async (req, res) => {
  const data = await healthnetService.getLabs(req.query);

  return ApiResponse.success(res, 200, "HealthNet labs retrieved", data);
});

const getLabById = asyncHandler(async (req, res) => {
  const data = await healthnetService.getLabById(req.params.id);

  return ApiResponse.success(res, 200, "HealthNet lab retrieved", data);
});

const getLabStaff = asyncHandler(async (req, res) => {
  const data = await healthnetService.getLabStaff(req.params.id);

  return ApiResponse.success(res, 200, "HealthNet lab staff retrieved", data);
});

const getLabDocuments = asyncHandler(async (req, res) => {
  const data = await healthnetService.getLabDocuments(req.params.id);

  return ApiResponse.success(
    res,
    200,
    "HealthNet lab documents retrieved",
    data,
  );
});

const getPharmacies = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPharmacies(req.query);

  return ApiResponse.success(
    res,
    200,
    "HealthNet pharmacies retrieved",
    data,
  );
});

const getPharmacyById = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPharmacyById(req.params.id);

  return ApiResponse.success(res, 200, "HealthNet pharmacy retrieved", data);
});

const getPharmacyStaff = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPharmacyStaff(req.params.id);

  return ApiResponse.success(
    res,
    200,
    "HealthNet pharmacy staff retrieved",
    data,
  );
});

const getPharmacyDocuments = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPharmacyDocuments(req.params.id);

  return ApiResponse.success(
    res,
    200,
    "HealthNet pharmacy documents retrieved",
    data,
  );
});

const getPatients = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatients(req.query);

  return ApiResponse.success(res, 200, "HealthNet patients retrieved", data);
});

const getPatientById = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatientById(req.params.id);

  return ApiResponse.success(res, 200, "HealthNet patient retrieved", data);
});

const getPatientAppointmentsTimeline = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatientAppointmentsTimeline(
    req.params.id,
    req.query,
  );

  return ApiResponse.success(
    res,
    200,
    "HealthNet patient appointments timeline retrieved",
    data,
  );
});

const getPatientMedicalHistory = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatientMedicalHistory(
    req.params.id,
    req.query,
  );

  return ApiResponse.success(
    res,
    200,
    "HealthNet patient medical history retrieved",
    data,
  );
});

const getPatientRecords = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatientRecords(req.params.id, req.query);

  return ApiResponse.success(
    res,
    200,
    "HealthNet patient records retrieved",
    data,
  );
});

const getDoctors = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDoctors(req.query);

  return ApiResponse.success(res, 200, "HealthNet doctors retrieved", data);
});

const getDoctorById = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDoctorById(req.params.id);

  return ApiResponse.success(res, 200, "HealthNet doctor retrieved", data);
});

const getDoctorAppointmentsTimeline = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDoctorAppointmentsTimeline(
    req.params.id,
    req.query,
  );

  return ApiResponse.success(
    res,
    200,
    "HealthNet doctor appointments timeline retrieved",
    data,
  );
});

const getDoctorCertifications = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDoctorCertifications(req.params.id);

  return ApiResponse.success(
    res,
    200,
    "HealthNet doctor certifications retrieved",
    data,
  );
});

const getDoctorRatings = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDoctorRatings(req.params.id, req.query);

  return ApiResponse.success(
    res,
    200,
    "HealthNet doctor ratings retrieved",
    data,
  );
});

const getAppointments = asyncHandler(async (req, res) => {
  const data = await healthnetService.getAppointments(req.query);

  return ApiResponse.success(res, 200, "HealthNet appointments retrieved", data);
});

const searchAppointments = asyncHandler(async (req, res) => {
  const data = await healthnetService.searchAppointments(req.query);

  return ApiResponse.success(
    res,
    200,
    "HealthNet appointments search retrieved",
    data,
  );
});

const getDashboardMetrics = asyncHandler(async (req, res) => {
  const data = await healthnetService.getDashboardMetrics();
  return ApiResponse.success(
    res,
    200,
    "HealthNet dashboard metrics retrieved",
    data,
  );
});

const getActivityChart = asyncHandler(async (req, res) => {
  const data = await healthnetService.getActivityChart({
    month: req.query.month,
  });

  return ApiResponse.success(
    res,
    200,
    "HealthNet activity chart retrieved",
    data,
  );
});

const getPatientsChart = asyncHandler(async (req, res) => {
  const data = await healthnetService.getPatientsChart({
    month: req.query.month,
  });

  return ApiResponse.success(
    res,
    200,
    "HealthNet patients chart retrieved",
    data,
  );
});

const getRevenueChart = asyncHandler(async (req, res) => {
  const data = await healthnetService.getRevenueChart();
  return ApiResponse.success(
    res,
    200,
    "HealthNet revenue chart retrieved",
    data,
  );
});

module.exports = {
  getLabs,
  getLabById,
  getLabStaff,
  getLabDocuments,
  getPharmacies,
  getPharmacyById,
  getPharmacyStaff,
  getPharmacyDocuments,
  getPatients,
  getPatientById,
  getPatientAppointmentsTimeline,
  getPatientMedicalHistory,
  getPatientRecords,
  getDoctors,
  getDoctorById,
  getDoctorAppointmentsTimeline,
  getDoctorCertifications,
  getDoctorRatings,
  getAppointments,
  searchAppointments,
  getDashboardMetrics,
  getActivityChart,
  getPatientsChart,
  getRevenueChart,
};
