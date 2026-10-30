"use strict";

// Uses the existing HQ Notification table. Notifications never include
// message bodies; only the mailbox name and a short sender/state label.

//
// Mail notification preference (spec 15 "Profiles", migration 36): a staff
// member who turns Mail notifications off stops receiving NEW-MAIL notices
// only (callers pass `kind: "NEW_MAIL"`: inbound delivery, internal delivery,
// internal forwarding copies). Every other notice is never suppressed, because
// missing it can hide data loss, a failed send or an access change: delivery
// failed / outcome unknown, bounces and spam complaints, mailbox full,
// forwarding approved/rejected, membership added, request decisions,
// assignments and mentions, ops and integration alerts. Before migration 36
// (or if the preference read fails) nobody is suppressed.
const SUPPRESSIBLE_KINDS = new Set(["NEW_MAIL"]);

function createMailNotifications({ client, logger, preferencesReady = null }) {
  async function withoutMuted(ids, tx) {
    if (!preferencesReady || !(await preferencesReady())) return ids;
    try {
      const muted = await tx.mailUserPreference.findMany({ where: { adminUserId: { in: ids }, notificationsEnabled: false }, select: { adminUserId: true } });
      const set = new Set(muted.map((row) => row.adminUserId));
      return ids.filter((id) => !set.has(id));
    } catch (error) {
      logger?.warn?.(`[Mail] notification preference read failed: ${error.code || "error"}`);
      return ids;
    }
  }

  async function notifyUsers(adminUserIds, { icon = "bell", title, subtitle = "", kind = "ALERT" }, tx = client) {
    let unique = [...new Set(adminUserIds.filter(Boolean))].slice(0, 200);
    if (unique.length && SUPPRESSIBLE_KINDS.has(kind)) unique = await withoutMuted(unique, tx);
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

module.exports = { createMailNotifications, SUPPRESSIBLE_KINDS };
