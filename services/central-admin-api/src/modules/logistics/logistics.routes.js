const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
} = require("../../shared/middlewares/rbac.middleware");
const {
  getPrescription,
  listPrescriptions,
  transitionDelivery,
  retryDelivery,
  getDeliveryStats,
} = require("./logistics.controller");

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

router.get(
  "/stats",
  requireSection("operations", "logistics", "VIEW"),
  getDeliveryStats,
);
router.get(
  "/",
  requireSection("operations", "logistics", "VIEW"),
  listPrescriptions,
);
router.get(
  "/:id",
  requireSection("operations", "logistics", "VIEW"),
  getPrescription,
);
router.patch(
  "/:id/status",
  requireSection("operations", "logistics", "EDIT"),
  transitionDelivery,
);
router.post(
  "/:id/retry",
  requireSection("operations", "logistics", "EDIT"),
  retryDelivery,
);

module.exports = router;
