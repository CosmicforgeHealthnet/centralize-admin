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

router.get("/labs", healthnetController.getLabs);
router.get("/labs/:id/staff", healthnetController.getLabStaff);
router.get("/labs/:id/documents", healthnetController.getLabDocuments);
router.get("/labs/:id", healthnetController.getLabById);
router.get("/pharmacies", healthnetController.getPharmacies);
router.get("/pharmacies/:id/staff", healthnetController.getPharmacyStaff);
router.get(
  "/pharmacies/:id/documents",
  healthnetController.getPharmacyDocuments,
);
router.get("/pharmacies/:id", healthnetController.getPharmacyById);
router.get("/finance/stats", healthnetController.getFinanceStats);
router.get(
  "/finance/revenue-tracking",
  healthnetController.getFinanceRevenueTracking,
);
router.get(
  "/finance/appointments-history",
  healthnetController.getFinanceAppointmentsHistory,
);
router.get(
  "/finance/subscriptions-history",
  healthnetController.getFinanceSubscriptionsHistory,
);
router.get(
  "/finance/sales-history",
  healthnetController.getFinanceSalesHistory,
);
router.get("/analytics/stats", healthnetController.getAnalyticsStats);
router.get("/analytics/doctors-percentage", healthnetController.getAnalyticsDoctorsPercentage);
router.get("/analytics/patients-statistics", healthnetController.getAnalyticsPatientsStatistics);
router.get("/analytics/revenue-tracking", healthnetController.getAnalyticsRevenueTracking);
router.get("/analytics/appointments-overview", healthnetController.getAnalyticsAppointmentsOverview);
router.get("/analytics/sales-analytics", healthnetController.getAnalyticsSalesAnalytics);
router.get("/analytics/delivery-overview", healthnetController.getAnalyticsDeliveryOverview);
router.get("/analytics/billing-memberships", healthnetController.getAnalyticsBillingMemberships);
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
