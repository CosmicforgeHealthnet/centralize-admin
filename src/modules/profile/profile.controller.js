const { validationResult } = require("express-validator");
const profileService = require("./profile.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const ApiError = require("../../shared/utils/ApiError");
const asyncHandler = require("../../shared/utils/asyncHandler");

const validate = (req) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ApiError(422, "Validation failed", errors.array());
  }
};

// GET /profile/me
const getMyProfile = asyncHandler(async (req, res) => {
  const profile = await profileService.getMyProfile(req.adminUser.id);
  return ApiResponse.success(res, 200, "Profile retrieved", profile);
});

// PATCH /profile/me/personal
const updatePersonalInfo = asyncHandler(async (req, res) => {
  validate(req);
  const updated = await profileService.updatePersonalInfo({
    adminUserId: req.adminUser.id,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Personal info updated", updated);
});

// PATCH /profile/me/contact
const updateContactInfo = asyncHandler(async (req, res) => {
  validate(req);
  const updated = await profileService.updateContactInfo({
    adminUserId: req.adminUser.id,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Contact info updated", updated);
});

// PATCH /profile/me/emergency
const updateEmergencyContact = asyncHandler(async (req, res) => {
  validate(req);
  const updated = await profileService.updateEmergencyContact({
    adminUserId: req.adminUser.id,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 200, "Emergency contact updated", updated);
});

// PUT /profile/me/social
const updateSocialLinks = asyncHandler(async (req, res) => {
  validate(req);
  const links = await profileService.updateSocialLinks({
    adminUserId: req.adminUser.id,
    links: req.body.links,
    req,
  });
  return ApiResponse.success(res, 200, "Social links updated", links);
});

// PUT /profile/me/education
const updateEducation = asyncHandler(async (req, res) => {
  validate(req);
  const entries = await profileService.updateEducation({
    adminUserId: req.adminUser.id,
    entries: req.body.entries,
    req,
  });
  return ApiResponse.success(res, 200, "Education updated", entries);
});

// GET /profile/me/documents/:id/download
// Employee can only download — upload is done by SUPER/EXECUTIVE
const getDocumentDownloadUrl = asyncHandler(async (req, res) => {
  validate(req);
  const result = await profileService.getDocumentDownloadUrl({
    adminUserId: req.adminUser.id,
    documentId: req.params.id,
  });
  return ApiResponse.success(res, 200, "Download URL retrieved", result);
});

// PATCH /profile/me/avatar
const updateAvatar = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(
      400,
      "No image uploaded. Send image as multipart/form-data under the field name 'avatar'",
    );
  }
  const result = await profileService.updateAvatar({
    adminUserId: req.adminUser.id,
    file: req.file,
    req,
  });
  return ApiResponse.success(res, 200, "Avatar updated successfully", result);
});

// POST /profile/me/reports
const addReport = asyncHandler(async (req, res) => {
  validate(req);

  const { title, body, note } = req.body;

  const report = await profileService.addReport({
    adminUserId: req.adminUser.id,
    file: req.file || null,
    title,
    body,
    note,
    req,
  });

  return ApiResponse.success(res, 201, "Report created successfully", report);
});

// GET /profile/me/reports/:id/download
const getReportDownloadUrl = asyncHandler(async (req, res) => {
  const result = await profileService.getReportDownloadUrl({
    adminUserId: req.adminUser.id,
    reportId: req.params.id,
  });
  return ApiResponse.success(res, 200, "Download URL retrieved", result);
});
// PATCH /profile/me/reports/:id
const updateReport = asyncHandler(async (req, res) => {
  validate(req);
  const { title, body, note } = req.body;
  const updated = await profileService.updateReport({
    adminUserId: req.adminUser.id,
    reportId: req.params.id,
    file: req.file || null,
    title,
    body,
    note,
    req,
  });
  return ApiResponse.success(res, 200, "Report updated successfully", updated);
});

// DELETE /profile/me/reports/:id
const deleteReport = asyncHandler(async (req, res) => {
  await profileService.deleteReport({
    adminUserId: req.adminUser.id,
    reportId: req.params.id,
    req,
  });
  return ApiResponse.success(res, 200, "Report deleted successfully", null);
});

// GET /profile/me/reports/:id
const getReport = asyncHandler(async (req, res) => {
  validate(req);
  const report = await profileService.getReport({
    adminUserId: req.adminUser.id,
    reportId: req.params.id,
  });
  return ApiResponse.success(res, 200, "Report retrieved", report);
});
const getMyProjects = asyncHandler(async (req, res) => {
  const projects = await profileService.getMyProjects(req.adminUser.id);
  return ApiResponse.success(res, 200, "Projects retrieved", projects);
});
// GET /profile/me/projects/:id
const getMyProjectDetail = asyncHandler(async (req, res) => {
  validate(req);
  const project = await profileService.getMyProjectDetail({
    adminUserId: req.adminUser.id,
    projectId:   req.params.id,
  });
  return ApiResponse.success(res, 200, "Project retrieved", project);
});

// GET /profile/me/tasks
const getMyTasks = asyncHandler(async (req, res) => {
  const tasks = await profileService.getMyTasks(req.adminUser.id);
  return ApiResponse.success(res, 200, "Tasks retrieved", tasks);
});

// GET /profile/me/tasks/:id
const getMyTaskDetail = asyncHandler(async (req, res) => {
  validate(req);
  const task = await profileService.getMyTaskDetail({
    adminUserId: req.adminUser.id,
    taskId:      req.params.id,
  });
  return ApiResponse.success(res, 200, "Task retrieved", task);
});
// GET /profile/me/teams
const getMyTeams = asyncHandler(async (req, res) => {
  const teams = await profileService.getMyTeams(req.adminUser.id);
  return ApiResponse.success(res, 200, "Teams retrieved", teams);
});





module.exports = {
  getMyProfile,
  updatePersonalInfo,
  updateContactInfo,
  updateEmergencyContact,
  updateSocialLinks,
  updateEducation,
  updateAvatar,
  getDocumentDownloadUrl,
  addReport,
  getReport,
  getReportDownloadUrl,
  updateReport,
  deleteReport,
  getMyProjects,
  getMyProjectDetail,
  getMyTasks,
  getMyTaskDetail,
  getMyTeams,
};
