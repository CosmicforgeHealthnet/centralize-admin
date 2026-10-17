const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
  getStats,
  getGrowthChart,
  getSignUpTrends,
  listUsers,
  getUser,
  getUserActivity,
  getUserTransactions,
  getUserAppointments,
  getUserSubscriptions,
  updateUserStatus,
  bulkUpdateStatus,
  deleteUser,
  forcePasswordReset,
} = require("./users.controller");

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

// ── Analytics ──────────────────────────────────────────────────────────────
router.get("/stats", getStats);
router.get("/growth-chart", getGrowthChart);
router.get("/signup-trends", getSignUpTrends);

// ── Bulk operations (must come before /:id to avoid route conflicts) ────────
router.patch("/bulk/status", bulkUpdateStatus);

// ── User list ──────────────────────────────────────────────────────────────
router.get("/", listUsers);

// ── Single user ────────────────────────────────────────────────────────────
router.get("/:id", getUser);
router.get("/:id/activity", getUserActivity);
router.get("/:id/transactions", getUserTransactions);
router.get("/:id/appointments", getUserAppointments);
router.get("/:id/subscriptions", getUserSubscriptions);
router.patch("/:id/status", updateUserStatus);
router.patch("/:id/force-password-reset", forcePasswordReset);
router.delete("/:id", deleteUser);

module.exports = router;
