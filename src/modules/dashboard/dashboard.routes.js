const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
  getOverview,
  getRevenueChart,
  getPlatformUsageChart,
} = require("./dashboard.controller");

// Dashboard is expensive — stricter limiter
const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { success: false, message: "Too many dashboard requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(requireTier("ADMIN")); // ADMIN, EXECUTIVE, SUPER only
router.use(dashboardLimiter);

router.get("/overview", getOverview);
router.get("/revenue-chart", getRevenueChart);
router.get("/platform-usage", getPlatformUsageChart);

module.exports = router;
