const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const documentsService = require("./documents.service");

const getEmployees = asyncHandler(async (req, res) => {
  const data = await documentsService.getEmployees(req.query);
  return ApiResponse.success(res, 200, "HRM document employees retrieved", data);
});

const getEmployeeDocuments = asyncHandler(async (req, res) => {
  const data = await documentsService.getEmployeeDocuments({
    employeeId: req.params.employeeId,
    actor: req.adminUser,
    query: req.query,
  });
  return ApiResponse.success(res, 200, "HRM employee documents retrieved", data);
});

const uploadDocument = asyncHandler(async (req, res) => {
  const data = await documentsService.uploadDocument({
    employeeId: req.params.employeeId,
    actor: req.adminUser,
    file: req.file,
    data: req.body,
    req,
  });
  return ApiResponse.success(res, 201, "HRM document uploaded", data);
});

const deleteDocument = asyncHandler(async (req, res) => {
  await documentsService.deleteDocument({
    employeeId: req.params.employeeId,
    documentId: req.params.docId,
    actor: req.adminUser,
    req,
  });
  return ApiResponse.success(res, 200, "HRM document deleted");
});

const downloadDocument = asyncHandler(async (req, res) => {
  const data = await documentsService.getDownload({
    employeeId: req.params.employeeId,
    documentId: req.params.docId,
    actor: req.adminUser,
  });
  return ApiResponse.success(res, 200, "HRM document download URL retrieved", data);
});

module.exports = {
  deleteDocument,
  downloadDocument,
  getEmployeeDocuments,
  getEmployees,
  uploadDocument,
};
