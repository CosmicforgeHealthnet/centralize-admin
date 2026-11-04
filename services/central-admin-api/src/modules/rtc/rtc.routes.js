const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { mainDbBoundary } = require("../../shared/middlewares/dependency-boundary.middleware");
const {
  requireTier,
  requireSection,
  requireTierOrDepartment,
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
// Admin tier as before, or an employee whose department defaults include
// this module; each route below still checks its section.
router.use(requireTierOrDepartment("ADMIN", "rtc"));
router.use(limiter);

router.get(
  "/stats",
  requireSection("rtc", "sessions", "VIEW"), mainDbBoundary.gate,
  getSessionStats,
);
router.get("/", requireSection("rtc", "sessions", "VIEW"), mainDbBoundary.gate, listSessions);
router.get("/:id", requireSection("rtc", "sessions", "VIEW"), mainDbBoundary.gate, getSession);
router.patch(
  "/:id/status",
  requireSection("rtc", "sessions", "EDIT"),
  mainDbBoundary.gate,
  transitionSession,
);

router.use(mainDbBoundary.handleError);

module.exports = router;
