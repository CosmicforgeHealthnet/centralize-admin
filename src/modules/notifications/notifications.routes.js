const express = require("express");
const router = express.Router();
const notificationController = require("./notifications.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  validate,
  notificationIdParamSchema,
} = require("./notifications.validator");

router.use(authenticate);

router.get("/", notificationController.getMyNotifications);
router.get("/unread-count", notificationController.getUnreadCount);
router.patch("/mark-all-read", notificationController.markAllAsRead);
router.patch(
  "/:id/read",
  validate(notificationIdParamSchema, "params"),
  notificationController.markAsRead,
);
router.delete(
  "/:id",
  validate(notificationIdParamSchema, "params"),
  notificationController.deleteNotification,
);

module.exports = router;
