const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const healthnetController = require("./healthnet.controller");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(limiter);

router.get("/patients", healthnetController.getPatients);
router.get(
  "/patients/:id/appointments",
  healthnetController.getPatientAppointmentsTimeline,
);
router.get(
  "/patients/:id/medical-history",
  healthnetController.getPatientMedicalHistory,
);
router.get("/patients/:id/records", healthnetController.getPatientRecords);
router.get("/patients/:id", healthnetController.getPatientById);
router.get("/doctors", healthnetController.getDoctors);
router.get(
  "/doctors/:id/appointments",
  healthnetController.getDoctorAppointmentsTimeline,
);
router.get(
  "/doctors/:id/certifications",
  healthnetController.getDoctorCertifications,
);
router.get("/doctors/:id/ratings", healthnetController.getDoctorRatings);
router.get("/doctors/:id", healthnetController.getDoctorById);
router.get("/appointments/search", healthnetController.searchAppointments);
router.get("/appointments", healthnetController.getAppointments);
router.get("/dashboard/metrics", healthnetController.getDashboardMetrics);
router.get("/dashboard/charts/activity", healthnetController.getActivityChart);
router.get("/dashboard/charts/patients", healthnetController.getPatientsChart);
router.get("/dashboard/charts/revenue", healthnetController.getRevenueChart);

module.exports = router;
