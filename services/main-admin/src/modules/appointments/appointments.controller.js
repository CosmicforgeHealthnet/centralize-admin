const appointmentsService = require("./appointments.service");
const { createAuditLog } = require("../../shared/middlewares/audit.middleware");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getAllAppointments = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const result = await appointmentsService.getAllAppointments({
    status,
    page,
    limit,
  });

  await createAuditLog({
    adminUserId: req.adminUser.id,
    action: "APPOINTMENT_VIEWED",
    targetType: "appointments",
    req,
  });

  return ApiResponse.success(res, 200, "Appointments retrieved", result);
});

const getAppointmentById = asyncHandler(async (req, res) => {
  const result = await appointmentsService.getAppointmentById(req.params.id);
  return ApiResponse.success(res, 200, "Appointment retrieved", result);
});

const getAnalytics = asyncHandler(async (req, res) => {
  const result = await appointmentsService.getAnalytics();
  return ApiResponse.success(
    res,
    200,
    "Appointment analytics retrieved",
    result,
  );
});

const getPatientAppointments = asyncHandler(async (req, res) => {
  const result = await appointmentsService.getPatientAppointments(
    req.params.patientId,
  );
  return ApiResponse.success(
    res,
    200,
    "Patient appointments retrieved",
    result,
  );
});

const getDoctorAppointments = asyncHandler(async (req, res) => {
  const result = await appointmentsService.getDoctorAppointments(
    req.params.doctorId,
  );
  return ApiResponse.success(res, 200, "Doctor appointments retrieved", result);
});

const cancelAppointment = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const result = await appointmentsService.cancelAppointment(
    req.params.id,
    reason,
  );
  return ApiResponse.success(res, 200, "Appointment cancelled", result);
});

module.exports = {
  getAllAppointments,
  getAppointmentById,
  getAnalytics,
  getPatientAppointments,
  getDoctorAppointments,
  cancelAppointment,
};
