const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
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
// Admin tier as before, or an employee whose department defaults include
// this module; each route below still checks its section.
router.use(requireTierOrDepartment("ADMIN", "operations"));
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
