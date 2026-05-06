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
  updateUserStatus,
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

router.get("/stats", getStats);
router.get("/growth-chart", getGrowthChart);
router.get("/signup-trends", getSignUpTrends);
router.get("/", listUsers);
router.get("/:id", getUser);
router.patch("/:id/status", updateUserStatus);

module.exports = router;
