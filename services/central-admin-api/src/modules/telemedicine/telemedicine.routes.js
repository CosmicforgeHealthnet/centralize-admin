const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { mainDbBoundary } = require("../../shared/middlewares/dependency-boundary.middleware");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
} = require("../../shared/middlewares/rbac.middleware");
const {
  getConsultation,
  listConsultations,
  transitionConsultation,
  getConsultationStats,
  healthCheck,
} = require("./telemedicine.controller");

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/health", healthCheck);
router.use(authenticate);
// Admin tier as before, or an employee whose department defaults include
// this module; each route below still checks its section.
router.use(requireTierOrDepartment("ADMIN", "telemedicine"));
router.use(limiter);

router.get(
  "/stats",
  requireSection("telemedicine", "consultations", "VIEW"),
  mainDbBoundary.gate,
  getConsultationStats,
);
router.get(
  "/",
  requireSection("telemedicine", "consultations", "VIEW"),
  mainDbBoundary.gate,
  listConsultations,
);
router.get(
  "/:id",
  requireSection("telemedicine", "consultations", "VIEW"),
  mainDbBoundary.gate,
  getConsultation,
);
router.patch(
  "/:id/status",
  requireSection("telemedicine", "consultations", "EDIT"),
  mainDbBoundary.gate,
  transitionConsultation,
);

router.use(mainDbBoundary.handleError);

module.exports = router;
