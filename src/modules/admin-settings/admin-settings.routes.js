const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
  getAllSettings,
  getSettingsByCategory,
  getSetting,
  upsertSetting,
  batchUpdateSettings,
  getSettingHistory,
  getAllHistory,
} = require("./admin-settings.controller");

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// All routes require authentication and admin access
router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(limiter);

// Get all settings (grouped by category)
router.get("/all", getAllSettings);

// Get audit history
router.get("/history", getAllHistory);

// Get history for specific setting
router.get("/history/:settingId", getSettingHistory);

// Get settings by category (e.g., /security, /notification, /behavior, /limits, /localization)
router.get("/category/:category", getSettingsByCategory);

// Batch update multiple settings
router.put("/batch", batchUpdateSettings);

// Get or update a specific setting
router.route("/:category/:key").get(getSetting).put(upsertSetting);

module.exports = router;
