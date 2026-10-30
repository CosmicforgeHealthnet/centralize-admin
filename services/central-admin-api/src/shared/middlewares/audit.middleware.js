const { prisma } = require("../config/database");
const logger = require("../utils/logger");

// Call this to manually log an audit event
const createAuditLog = async ({
  adminUserId,
  action,
  targetId,
  targetType,
  metadata,
  req,
}) => {
  try {
    await prisma.auditLog.create({
      data: {
        adminUserId: adminUserId || null,
        action,
        targetId: targetId || null,
        targetType: targetType || null,
        metadata: metadata || null,
        ipAddress: req?.ip || null,
        userAgent: req?.headers?.["user-agent"] || null,
      },
    });
  } catch (error) {
    // Never let audit logging crash the app
    logger.error("Failed to write audit log:", error.message);
  }
};

module.exports = { createAuditLog };
