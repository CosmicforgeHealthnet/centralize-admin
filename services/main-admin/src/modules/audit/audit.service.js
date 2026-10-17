const { prisma } = require("../../shared/config/database");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

class AuditService {
  async getMyActivityLogs(adminUserId, page = 1, limit = 50) {
    try {
      const skip = (page - 1) * limit;

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: { adminUserId },
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
          include: {
            adminUser: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        }),
        prisma.auditLog.count({ where: { adminUserId } }),
      ]);

      const formattedLogs = logs.map((log) => ({
        id: log.id,
        userId: log.adminUserId,
        userName: log.adminUser?.name || "Unknown User",
        userAvatar: log.adminUser?.avatarUrl || null,
        action: log.action,
        description: this._formatActionDescription(log),
        metadata: log.metadata,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt,
        time: this._formatRelativeTime(log.createdAt),
      }));

      return {
        logs: formattedLogs,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error("Get activity logs error:", error);
      throw new ApiError(500, "Failed to fetch activity logs");
    }
  }

  async getAllActivityLogs(adminUserId, userTier, page = 1, limit = 50) {
    if (userTier !== "SUPER" && userTier !== "EXECUTIVE") {
      throw new ApiError(
        403,
        "You do not have permission to view all activity logs",
      );
    }

    try {
      const skip = (page - 1) * limit;

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
          include: {
            adminUser: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        }),
        prisma.auditLog.count(),
      ]);

      const formattedLogs = logs.map((log) => ({
        id: log.id,
        userId: log.adminUserId,
        userName: log.adminUser?.name || "Unknown User",
        userAvatar: log.adminUser?.avatarUrl || null,
        action: log.action,
        description: this._formatActionDescription(log),
        metadata: log.metadata,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt,
        time: this._formatRelativeTime(log.createdAt),
      }));

      return {
        logs: formattedLogs,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error("Get all activity logs error:", error);
      throw new ApiError(500, "Failed to fetch activity logs");
    }
  }

  _formatActionDescription(log) {
    const actionMap = {
      LOGIN: "logged in",
      LOGOUT: "logged out",
      LOGIN_FAILED: "failed login attempt",
      ACCOUNT_LOCKED: "account was locked",
      PASSWORD_CHANGED: "changed password",
      PASSWORD_RESET_REQUESTED: "requested password reset",
      PASSWORD_RESET_COMPLETED: "completed password reset",
      USER_CREATED: "created a new user",
      USER_UPDATED: "updated user information",
      USER_DEACTIVATED: "deactivated user account",
      USER_ACTIVATED: "activated user account",
      USER_DELETED: "deleted user account",
      TICKET_RESOLVED: "resolved a support ticket",
      TICKET_ASSIGNED: "assigned a support ticket",
      TICKET_UPDATED: "updated a support ticket",
      PAYMENT_VIEWED: "viewed payment information",
      APPOINTMENT_VIEWED: "viewed appointment information",
      TOKEN_REFRESHED: "refreshed authentication token",
      PROFILE_UPDATED: "updated profile information",
      DOCUMENT_UPLOADED: "uploaded a document",
      DOCUMENT_DELETED: "deleted a document",
      AVATAR_UPDATED: "updated profile picture",
    };

    const actionText = actionMap[log.action] || log.action.toLowerCase();

    if (log.metadata && Object.keys(log.metadata).length > 0) {
      const details = JSON.stringify(log.metadata);
      return `${actionText} - ${details}`;
    }

    return actionText;
  }

  _formatRelativeTime(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
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
      year: "numeric",
    });
  }
}

module.exports = new AuditService();
