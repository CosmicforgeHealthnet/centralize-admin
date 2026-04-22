const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
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

router.get("/stats", getStats);
router.get("/tickets", getMergedTickets);
// router.get("/staff-activity", getStaffActivity);
router.get("/user-traffic", getUserTraffic);
router.get("/chats", getSupportChats);
router.get("/chats/:roomId/messages", getChatMessages);
router.post("/chats/:roomId/claim", claimChat);
router.post("/chats/:roomId/messages", sendChatMessage);

module.exports = router;
