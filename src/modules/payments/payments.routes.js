const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier, requireSection } = require("../../shared/middlewares/rbac.middleware");
const {
  getTransaction,
  listTransactions,
  transitionPayment,
  getPaymentStats,
  flagTransaction,
  healthCheck,
} = require("./payments.controller");

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

router.get("/stats", requireSection("finance", "payments", "VIEW"), getPaymentStats);
router.get("/", requireSection("finance", "payments", "VIEW"), listTransactions);
router.get("/:id", requireSection("finance", "payments", "VIEW"), getTransaction);
router.patch("/:id/status", requireSection("finance", "payments", "EDIT"), transitionPayment);
router.post("/:id/flag", requireSection("finance", "payments", "EDIT"), flagTransaction);

module.exports = router;