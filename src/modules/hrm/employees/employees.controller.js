const ApiError = require("../../../shared/utils/ApiError");
const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const employeesService = require("./employees.service");

const listEmployees = asyncHandler(async (req, res) => {
  const data = await employeesService.listEmployees({
    query: req.query,
    actor: req.adminUser,
  });
  return ApiResponse.success(res, 200, "HRM employees retrieved", data);
});

const getEmployee = asyncHandler(async (req, res) => {
  const data = await employeesService.getEmployee({
    id: req.params.id,
    actor: req.adminUser,
  });
  return ApiResponse.success(res, 200, "HRM employee retrieved", data);
});

const updatePersonal = asyncHandler(async (req, res) => {
  const data = await employeesService.updatePersonal({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Employee personal info updated", data);
});

const updateContact = asyncHandler(async (req, res) => {
  const data = await employeesService.updateContact({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Employee contact info updated", data);
});

const updateEmployment = asyncHandler(async (req, res) => {
  const data = await employeesService.updateEmployment({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Employee employment info updated", data);
});

const updateEmergency = asyncHandler(async (req, res) => {
  const data = await employeesService.updateEmergency({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Employee emergency contact updated", data);
});

const updateSocial = asyncHandler(async (req, res) => {
  const data = await employeesService.updateSocial({
    id: req.params.id,
    actor: req.adminUser,
    links: req.body.links,
    req,
  });
  return ApiResponse.success(res, 200, "Employee social links updated", data);
});

const updateSensitive = asyncHandler(async (req, res) => {
  await employeesService.updateSensitive({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Employee sensitive info updated");
});

const updateAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "No image uploaded. Use field 'avatar'.");
  const data = await employeesService.updateAvatar({
    id: req.params.id,
    actor: req.adminUser,
    file: req.file,
    req,
  });
  return ApiResponse.success(res, 200, "Employee avatar updated", data);
});

const listEducation = asyncHandler(async (req, res) => {
  const data = await employeesService.listEducation({
    id: req.params.id,
    actor: req.adminUser,
  });
  return ApiResponse.success(res, 200, "Employee education retrieved", data);
});

const createEducation = asyncHandler(async (req, res) => {
  const data = await employeesService.createEducation({
    id: req.params.id,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 201, "Employee education created", data);
});

const updateEducation = asyncHandler(async (req, res) => {
  const data = await employeesService.updateEducation({
    id: req.params.id,
    educationId: req.params.eid,
    actor: req.adminUser,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Employee education updated", data);
});

const deleteEducation = asyncHandler(async (req, res) => {
  await employeesService.deleteEducation({
    id: req.params.id,
    educationId: req.params.eid,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "Employee education deleted");
});

module.exports = {
  createEducation,
  deleteEducation,
  getEmployee,
  listEducation,
  listEmployees,
  updateAvatar,
  updateContact,
  updateEducation,
  updateEmergency,
  updateEmployment,
  updatePersonal,
  updateSensitive,
  updateSocial,
};
