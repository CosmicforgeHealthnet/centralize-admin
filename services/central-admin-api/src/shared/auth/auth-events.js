"use strict";

// Writes HQ session/MFA security events to admin_auth_events (a new table, so
// no AuditAction enum values are needed). Only called once the schema is
// ready. Never throws: a logging failure must not block authentication.
function createAuthEvents({ client, logger = null }) {
  return async function record({ adminUserId = null, action, targetType = null, targetId = null, metadata = null, req = null }) {
    try {
      await client.adminAuthEvent.create({
        data: {
          adminUserId,
          action: String(action).slice(0, 64),
          targetType,
          targetId: targetId ? String(targetId).slice(0, 128) : null,
          metadata: metadata ?? undefined,
          ipAddress: req?.ip ? String(req.ip).slice(0, 64) : null,
          userAgent: req?.headers?.["user-agent"] ? String(req.headers["user-agent"]).slice(0, 512) : null,
        },
      });
    } catch (error) {
      logger?.error?.("Failed to write auth event:", error?.message);
    }
  };
}

module.exports = { createAuthEvents };
