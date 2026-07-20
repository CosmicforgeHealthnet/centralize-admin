const { prisma } = require("../../../../shared/config/database");
const notificationService = require("../../../notifications/notifications.service");
const { emitAdminNotification } = require("../../../../websocket");
const { sanitizeProviderText } = require("../connectors/provider-http");

function createAlertNotificationAdapter({ prisma: db = prisma, notifications = notificationService, realtime = emitAdminNotification } = {}) {
  async function activeUsers(where) {
    if (!db.adminUser?.findMany) return [];
    return db.adminUser.findMany({ where: { status: "ACTIVE", ...where }, select: { id: true } });
  }

  async function resolveRecipients(settings, now = new Date()) {
    const explicitIds = [...new Set(settings.alertRecipientAdminUserIds || [])];
    if (explicitIds.length) {
      const explicit = await activeUsers({ id: { in: explicitIds } });
      if (explicit.length) return explicit.map((user) => user.id);
    }
    if (settings.alertRecipientDepartment) {
      const department = await activeUsers({ department: settings.alertRecipientDepartment });
      if (department.length) return department.map((user) => user.id);
    }
    const access = await activeUsers({ OR: [
      { tier: "SUPER" },
      { sectionGrants: { some: { module: "marketing", section: { in: ["intelligence", "*"] }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } } },
    ] });
    return [...new Set(access.map((user) => user.id))];
  }

  function payload(alert) {
    return {
      type: alert.type, severity: alert.severity, title: `Marketing alert: ${alert.type}`,
      message: sanitizeProviderText(alert.message).slice(0, 500), marketingAlertId: alert.id,
      platform: alert.platform || null, connectionId: alert.connectionId || null,
      campaignExternalId: alert.campaignExternalId || null, creativeAssetId: alert.creativeAssetId || null,
      route: `/marketing/intelligence/alerts/${alert.id}`, triggeredAt: alert.triggeredAt,
    };
  }

  async function deliver(alert, settings) {
    const recipients = await resolveRecipients(settings);
    if (!recipients.length) return { recipients: [], notifications: [], realtimeFailures: [], reason: "NO_VALID_RECIPIENT" };
    const safePayload = payload(alert);
    const created = [];
    const persistenceFailures = [];
    for (const adminUserId of recipients) {
      try {
        const notification = await notifications.createNotification({ adminUserId, icon: alert.severity === "CRITICAL" ? "alert" : "bell", title: safePayload.title, subtitle: safePayload.message });
        if (notification) created.push({ adminUserId, notification });
        else persistenceFailures.push("Notification persistence returned no record");
      } catch (error) {
        persistenceFailures.push(sanitizeProviderText(error.message || "Notification persistence failed").slice(0, 500));
      }
    }
    const realtimeFailures = [];
    for (const item of created) {
      try { realtime(item.adminUserId, safePayload); }
      catch (error) { realtimeFailures.push(sanitizeProviderText(error.message || "Realtime delivery failed").slice(0, 500)); }
    }
    return { recipients, notifications: created.map((item) => item.notification), persistenceFailures, realtimeFailures };
  }

  return { resolveRecipients, deliver, payload };
}

module.exports = { createAlertNotificationAdapter };
