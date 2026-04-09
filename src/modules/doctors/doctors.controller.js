const doctorsService = require("./doctors.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getAllDoctors = asyncHandler(async (req, res) => {
  const result = await doctorsService.getAllDoctors();
  return ApiResponse.success(res, 200, "Doctors retrieved", result);
});

const getVerifiedDoctors = asyncHandler(async (req, res) => {
  const result = await doctorsService.getVerifiedDoctors();
  return ApiResponse.success(res, 200, "Verified doctors retrieved", result);
});

const getOnlineDoctors = asyncHandler(async (req, res) => {
  const result = await doctorsService.getOnlineDoctors();
  return ApiResponse.success(res, 200, "Online doctors retrieved", result);
});

const getDoctorById = asyncHandler(async (req, res) => {
  const result = await doctorsService.getDoctorById(req.params.userId);
  return ApiResponse.success(res, 200, "Doctor retrieved", result);
});

const searchDoctors = asyncHandler(async (req, res) => {
  const { q } = req.query;
  const result = await doctorsService.searchDoctors(q);
  return ApiResponse.success(res, 200, "Search results retrieved", result);
});

// Powers StatCards
const getDoctorStats = asyncHandler(async (req, res) => {
  const result = await doctorsService.getDoctorStats();
  return ApiResponse.success(res, 200, "Doctor stats retrieved", result);
});

module.exports = {
  getAllDoctors,
  getVerifiedDoctors,
  getOnlineDoctors,
  getDoctorById,
  searchDoctors,
  getDoctorStats,
};
