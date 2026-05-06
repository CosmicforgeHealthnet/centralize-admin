const notificationsService = require("./notifications-service.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

const getNotificationsForUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { page, limit } = req.query;
  const data = await notificationsService.getNotificationsForUser(userId, {
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Notifications retrieved", data);
});

const getNotificationStats = asyncHandler(async (req, res) => {
  const data = await notificationsService.getNotificationStats();
  return ApiResponse.success(res, 200, "Notification stats retrieved", data);
});

module.exports = { getNotificationsForUser, getNotificationStats };
