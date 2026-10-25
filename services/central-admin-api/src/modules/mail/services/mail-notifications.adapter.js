"use strict";

// Uses the existing HQ Notification table. Notifications never include
// message bodies; only the mailbox name and a short sender/state label.

function createMailNotifications({ client, logger }) {
  async function notifyUsers(adminUserIds, { icon = "bell", title, subtitle = "" }, tx = client) {
    const unique = [...new Set(adminUserIds.filter(Boolean))].slice(0, 200);
    if (!unique.length) return 0;
    try {
      const result = await tx.notification.createMany({
        data: unique.map((adminUserId) => ({ adminUserId, icon, title: String(title).slice(0, 160), subtitle: String(subtitle).slice(0, 200), isRead: false })),
      });
      return result.count;
    } catch (error) {
      // Notification delivery is best effort and never blocks mail persistence.
      logger?.warn?.(`[Mail] notification write failed: ${error.code || "error"}`);
      return 0;
    }
  }

  async function mailboxMemberIds(mailboxId, now = new Date(), tx = client) {
    const members = await tx.mailMembership.findMany({
      where: { mailboxId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], adminUser: { status: "ACTIVE" } },
      select: { adminUserId: true },
    });
    return members.map((member) => member.adminUserId);
  }

  return { notifyUsers, mailboxMemberIds };
}

module.exports = { createMailNotifications };
