const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
  getConsultation,
  listConsultations,
  transitionConsultation,
  getConsultationStats,
} = require("./telemedicine.controller");

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

router.get("/stats", getConsultationStats);
router.get("/", listConsultations);
router.get("/:id", getConsultation);
router.patch("/:id/status", transitionConsultation);

module.exports = router;
