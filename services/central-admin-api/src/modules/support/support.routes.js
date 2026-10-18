const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
} = require("../../shared/middlewares/rbac.middleware");
const {
  getStats,
  getMergedTickets,
  getStaffActivity,
  getUserTraffic,
  getSupportChats,
  getChatMessages,
  claimChat,
  sendChatMessage,
} = require("./support.controller");

const supportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(supportLimiter);

router.get("/stats", requireSection("support", "tickets", "VIEW"), getStats);
router.get(
  "/tickets",
  requireSection("support", "tickets", "VIEW"),
  getMergedTickets,
);
// router.get("/staff-activity", getStaffActivity);
router.get(
  "/user-traffic",
  requireSection("support", "tickets", "VIEW"),
  getUserTraffic,
);
router.get(
  "/chats",
  requireSection("support", "chats", "VIEW"),
  getSupportChats,
);
router.get(
  "/chats/:roomId/messages",
  requireSection("support", "chats", "VIEW"),
  getChatMessages,
);
router.post(
  "/chats/:roomId/claim",
  requireSection("support", "chats", "EDIT"),
  claimChat,
);
router.post(
  "/chats/:roomId/messages",
  requireSection("support", "chats", "EDIT"),
  sendChatMessage,
);

module.exports = router;
