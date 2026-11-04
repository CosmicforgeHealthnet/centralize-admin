const express = require("express");
const router = express.Router();
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireTierOrSection,
  requireDifferentReviewer,
} = require("../../shared/middlewares/rbac.middleware");
const controller = require("./verification.controller");
const { mainPrisma } = require("../../shared/config/mainDatabase");
const { prisma } = require("../../shared/config/database");

const getDoctorPriorReviewer = async (req) => {
  const vr = await mainPrisma.verification_requests.findUnique({
    where: { id: req.params.id },
    select: { assignedReviewerId: true },
  });
  if (!vr?.assignedReviewerId) return null;

  const adminUser = await prisma.adminUser.findUnique({
    where: { id: req.adminUser.id },
    select: { mainAppUserId: true },
  });

  return vr.assignedReviewerId === adminUser?.mainAppUserId
    ? req.adminUser.id
    : null;
};

router.get("/health", controller.healthCheck);

router.use(authenticate);

router.get("/all", controller.getAllCombined);

// ── Stuck Doctors ─────────────────────────────────────────────────────────────
router.get("/stuck-doctors", requireTierOrSection("ADMIN", "verification", "providers", "EDIT"), controller.getStuckDoctors);
router.get(
  "/stuck-doctors/:id",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  controller.getStuckDoctorById,
);
router.post(
  "/stuck-doctors/:id/fix",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  controller.fixStuckDoctor,
);

router.get("/doctors", controller.getAll);
router.get("/doctors/:id", controller.getById);
router.patch(
  "/doctors/:id/approve",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  requireDifferentReviewer(getDoctorPriorReviewer),
  controller.approve,
);
router.patch(
  "/doctors/:id/reject",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  requireDifferentReviewer(getDoctorPriorReviewer),
  controller.reject,
);
router.patch(
  "/doctors/:id/assign",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  controller.assignReviewer,
);

router.get("/pharmacies", controller.getPharmacyVerifications);
router.get("/pharmacies/:id", controller.getPharmacyVerificationById);
router.patch(
  "/pharmacies/:id/approve",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  controller.approvePharmacy,
);
router.patch(
  "/pharmacies/:id/reject",
  requireTierOrSection("ADMIN", "verification", "providers", "EDIT"),
  controller.rejectPharmacy,
);

router.get("/labs", controller.getLabVerifications);
router.get("/labs/:id", controller.getLabVerificationById);
router.patch("/labs/:id/approve", requireTierOrSection("ADMIN", "verification", "providers", "EDIT"), controller.approveLab);
router.post("/labs/:id/resend-setup-link", requireTierOrSection("ADMIN", "verification", "providers", "EDIT"), controller.resendLabSetupLink);
router.patch("/labs/:id/reject", requireTierOrSection("ADMIN", "verification", "providers", "EDIT"), controller.rejectLab);

module.exports = router;
