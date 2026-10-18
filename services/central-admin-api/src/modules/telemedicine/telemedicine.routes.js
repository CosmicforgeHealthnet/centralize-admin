const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
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
router.use(requireTier("ADMIN"));
router.use(limiter);

router.get(
  "/stats",
  requireSection("telemedicine", "consultations", "VIEW"),
  getConsultationStats,
);
router.get(
  "/",
  requireSection("telemedicine", "consultations", "VIEW"),
  listConsultations,
);
router.get(
  "/:id",
  requireSection("telemedicine", "consultations", "VIEW"),
  getConsultation,
);
router.patch(
  "/:id/status",
  requireSection("telemedicine", "consultations", "EDIT"),
  transitionConsultation,
);

module.exports = router;
