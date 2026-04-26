const express = require("express");
const router = express.Router();
const multer = require("multer");

const { authenticate } = require("../../shared/middlewares/auth.middleware");
const controller = require("./profile.controller");
const {
  personalInfoRules,
  contactInfoRules,
  emergencyContactRules,
  socialLinksRules,
  educationRules,
  addReportRules,
  documentIdParam,
  reportIdParam,
  projectIdParam,
  taskIdParam,
} = require("./profile.validator");

// Multer for avatar — images only, 5 MB max
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, and WEBP images are allowed for avatars"));
    }
  },
});

// Multer for reports — PDF and DOCX only, 10 MB max
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and DOCX files are allowed for reports"));
    }
  },
});

// All profile routes require authentication
router.use(authenticate);

// ── Profile ────────────────────────────────────────────────────────────────
router.get("/me", controller.getMyProfile);

// ── Avatar ─────────────────────────────────────────────────────────────────
router.patch(
  "/me/avatar",
  avatarUpload.single("avatar"),
  controller.updateAvatar,
);

// ── Self-editable sections ─────────────────────────────────────────────────
router.patch("/me/personal", personalInfoRules, controller.updatePersonalInfo);
router.patch("/me/contact", contactInfoRules, controller.updateContactInfo);
router.patch(
  "/me/emergency",
  emergencyContactRules,
  controller.updateEmergencyContact,
);

// PUT — replace all entries at once
router.put("/me/social", socialLinksRules, controller.updateSocialLinks);
router.put("/me/education", educationRules, controller.updateEducation);

// ── Documents ──────────────────────────────────────────────────────────────
router.get(
  "/me/documents/:id/download",
  documentIdParam,
  controller.getDocumentDownloadUrl,
);

// ── Reports ────────────────────────────────────────────────────────────────
router.post(
  "/me/reports",
  reportUpload.single("file"),
  addReportRules,
  controller.addReport,
);
router.get("/me/reports/:id", reportIdParam, controller.getReport);
router.get(
  "/me/reports/:id/download",
  reportIdParam,
  controller.getReportDownloadUrl,
);
router.patch(
  "/me/reports/:id",
  reportIdParam,
  reportUpload.single("file"),
  controller.updateReport,
);
router.delete("/me/reports/:id", reportIdParam, controller.deleteReport);

// ── Projects ───────────────────────────────────────────────────────────────
router.get("/me/projects", controller.getMyProjects);
router.get("/me/projects/:id", projectIdParam, controller.getMyProjectDetail);

// ── Tasks ──────────────────────────────────────────────────────────────────
router.get("/me/tasks", controller.getMyTasks);
router.get("/me/tasks/:id", taskIdParam, controller.getMyTaskDetail);

// ── Teams ───────────────────────────────────────────────────────────────────
router.get("/me/teams", controller.getMyTeams);

module.exports = router;
