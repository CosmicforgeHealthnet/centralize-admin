const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
  trackEvent,
  listEvents,
  getStats,
  getVisitors,
  getWaitlist,
} = require("./analytics.controller");

// Public — landing page hits this heavily
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { success: false, message: "Too many tracking requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin reads — less frequent
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: "Too many analytics requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Public ────────────────────────────────────────────────────────────────
router.post("/events", trackingLimiter, trackEvent);

// ── Admin only ────────────────────────────────────────────────────────────
router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(adminLimiter);

router.get("/events", listEvents);
router.get("/stats", getStats);
router.get("/visitors", getVisitors);
router.get("/waitlist", getWaitlist);

module.exports = router;
