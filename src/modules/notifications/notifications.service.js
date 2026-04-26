const { prisma } = require("../../shared/config/database");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

class NotificationService {
  async getMyNotifications(adminUserId) {
    try {
      const notifications = await prisma.notification.findMany({
        where: { adminUserId },
        orderBy: { createdAt: "desc" },
      });

      return notifications.map((notif) => ({
        id: notif.id,
        icon: notif.icon,
        title: notif.title,
        subtitle: notif.subtitle || "",
        time: this._formatRelativeTime(notif.createdAt),
        unread: !notif.isRead,
        bold: !notif.isRead,
      }));
    } catch (error) {
      logger.error("Get notifications error:", error);
      throw new ApiError(500, "Failed to fetch notifications");
    }
  }

  async getUnreadCount(adminUserId) {
    try {
      const count = await prisma.notification.count({
        where: { adminUserId, isRead: false },
      });
      return { unreadCount: count };
    } catch (error) {
      logger.error("Get unread count error:", error);
      throw new ApiError(500, "Failed to fetch unread count");
    }
  }

  async markAsRead(adminUserId, notificationId) {
    try {
      const notification = await prisma.notification.findFirst({
        where: { id: notificationId, adminUserId },
      });

      if (!notification) {
        throw new ApiError(404, "Notification not found");
      }

      if (notification.isRead) {
        return { id: notificationId, isRead: true };
      }

      const updated = await prisma.notification.update({
        where: { id: notificationId },
        data: { isRead: true },
        select: { id: true, isRead: true },
      });

      return updated;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error("Mark as read error:", error);
      throw new ApiError(500, "Failed to mark notification as read");
    }
  }

  async markAllAsRead(adminUserId) {
    try {
      const result = await prisma.notification.updateMany({
        where: { adminUserId, isRead: false },
        data: { isRead: true },
      });

      return {
        message: "All notifications marked as read",
        count: result.count,
      };
    } catch (error) {
      logger.error("Mark all as read error:", error);
      throw new ApiError(500, "Failed to mark all notifications as read");
    }
  }

  async createNotification({ adminUserId, icon, title, subtitle = "" }) {
    try {
      const notification = await prisma.notification.create({
        data: {
          adminUserId,
          icon,
          title,
          subtitle,
          isRead: false,
        },
      });

      logger.info(`Notification created for user ${adminUserId}: ${title}`);
      return notification;
    } catch (error) {
      logger.error("Create notification error:", error);
      return null;
    }
  }

  async deleteNotification(adminUserId, notificationId) {
    try {
      const notification = await prisma.notification.findFirst({
        where: { id: notificationId, adminUserId },
      });

      if (!notification) {
        throw new ApiError(404, "Notification not found");
      }

      await prisma.notification.delete({
        where: { id: notificationId },
      });

      return { message: "Notification deleted successfully" };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logger.error("Delete notification error:", error);
      throw new ApiError(500, "Failed to delete notification");
    }
  }

  _formatRelativeTime(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60)
      return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;

    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
}

module.exports = new NotificationService();
