const { mainPrisma } = require("../../shared/config/mainDatabase");
const ApiError = require("../../shared/utils/ApiError");
const verificationService = require("./verification.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

// ── Doctor Verifications ──────────────────────────────────────────────────────

const getAll = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    status,
    startDate,
    endDate,
    search,
    riskIndicator,
    countryCode,
  } = req.query;
  const data = await verificationService.getAll({
    page,
    limit,
    status,
    startDate,
    endDate,
    search,
    riskIndicator,
    countryCode,
  });
  return ApiResponse.success(res, 200, "Verification requests retrieved", data);
});

const getById = asyncHandler(async (req, res) => {
  const data = await verificationService.getById(req.params.id);
  return ApiResponse.success(res, 200, "Verification request retrieved", data);
});

const approve = asyncHandler(async (req, res) => {
  const { reviewNotes } = req.body;
  const data = await verificationService.approve({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    reviewNotes,
    req,
  });
  return ApiResponse.success(res, 200, "Verification request approved", data);
});

const reject = asyncHandler(async (req, res) => {
  const { rejectionReason, reviewNotes } = req.body;
  const data = await verificationService.reject({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    rejectionReason,
    reviewNotes,
    req,
  });
  return ApiResponse.success(res, 200, "Verification request rejected", data);
});

const assignReviewer = asyncHandler(async (req, res) => {
  const { reviewerId } = req.body;
  const data = await verificationService.assignReviewer({
    id: req.params.id,
    reviewerId,
    adminUserId: req.adminUser.id,
    req,
  });
  return ApiResponse.success(res, 200, "Reviewer assigned", data);
});

// ── Pharmacy Verifications ────────────────────────────────────────────────────

const getPharmacyVerifications = asyncHandler(async (req, res) => {
  const { page, limit, status, startDate, endDate, search } = req.query;
  const data = await verificationService.getPharmacyVerifications({
    page,
    limit,
    status,
    startDate,
    endDate,
    search,
  });
  return ApiResponse.success(
    res,
    200,
    "Pharmacy verification requests retrieved",
    data,
  );
});

const getPharmacyVerificationById = asyncHandler(async (req, res) => {
  const data = await verificationService.getPharmacyVerificationById(
    req.params.id,
  );
  return ApiResponse.success(
    res,
    200,
    "Pharmacy verification request retrieved",
    data,
  );
});

const approvePharmacy = asyncHandler(async (req, res) => {
  const { reviewNotes } = req.body;
  const data = await verificationService.approvePharmacy({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    reviewNotes,
    req,
  });
  return ApiResponse.success(res, 200, "Pharmacy verification approved", data);
});

const rejectPharmacy = asyncHandler(async (req, res) => {
  const { rejectionReason, reviewNotes } = req.body;
  const data = await verificationService.rejectPharmacy({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    rejectionReason,
    reviewNotes,
    req,
  });
  return ApiResponse.success(res, 200, "Pharmacy verification rejected", data);
});

// ── Lab Verifications ─────────────────────────────────────────────────────────

const getLabVerifications = asyncHandler(async (req, res) => {
  const { page, limit, status, startDate, endDate, search } = req.query;
  const data = await verificationService.getLabVerifications({
    page,
    limit,
    status,
    startDate,
    endDate,
    search,
  });
  return ApiResponse.success(
    res,
    200,
    "Lab verification requests retrieved",
    data,
  );
});

const getLabVerificationById = asyncHandler(async (req, res) => {
  const data = await verificationService.getLabVerificationById(req.params.id);
  return ApiResponse.success(
    res,
    200,
    "Lab verification request retrieved",
    data,
  );
});

const approveLab = asyncHandler(async (req, res) => {
  const data = await verificationService.approveLab({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    req,
  });
  return ApiResponse.success(res, 200, "Lab verification approved", data);
});

const rejectLab = asyncHandler(async (req, res) => {
  const { rejectionReason } = req.body;
  const data = await verificationService.rejectLab({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    rejectionReason,
    req,
  });
  return ApiResponse.success(res, 200, "Lab verification rejected", data);
});

// ── Combined (All tab) ────────────────────────────────────────────────────────

const getAllCombined = asyncHandler(async (req, res) => {
  const { page, limit, status, startDate, endDate, search } = req.query;
  const data = await verificationService.getAllCombined({
    page,
    limit,
    status,
    startDate,
    endDate,
    search,
  });
  return ApiResponse.success(
    res,
    200,
    "All verification requests retrieved",
    data,
  );
});

// ── Stuck Doctors ─────────────────────────────────────────────────────────────

/**
 * GET /api/verification/stuck-doctors
 * Returns doctors stuck in pending_doctor_verification with no verification request
 */
const getStuckDoctors = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const data = await verificationService.getStuckDoctors({ page, limit });
  return ApiResponse.success(
    res,
    200,
    "Stuck doctors retrieved successfully",
    data
  );
});
// ─── Stuck Doctor Detail ──────────────────────────────────────────────────────

/**
 * GET /api/verification/stuck-doctors/:id
 * Get a single stuck doctor by ID
 */
const getStuckDoctorById = asyncHandler(async (req, res) => {
  const data = await verificationService.getStuckDoctorById(req.params.id);
  return ApiResponse.success(res, 200, "Stuck doctor retrieved", data);
});

/**
 * POST /api/verification/stuck-doctors/:id/fix
 * Create a verification request for a stuck doctor
 */
const fixStuckDoctor = asyncHandler(async (req, res) => {
  const data = await verificationService.fixStuckDoctor({
    id: req.params.id,
    adminUserId: req.adminUser.id,
    req
  });
  return ApiResponse.success(res, 200, "Verification request created successfully", data);
});


const healthCheck = asyncHandler(async (req, res) => {
  try {
    // Test database connection
    await mainPrisma.$queryRaw`SELECT 1`;

    return ApiResponse.success(res, 200, "Service healthy", {
      status: "up",
      timestamp: new Date().toISOString(),
      service: "verification",
      database: "connected",
      version: "1.0.0",
    });
  } catch (error) {
    return res.status(503).json({
      status: "down",
      service: "verification",
      database: "disconnected",
      error: error.message,
    });
  }
});

module.exports = {
  // Doctors
  getAll,
  getById,
  approve,
  reject,
  assignReviewer,
  // Pharmacies
  getPharmacyVerifications,
  getPharmacyVerificationById,
  approvePharmacy,
  rejectPharmacy,
  // Labs
  getLabVerifications,
  getLabVerificationById,
  approveLab,
  rejectLab,
  // Combined
  getAllCombined,
  healthCheck,
  getStuckDoctors,
  getStuckDoctorById,
  fixStuckDoctor, 
};
