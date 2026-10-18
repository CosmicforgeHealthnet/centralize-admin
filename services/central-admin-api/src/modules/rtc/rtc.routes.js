const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
} = require("../../shared/middlewares/rbac.middleware");
const {
  getSession,
  listSessions,
  transitionSession,
  getSessionStats,
} = require("./rtc.controller");

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

router.get(
  "/stats",
  requireSection("rtc", "sessions", "VIEW"),
  getSessionStats,
);
router.get("/", requireSection("rtc", "sessions", "VIEW"), listSessions);
router.get("/:id", requireSection("rtc", "sessions", "VIEW"), getSession);
router.patch(
  "/:id/status",
  requireSection("rtc", "sessions", "EDIT"),
  transitionSession,
);

module.exports = router;
