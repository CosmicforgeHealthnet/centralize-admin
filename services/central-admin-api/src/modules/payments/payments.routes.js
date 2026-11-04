const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier, requireSection, requireTierOrDepartment, requireRecentMfaBelowTier } = require("../../shared/middlewares/rbac.middleware");
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
// Admin tier as before, or an employee whose department defaults include
// this module; each route below still checks its section.
router.use(requireTierOrDepartment("ADMIN", "finance"));
router.use(limiter);

router.get("/stats", requireSection("finance", "payments", "VIEW"), getPaymentStats);
router.get("/", requireSection("finance", "payments", "VIEW"), listTransactions);
router.get("/:id", requireSection("finance", "payments", "VIEW"), getTransaction);
// Status changes are a sensitive transaction: department leaders (below the
// Admin tier) must also have a recent MFA confirmation.
router.patch("/:id/status", requireSection("finance", "payment-status", "EDIT"), requireRecentMfaBelowTier("ADMIN"), transitionPayment);
router.post("/:id/flag", requireSection("finance", "payments", "EDIT"), flagTransaction);

module.exports = router;