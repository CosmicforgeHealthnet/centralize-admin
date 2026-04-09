const express = require("express");
const router = express.Router();
const controller = require("./doctors.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  readOnly,
} = require("../../shared/middlewares/rbac.middleware");

router.use(authenticate);
router.use(readOnly);

// Stats — powers StatCards
router.get("/stats", requireTier("EMPLOYEE"), controller.getDoctorStats);

// List routes
router.get("/", requireTier("EMPLOYEE"), controller.getAllDoctors);
router.get("/verified", requireTier("EMPLOYEE"), controller.getVerifiedDoctors);
router.get("/online", requireTier("EMPLOYEE"), controller.getOnlineDoctors);
router.get("/search", requireTier("EMPLOYEE"), controller.searchDoctors);

// Single doctor
router.get("/:userId", requireTier("EMPLOYEE"), controller.getDoctorById);

module.exports = router;
