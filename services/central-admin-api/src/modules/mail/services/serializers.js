"use strict";

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([iso(row.lastMessageAt || row.createdAt || row.updatedAt), row.id])).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { at: date, id };
  } catch {
    return null;
  }
}

function pageLimit(value, fallback = 25, max = 100) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function serializeThread(thread, { userState, labels = [], assignee = null, locker = null, hasAttachments = false, lastDeliveryStatus = null } = {}) {
  return {
    id: thread.id,
    mailboxId: thread.mailboxId,
    subject: thread.subject,
    snippet: thread.snippet,
    folder: thread.folder,
    lastMessageAt: iso(thread.lastMessageAt),
    messageCount: thread.messageCount,
    participants: Array.isArray(thread.participants) ? thread.participants : [],
    isRead: userState ? userState.isRead : !thread.hasInbound,
    isStarred: Boolean(userState?.isStarred),
    hasAttachments,
    labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    conversationStatus: thread.conversationStatus,
    assignedTo: assignee ? { id: assignee.id, name: assignee.name } : null,
    slaDueAt: iso(thread.slaDueAt),
    firstResponseAt: iso(thread.firstResponseAt),
    lockedBy: thread.lockedByAdminUserId && thread.lockExpiresAt && new Date(thread.lockExpiresAt) > new Date() ? locker || { id: thread.lockedByAdminUserId, name: "Teammate" } : null,
    lockExpiresAt: thread.lockedByAdminUserId && thread.lockExpiresAt && new Date(thread.lockExpiresAt) > new Date() ? iso(thread.lockExpiresAt) : null,
    supportTicketRef: thread.supportTicketRef,
    revision: thread.revision,
    lastDeliveryStatus,
  };
}

function serializeAttachment(attachment) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    isInline: attachment.isInline,
    scanStatus: attachment.scanStatus,
    downloadable: attachment.scanStatus === "CLEAN" && !attachment.quarantined && Boolean(attachment.storageKey),
  };
}

function serializeRecipients(message, { includeBcc }) {
  return message.recipients
    .filter((recipient) => includeBcc || recipient.type !== "BCC")
    .map((recipient) => ({ type: recipient.type, address: recipient.address, name: recipient.name, status: recipient.status }));
}

function serializeMailbox(mailbox, { role, canSend, unreadCount = 0, primaryAddress = null }) {
  return {
    id: mailbox.id,
    name: mailbox.name,
    type: mailbox.type,
    purpose: mailbox.purpose,
    role,
    canSend,
    primaryAddress,
    unreadCount,
    status: mailbox.status,
    organization: mailbox.organization ? { id: mailbox.organization.id, slug: mailbox.organization.slug, name: mailbox.organization.name } : null,
  };
}

module.exports = { iso, encodeCursor, decodeCursor, pageLimit, serializeThread, serializeAttachment, serializeRecipients, serializeMailbox };
