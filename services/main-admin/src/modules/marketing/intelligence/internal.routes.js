const express = require("express");
const rateLimit = require("express-rate-limit");
const intelligenceController = require("./intelligence.controller");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many internal marketing events" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  "/funnel-events",
  limiter,
  intelligenceController.requireInternalServiceKey,
  intelligenceController.ingestInternalFunnelEvent,
);

module.exports = router;