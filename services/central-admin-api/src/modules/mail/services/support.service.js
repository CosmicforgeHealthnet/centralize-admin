"use strict";

// Shared-mailbox workflows used by Help & Support (and any shared team inbox).
// Built entirely on Mail records; existing Support tickets/chat are untouched.
// Ticket links are stored as references only, so the shared inbox keeps
// working when product ticket services or the HealthNet Main DB are down.

const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { iso } = require("./serializers");

const STATUSES = new Set(["OPEN", "PENDING", "RESOLVED", "CLOSED"]);
const LOCK_MS = 2 * 60 * 1000;

const NOTE_PURPOSE = "mail-internal-note";

function createSupportService({ client, mailboxService, audit, notifications, encryption, clock = () => new Date() }) {
  // Internal notes can quote customer mail, so they are encrypted at rest.
  function encryptNote(text) {
    if (!encryption?.available) throw mailError("MAIL_STORAGE_UNAVAILABLE");
    return encryption.encrypt(Buffer.from(text, "utf8"), NOTE_PURPOSE);
  }
  function decryptNote(envelope) {
    try {
      return encryption.decrypt(envelope, NOTE_PURPOSE).toString("utf8");
    } catch {
      return null;
    }
  }

  async function requireShared(user, threadId, capability = "TRIAGE") {
    const access = await policy.requireThreadAccess(client, user, threadId, capability);
    if (access.mailbox.type !== "SHARED") throw mailError("MAIL_INVALID_TRANSITION", { reason: "SHARED_MAILBOX_ONLY" });
    return access;
  }

  async function supportMailboxes(user) {
    const entries = await mailboxService.accessibleMailboxes(user);
    const output = [];
    for (const entry of entries.filter((item) => item.mailbox.type === "SHARED" && item.mailbox.purpose === "SUPPORT" && !item.breakGlass)) {
      const open = await client.mailThread.count({ where: { mailboxId: entry.mailbox.id, deletedAt: null, conversationStatus: "OPEN" } });
      const overdue = await client.mailThread.count({ where: { mailboxId: entry.mailbox.id, deletedAt: null, conversationStatus: { in: ["OPEN", "PENDING"] }, firstResponseAt: null, slaDueAt: { lt: clock() } } });
      output.push({
        id: entry.mailbox.id,
        name: entry.mailbox.name,
        role: entry.role,
        canSend: entry.canSend,
        primaryAddress: await mailboxService.primaryAddressFor(entry.mailbox),
        signatureHtml: entry.mailbox.signatureHtml,
        slaFirstResponseMinutes: entry.mailbox.slaFirstResponseMinutes,
        supportTicketLinkEnabled: entry.mailbox.supportTicketLinkEnabled,
        openCount: open,
        overdueCount: overdue,
        organization: entry.mailbox.organization ? { id: entry.mailbox.organization.id, slug: entry.mailbox.organization.slug, name: entry.mailbox.organization.name } : null,
      });
    }
    return output;
  }

  async function queue(user, mailboxId, { status, assignee, cursor, limit } = {}) {
    const access = await policy.requireMailboxAccess(client, user, mailboxId, "READ");
    if (access.mailbox.type !== "SHARED") throw mailError("MAIL_INVALID_TRANSITION", { reason: "SHARED_MAILBOX_ONLY" });
    if (status && !STATUSES.has(status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
    const where = { mailboxId, folder: { notIn: ["TRASH", "SPAM"] }, hasInbound: true };
    if (status) where.conversationStatus = status;
    if (assignee === "me") where.assignedToAdminUserId = user.id;
    else if (assignee === "unassigned") where.assignedToAdminUserId = null;
    else if (assignee) where.assignedToAdminUserId = String(assignee);
    return mailboxService.listThreadsWhere(user, where, { cursor, limit });
  }

  async function assign(user, threadId, { assigneeAdminUserId }, context) {
    const { thread, mailbox } = await requireShared(user, threadId);
    let assignee = null;
    if (assigneeAdminUserId) {
      const membership = await client.mailMembership.findFirst({ where: { mailboxId: mailbox.id, adminUserId: String(assigneeAdminUserId), revokedAt: null, role: { not: "READER" }, adminUser: { status: "ACTIVE" } }, include: { adminUser: { select: { id: true, name: true } } } });
      if (!membership) throw mailError("MAIL_VALIDATION_FAILED", { field: "assigneeAdminUserId", reason: "MAILBOX_MEMBER_REQUIRED" });
      assignee = membership.adminUser;
    }
    const updated = await client.mailThread.update({ where: { id: thread.id }, data: { assignedToAdminUserId: assignee?.id || null, assignedAt: assignee ? clock() : null, revision: { increment: 1 } } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_CONVERSATION_ASSIGNED", targetType: "thread", targetId: thread.id, mailboxId: mailbox.id, metadata: { from: thread.assignedToAdminUserId, to: assignee?.id || null } }, context);
    if (assignee && assignee.id !== user.id) await notifications.notifyUsers([assignee.id], { icon: "bell", title: `Conversation assigned to you in ${mailbox.name}`, subtitle: "" });
    return { id: updated.id, assignedTo: assignee, revision: updated.revision };
  }

  async function setStatus(user, threadId, { status, revision }, context) {
    if (!STATUSES.has(status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
    const { thread, mailbox } = await requireShared(user, threadId);
    const result = await client.mailThread.updateMany({ where: { id: thread.id, revision: Number(revision) }, data: { conversationStatus: status, revision: { increment: 1 } } });
    if (result.count !== 1) {
      const current = await client.mailThread.findUnique({ where: { id: thread.id }, select: { revision: true, conversationStatus: true } });
      throw mailError("MAIL_INVALID_TRANSITION", { reason: "STALE_REVISION", currentRevision: current.revision, currentStatus: current.conversationStatus });
    }
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_CONVERSATION_STATUS_CHANGED", targetType: "thread", targetId: thread.id, mailboxId: mailbox.id, metadata: { from: thread.conversationStatus, to: status } }, context);
    const updated = await client.mailThread.findUnique({ where: { id: thread.id } });
    return { id: updated.id, conversationStatus: updated.conversationStatus, revision: updated.revision };
  }

  async function lock(user, threadId, context) {
    const { thread, mailbox } = await requireShared(user, threadId);
    const now = clock();
    const result = await client.mailThread.updateMany({
      where: { id: thread.id, OR: [{ lockedByAdminUserId: null }, { lockExpiresAt: { lt: now } }, { lockedByAdminUserId: user.id }] },
      data: { lockedByAdminUserId: user.id, lockExpiresAt: new Date(now.getTime() + LOCK_MS) },
    });
    if (result.count !== 1) {
      const current = await client.mailThread.findUnique({ where: { id: thread.id } });
      const holder = await client.adminUser.findUnique({ where: { id: current.lockedByAdminUserId }, select: { id: true, name: true } });
      throw mailError("MAIL_CONVERSATION_LOCKED", { lockedBy: holder ? { id: holder.id, name: holder.name } : null, lockExpiresAt: iso(current.lockExpiresAt) });
    }
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_CONVERSATION_LOCKED", targetType: "thread", targetId: thread.id, mailboxId: mailbox.id }, context);
    return { locked: true, lockExpiresAt: new Date(now.getTime() + LOCK_MS).toISOString() };
  }

  async function unlock(user, threadId) {
    const { thread } = await requireShared(user, threadId);
    await client.mailThread.updateMany({ where: { id: thread.id, lockedByAdminUserId: user.id }, data: { lockedByAdminUserId: null, lockExpiresAt: null } });
    return { locked: false };
  }

  async function listNotes(user, threadId) {
    await requireShared(user, threadId, "READ");
    const notes = await client.mailInternalNote.findMany({ where: { threadId, deletedAt: null }, orderBy: { createdAt: "asc" }, take: 500 });
    const authors = await client.adminUser.findMany({ where: { id: { in: [...new Set(notes.map((note) => note.authorAdminUserId))] } }, select: { id: true, name: true } });
    const byId = new Map(authors.map((author) => [author.id, author]));
    return notes.map((note) => ({ id: note.id, body: decryptNote(note.encryptedBody), contentUnavailable: decryptNote(note.encryptedBody) === null, author: byId.get(note.authorAdminUserId) || { id: note.authorAdminUserId, name: "Former staff" }, mentions: note.mentions, createdAt: iso(note.createdAt) }));
  }

  async function addNote(user, threadId, { body, mentions }, context) {
    const { thread, mailbox } = await requireShared(user, threadId);
    const text = String(body || "").trim();
    if (!text || text.length > 10000) throw mailError("MAIL_VALIDATION_FAILED", { field: "body" });
    // Mentions are limited to current members; notes are never emailed.
    const requested = [...new Set((Array.isArray(mentions) ? mentions : []).map(String))].slice(0, 20);
    const members = requested.length ? await client.mailMembership.findMany({ where: { mailboxId: mailbox.id, adminUserId: { in: requested }, revokedAt: null }, select: { adminUserId: true } }) : [];
    const valid = members.map((member) => member.adminUserId);
    const note = await client.mailInternalNote.create({ data: { threadId: thread.id, authorAdminUserId: user.id, encryptedBody: encryptNote(text), mentions: valid } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTERNAL_NOTE_ADDED", targetType: "thread", targetId: thread.id, mailboxId: mailbox.id, metadata: { mentions: valid.length } }, context);
    if (valid.length) await notifications.notifyUsers(valid.filter((id) => id !== user.id), { icon: "bell", title: `You were mentioned in ${mailbox.name}`, subtitle: "Internal note" });
    return { id: note.id, createdAt: iso(note.createdAt), mentions: valid };
  }

  async function setTicketLink(user, threadId, { ticketRef }, context) {
    const { thread, mailbox } = await requireShared(user, threadId);
    if (!mailbox.supportTicketLinkEnabled) throw mailError("MAIL_INVALID_TRANSITION", { reason: "TICKET_LINKS_DISABLED" });
    const ref = ticketRef == null ? null : String(ticketRef).trim();
    if (ref && !/^[A-Za-z0-9_:#.-]{1,128}$/.test(ref)) throw mailError("MAIL_VALIDATION_FAILED", { field: "ticketRef" });
    await client.mailThread.update({ where: { id: thread.id }, data: { supportTicketRef: ref } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_TICKET_LINK_SET", targetType: "thread", targetId: thread.id, mailboxId: mailbox.id, metadata: { ticketRef: ref } }, context);
    return { supportTicketRef: ref };
  }

  async function activity(user, threadId) {
    const { thread } = await requireShared(user, threadId, "READ");
    const events = await audit.list({ targetType: "thread", targetId: thread.id, limit: 100 });
    const actors = await client.adminUser.findMany({ where: { id: { in: [...new Set(events.map((event) => event.actorAdminUserId).filter(Boolean))] } }, select: { id: true, name: true } });
    const byId = new Map(actors.map((actor) => [actor.id, actor]));
    return events.map((event) => ({ id: event.id, action: event.action, actor: event.actorAdminUserId ? byId.get(event.actorAdminUserId) || { id: event.actorAdminUserId, name: "Former staff" } : null, metadata: event.metadata, createdAt: iso(event.createdAt) }));
  }

  return { supportMailboxes, queue, assign, setStatus, lock, unlock, listNotes, addNote, setTicketLink, activity };
}

module.exports = { createSupportService };
