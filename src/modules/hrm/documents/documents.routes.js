const express = require("express");
const multer = require("multer");
const ApiError = require("../../../shared/utils/ApiError");
const {
  requireTier,
  requireSection,
} = require("../../../shared/middlewares/rbac.middleware");
const { multerSingle } = require("../hrm.utils");
const documentsController = require("./documents.controller");
const {
  documentUploadSchema,
  validateMultipartBody,
} = require("./documents.validator");

const router = express.Router();

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    return cb(new ApiError(400, "Unsupported file type"));
  },
});

router.get(
  "/employees",
  requireTier("ADMIN"),
  documentsController.getEmployees,
);
router.get(
  "/:employeeId",
  requireTier("EMPLOYEE"),
  documentsController.getEmployeeDocuments,
);
router.post(
  "/:employeeId",
  requireTier("EXECUTIVE"),
  requireSection("hrm", "documents", "EDIT"),
  multerSingle(documentUpload, "file"),
  validateMultipartBody(documentUploadSchema),
  documentsController.uploadDocument,
);
router.delete(
  "/:employeeId/:docId",
  requireTier("EXECUTIVE"),
  requireSection("hrm", "documents", "EDIT"),
  documentsController.deleteDocument,
);
router.get(
  "/:employeeId/:docId/download",
  requireTier("EMPLOYEE"),
  documentsController.downloadDocument,
);

module.exports = router;
