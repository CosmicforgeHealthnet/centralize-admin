const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
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

router.get("/stats", getDeliveryStats);
router.get("/", listPrescriptions);
router.get("/:id", getPrescription);
router.patch("/:id/status", transitionDelivery);
router.post("/:id/retry", retryDelivery);

module.exports = router;
