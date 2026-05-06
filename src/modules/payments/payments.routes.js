const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
  getTransaction,
  listTransactions,
  transitionPayment,
  getPaymentStats,
  flagTransaction,
} = require("./payments.controller");

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

router.get("/stats", getPaymentStats);
router.get("/", listTransactions);
router.get("/:id", getTransaction);
router.patch("/:id/status", transitionPayment);
router.post("/:id/flag", flagTransaction);

module.exports = router;
