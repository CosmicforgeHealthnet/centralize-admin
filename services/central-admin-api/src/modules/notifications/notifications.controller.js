const asyncHandler = require("../../shared/utils/asyncHandler");
const ApiResponse = require("../../shared/utils/ApiResponse");
const notificationService = require("./notifications.service");

class NotificationController {
  getMyNotifications = asyncHandler(async (req, res) => {
    const notifications = await notificationService.getMyNotifications(
      req.adminUser.id,
    );
    return ApiResponse.success(
      res,
      200,
      "Notifications retrieved successfully",
      notifications,
    );
  });

  getUnreadCount = asyncHandler(async (req, res) => {
    const result = await notificationService.getUnreadCount(req.adminUser.id);
    return ApiResponse.success(
      res,
      200,
      "Unread count retrieved successfully",
      result,
    );
  });

  markAsRead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await notificationService.markAsRead(req.adminUser.id, id);
    return ApiResponse.success(res, 200, "Notification marked as read", result);
  });

  markAllAsRead = asyncHandler(async (req, res) => {
    const result = await notificationService.markAllAsRead(req.adminUser.id);
    return ApiResponse.success(res, 200, result.message, {
      count: result.count,
    });
  });

  deleteNotification = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await notificationService.deleteNotification(
      req.adminUser.id,
      id,
    );
    return ApiResponse.success(
      res,
      200,
      "Notification deleted successfully",
      result,
    );
  });
}

module.exports = new NotificationController();
