const express = require("express");
const router = express.Router();
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const controller = require("./verification.controller");

// All verification routes require authentication
router.use(authenticate);

// ── Combined (All tab) ─────────────────────────────────────────────────────────
// GET /api/verification/all
router.get("/all", controller.getAllCombined);

// ── Doctor Verifications ───────────────────────────────────────────────────────
// GET    /api/verification/doctors           — paginated list
// GET    /api/verification/doctors/:id       — full detail
// PATCH  /api/verification/doctors/:id/approve
// PATCH  /api/verification/doctors/:id/reject
// PATCH  /api/verification/doctors/:id/assign

router.get("/doctors", controller.getAll);
router.get("/doctors/:id", controller.getById);
// requireTier("ADMIN") → ADMIN, EXECUTIVE, SUPER all pass (hierarchy-based)
router.patch("/doctors/:id/approve", requireTier("ADMIN"), controller.approve);
router.patch("/doctors/:id/reject", requireTier("ADMIN"), controller.reject);
router.patch(
  "/doctors/:id/assign",
  requireTier("ADMIN"),
  controller.assignReviewer,
);

// ── Pharmacy Verifications ─────────────────────────────────────────────────────
// GET    /api/verification/pharmacies
// GET    /api/verification/pharmacies/:id
// PATCH  /api/verification/pharmacies/:id/approve
// PATCH  /api/verification/pharmacies/:id/reject

router.get("/pharmacies", controller.getPharmacyVerifications);
router.get("/pharmacies/:id", controller.getPharmacyVerificationById);
router.patch(
  "/pharmacies/:id/approve",
  requireTier("ADMIN"),
  controller.approvePharmacy,
);
router.patch(
  "/pharmacies/:id/reject",
  requireTier("ADMIN"),
  controller.rejectPharmacy,
);

// ── Lab Verifications ──────────────────────────────────────────────────────────
// GET    /api/verification/labs
// GET    /api/verification/labs/:id
// PATCH  /api/verification/labs/:id/approve
// PATCH  /api/verification/labs/:id/reject

router.get("/labs", controller.getLabVerifications);
router.get("/labs/:id", controller.getLabVerificationById);
router.patch("/labs/:id/approve", requireTier("ADMIN"), controller.approveLab);
router.patch("/labs/:id/reject", requireTier("ADMIN"), controller.rejectLab);

module.exports = router;
