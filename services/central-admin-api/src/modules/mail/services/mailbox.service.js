"use strict";

// Mailbox, thread and message read/triage operations. Every query is scoped by
// the caller's resolved mailbox access; nothing is filtered client side.

const { Prisma } = require("../../../generated/admin-client");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { sanitizeEmailHtml } = require("../security/html-sanitizer");
const { publicSenderAuthentication } = require("../security/sender-auth");
const { decodeCursor, encodeCursor, pageLimit, serializeThread, serializeAttachment, serializeRecipients, serializeMailbox, iso } = require("./serializers");

const VIEWS = {
  inbox: () => ({ folder: "INBOX", hasInbound: true }),
  unread: (userId) => ({ folder: "INBOX", hasInbound: true, NOT: { userStates: { some: { adminUserId: userId, isRead: true } } } }),
  sent: () => ({ hasOutbound: true, folder: { notIn: ["TRASH", "SPAM"] } }),
  archive: () => ({ folder: "ARCHIVE" }),
  trash: () => ({ folder: "TRASH" }),
  spam: () => ({ folder: "SPAM" }),
  starred: (userId) => ({ folder: { not: "TRASH" }, userStates: { some: { adminUserId: userId, isStarred: true } } }),
  all: () => ({ folder: { notIn: ["TRASH", "SPAM"] } }),
};
const FOLDERS = new Set(["INBOX", "ARCHIVE", "TRASH", "SPAM"]);

function createMailboxService({ client, config, store, audit, searchIndex = null }) {
  async function accessibleMailboxes(user, now = new Date()) {
    policy.assertActiveIdentity(user);
    const memberships = await client.mailMembership.findMany({
      where: { adminUserId: user.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], mailbox: { status: "ACTIVE" } },
      include: { mailbox: { include: { organization: true } } },
    });
    const breakGlass = await client.mailBreakGlassRequest.findMany({
      where: { requesterAdminUserId: user.id, status: "APPROVED", revokedAt: null, accessExpiresAt: { gt: now } },
      include: { mailbox: { include: { organization: true } } },
    });
    const entries = new Map();
    for (const membership of memberships) entries.set(membership.mailboxId, { mailbox: membership.mailbox, role: membership.role, canSend: membership.canSend && membership.role !== "READER" });
    for (const grant of breakGlass) if (!entries.has(grant.mailboxId)) entries.set(grant.mailboxId, { mailbox: grant.mailbox, role: "READER", canSend: false, breakGlass: true });
    return [...entries.values()];
  }

  async function unreadCount(user, mailboxId) {
    return client.mailThread.count({ where: { mailboxId, deletedAt: null, ...VIEWS.unread(user.id) } });
  }

  async function primaryAddressFor(mailbox) {
    const address = await client.mailAddress.findFirst({
      where: { mailboxId: mailbox.id, status: "ACTIVE", kind: { in: mailbox.type === "PERSONAL" ? ["PRIMARY"] : ["SHARED"] } },
      orderBy: { createdAt: "asc" },
    });
    return address?.address || null;
  }

  async function listMyMailboxes(user) {
    const entries = await accessibleMailboxes(user);
    const output = [];
    for (const entry of entries) {
      output.push(serializeMailbox(entry.mailbox, { role: entry.role, canSend: entry.canSend, unreadCount: await unreadCount(user, entry.mailbox.id), primaryAddress: await primaryAddressFor(entry.mailbox) }));
    }
    return output.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "PERSONAL" ? -1 : 1));
  }

  async function getMailbox(user, mailboxId) {
    const access = await policy.requireMailboxAccess(client, user, mailboxId, "READ");
    const mailbox = await client.mailMailbox.findUnique({ where: { id: mailboxId }, include: { organization: true } });
    const identities = await policy.listSenderIdentities(client, user, access);
    return {
      ...serializeMailbox(mailbox, { role: access.role, canSend: access.canSend, unreadCount: await unreadCount(user, mailboxId), primaryAddress: await primaryAddressFor(mailbox) }),
      senderIdentities: identities.map(({ domainId, ...identity }) => identity),
      signatureHtml: mailbox.signatureHtml,
      slaFirstResponseMinutes: mailbox.slaFirstResponseMinutes,
      supportTicketLinkEnabled: mailbox.supportTicketLinkEnabled,
      viaBreakGlass: Boolean(access.viaBreakGlass),
    };
  }

  async function summarize(user, threads) {
    if (!threads.length) return [];
    const ids = threads.map((thread) => thread.id);
    const [states, labels, attachments, outbound] = await Promise.all([
      client.mailUserThreadState.findMany({ where: { threadId: { in: ids }, adminUserId: user.id } }),
      client.mailThreadLabel.findMany({ where: { threadId: { in: ids } }, include: { label: true } }),
      client.mailMessage.groupBy({ by: ["threadId"], where: { threadId: { in: ids }, hasAttachments: true, deletedAt: null }, _count: { _all: true } }),
      client.mailMessage.findMany({ where: { threadId: { in: ids }, direction: "OUTBOUND" }, orderBy: { createdAt: "desc" }, select: { threadId: true, status: true } }),
    ]);
    const assigneeIds = [...new Set(threads.flatMap((thread) => [thread.assignedToAdminUserId, thread.lockedByAdminUserId]).filter(Boolean))];
    const assignees = assigneeIds.length ? await client.adminUser.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } }) : [];
    const stateBy = new Map(states.map((state) => [state.threadId, state]));
    const labelsBy = new Map();
    for (const entry of labels) labelsBy.set(entry.threadId, [...(labelsBy.get(entry.threadId) || []), entry.label]);
    const withAttachments = new Set(attachments.map((entry) => entry.threadId));
    const lastStatus = new Map();
    for (const entry of outbound) if (!lastStatus.has(entry.threadId)) lastStatus.set(entry.threadId, entry.status);
    const assigneeBy = new Map(assignees.map((assignee) => [assignee.id, assignee]));
    return threads.map((thread) =>
      serializeThread(thread, {
        userState: stateBy.get(thread.id),
        labels: labelsBy.get(thread.id) || [],
        assignee: assigneeBy.get(thread.assignedToAdminUserId) || null,
        locker: assigneeBy.get(thread.lockedByAdminUserId) || null,
        hasAttachments: withAttachments.has(thread.id),
        lastDeliveryStatus: lastStatus.get(thread.id) || null,
        snippet: store.decryptSnippet(thread.encryptedSnippet),
      }),
    );
  }

  async function pageThreads(user, where, { cursor, limit }) {
    const take = pageLimit(limit);
    const position = decodeCursor(cursor);
    const rows = await client.mailThread.findMany({
      where: {
        AND: [
          where,
          { deletedAt: null },
          position ? { OR: [{ lastMessageAt: { lt: position.at } }, { lastMessageAt: position.at, id: { lt: position.id } }] } : {},
        ],
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return { items: await summarize(user, page), nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null };
  }

  async function listThreads(user, mailboxId, { view = "inbox", labelId, cursor, limit } = {}) {
    await policy.requireMailboxAccess(client, user, mailboxId, "READ");
    const viewFilter = VIEWS[view];
    if (!viewFilter) throw mailError("MAIL_VALIDATION_FAILED", { field: "view" });
    const where = { mailboxId, ...viewFilter(user.id), ...(labelId ? { labels: { some: { labelId: String(labelId) } } } : {}) };
    return pageThreads(user, where, { cursor, limit });
  }

  async function getThread(user, threadId) {
    const { thread } = await policy.requireThreadAccess(client, user, threadId, "READ");
    const [summary] = await summarize(user, [thread]);
    return summary;
  }

  async function getMessages(user, threadId, { remoteImages = "block" } = {}, context = {}) {
    const access = await policy.requireThreadAccess(client, user, threadId, "READ");
    const messages = await client.mailMessage.findMany({
      where: { threadId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { recipients: true, attachments: true, deliveryEvents: { orderBy: { occurredAt: "asc" } } },
      take: 200,
    });
    const senderIds = [...new Set(messages.map((message) => message.sentByAdminUserId).filter(Boolean))];
    const senders = senderIds.length ? await client.adminUser.findMany({ where: { id: { in: senderIds } }, select: { id: true, name: true } }) : [];
    const senderBy = new Map(senders.map((sender) => [sender.id, sender]));
    const output = [];
    for (const message of messages) {
      let body = { html: null, text: null };
      let contentUnavailable = false;
      try {
        body = await store.readBody(message);
      } catch {
        contentUnavailable = true;
      }
      const quarantined = message.status === "QUARANTINED";
      const sanitized = body.html ? sanitizeEmailHtml(body.html, { allowRemoteImages: remoteImages === "allow" && !quarantined }) : { html: null, remoteImagesBlocked: 0 };
      output.push({
        id: message.id,
        threadId: message.threadId,
        mailboxId: message.mailboxId,
        direction: message.direction,
        status: message.status,
        subject: message.subject,
        from: { address: message.fromAddress, name: message.fromName },
        replyTo: message.replyTo,
        // BCC is only ever shown in the sending mailbox's own outbound copy.
        recipients: serializeRecipients(message, { includeBcc: message.direction === "OUTBOUND" }),
        sentAt: iso(message.sentAt),
        receivedAt: iso(message.receivedAt),
        createdAt: iso(message.createdAt),
        html: sanitized.html,
        text: body.text,
        remoteImagesBlocked: sanitized.remoteImagesBlocked,
        contentUnavailable,
        attachments: message.attachments.map(serializeAttachment),
        sentBy: message.sentByAdminUserId ? senderBy.get(message.sentByAdminUserId) || { id: message.sentByAdminUserId, name: "Former staff" } : null,
        deliveryEvents: message.deliveryEvents.map((event) => ({ type: event.eventType, recipient: event.recipient, occurredAt: iso(event.occurredAt) })),
        quarantineReason: message.quarantineReason,
        // Provider-verified SPF/DKIM/DMARC assessment (spec 12, 19.4).
        senderAuthentication: message.direction === "INBOUND" ? publicSenderAuthentication(message.authResults) : null,
      });
    }
    // Opening a thread marks it read for this user only.
    await client.mailUserThreadState.upsert({
      where: { threadId_adminUserId: { threadId, adminUserId: user.id } },
      create: { threadId, adminUserId: user.id, isRead: true, lastReadAt: new Date() },
      update: { isRead: true, lastReadAt: new Date() },
    });
    if (access.viaBreakGlass) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_BREAK_GLASS_READ", targetType: "thread", targetId: threadId, mailboxId: access.mailbox.id, metadata: { breakGlassRequestId: access.viaBreakGlass.id, messages: messages.length } }, context);
    }
    return output;
  }

  async function setThreadState(user, threadId, { isRead, isStarred }) {
    await policy.requireThreadAccess(client, user, threadId, "READ");
    const data = {};
    if (typeof isRead === "boolean") Object.assign(data, { isRead, lastReadAt: isRead ? new Date() : undefined });
    if (typeof isStarred === "boolean") data.isStarred = isStarred;
    if (!Object.keys(data).length) throw mailError("MAIL_VALIDATION_FAILED", { field: "state" });
    const state = await client.mailUserThreadState.upsert({
      where: { threadId_adminUserId: { threadId, adminUserId: user.id } },
      create: { threadId, adminUserId: user.id, isRead: data.isRead ?? false, isStarred: data.isStarred ?? false, lastReadAt: data.lastReadAt || null },
      update: data,
    });
    return { isRead: state.isRead, isStarred: state.isStarred };
  }

  async function moveThread(user, threadId, folder, context = {}) {
    if (!FOLDERS.has(folder)) throw mailError("MAIL_VALIDATION_FAILED", { field: "folder" });
    const { thread } = await policy.requireThreadAccess(client, user, threadId, "TRIAGE");
    const updated = await client.mailThread.update({ where: { id: thread.id }, data: { folder, revision: { increment: 1 } } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_THREAD_MOVED", targetType: "thread", targetId: thread.id, mailboxId: thread.mailboxId, metadata: { from: thread.folder, to: folder } }, context);
    return { id: updated.id, folder: updated.folder };
  }

  async function bulk(user, mailboxId, { threadIds, action }, context = {}) {
    await policy.requireMailboxAccess(client, user, mailboxId, action === "read" || action === "unread" || action === "star" || action === "unstar" ? "READ" : "TRIAGE");
    const ids = [...new Set((Array.isArray(threadIds) ? threadIds : []).filter(policy.isUuid))].slice(0, 100);
    if (!ids.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "threadIds" });
    // Membership is enforced in the query: only threads of this mailbox are touched.
    const threads = await client.mailThread.findMany({ where: { id: { in: ids }, mailboxId, deletedAt: null }, select: { id: true } });
    const scoped = threads.map((thread) => thread.id);
    const folderActions = { archive: "ARCHIVE", trash: "TRASH", spam: "SPAM", inbox: "INBOX" };
    if (folderActions[action]) {
      const result = await client.mailThread.updateMany({ where: { id: { in: scoped }, mailboxId }, data: { folder: folderActions[action] } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_THREADS_BULK_MOVED", targetType: "mailbox", targetId: mailboxId, mailboxId, metadata: { action, count: result.count } }, context);
      return { updated: result.count };
    }
    const stateActions = { read: { isRead: true }, unread: { isRead: false }, star: { isStarred: true }, unstar: { isStarred: false } };
    if (!stateActions[action]) throw mailError("MAIL_VALIDATION_FAILED", { field: "action" });
    for (const threadId of scoped) {
      await client.mailUserThreadState.upsert({
        where: { threadId_adminUserId: { threadId, adminUserId: user.id } },
        create: { threadId, adminUserId: user.id, isRead: false, isStarred: false, ...stateActions[action] },
        update: stateActions[action],
      });
    }
    return { updated: scoped.length };
  }

  async function deleteThread(user, threadId, context = {}) {
    const { thread, mailbox } = await policy.requireThreadAccess(client, user, threadId, "TRIAGE");
    if (thread.folder !== "TRASH") throw mailError("MAIL_INVALID_TRANSITION", { reason: "MOVE_TO_TRASH_FIRST" });
    const hold = await client.mailLegalHold.findFirst({ where: { releasedAt: null, OR: [{ mailboxId: thread.mailboxId }, { mailboxId: null, organizationId: mailbox.organizationId }] } });
    if (hold) throw mailError("MAIL_LEGAL_HOLD");
    // Soft delete only: content stays subject to retention policy.
    await client.mailThread.update({ where: { id: thread.id }, data: { deletedAt: new Date() } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_THREAD_DELETED", targetType: "thread", targetId: thread.id, mailboxId: thread.mailboxId }, context);
    return { deleted: true };
  }

  async function listLabels(user, mailboxId) {
    await policy.requireMailboxAccess(client, user, mailboxId, "READ");
    const labels = await client.mailLabel.findMany({ where: { mailboxId }, orderBy: { name: "asc" } });
    return labels.map((label) => ({ id: label.id, name: label.name, color: label.color }));
  }

  async function createLabel(user, mailboxId, { name, color }) {
    await policy.requireMailboxAccess(client, user, mailboxId, "TRIAGE");
    const cleanName = String(name || "").trim().slice(0, 80);
    if (!cleanName) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw mailError("MAIL_VALIDATION_FAILED", { field: "color" });
    try {
      const label = await client.mailLabel.create({ data: { mailboxId, name: cleanName, color: color || null, createdBy: user.id } });
      return { id: label.id, name: label.name, color: label.color };
    } catch (error) {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "name", reason: "DUPLICATE" });
      throw error;
    }
  }

  async function setThreadLabel(user, threadId, labelId, attach) {
    const { thread } = await policy.requireThreadAccess(client, user, threadId, "TRIAGE");
    const label = policy.isUuid(labelId) ? await client.mailLabel.findFirst({ where: { id: labelId, mailboxId: thread.mailboxId } }) : null;
    if (!label) throw mailError("MAIL_NOT_FOUND", { resource: "label" });
    if (attach) await client.mailThreadLabel.upsert({ where: { threadId_labelId: { threadId, labelId } }, create: { threadId, labelId }, update: {} });
    else await client.mailThreadLabel.deleteMany({ where: { threadId, labelId } });
    return { threadId, labelId, attached: attach };
  }

  // Search (spec 5.1, 12): sender, recipient (never BCC), subject, body (keyed
  // blind index, when enabled), date and label. Mailbox membership is part of
  // the SQL. A unified search covers only mailboxes the caller is a member
  // of; a break-glass grant allows searching that one mailbox explicitly,
  // and that search is audited (never folded silently into "all mail").
  async function search(user, { mailboxId, q, from, to, subject, after, before, labelId, cursor, limit }, context = {}) {
    let mailboxIds;
    let breakGlass = null;
    if (mailboxId) {
      const access = await policy.requireMailboxAccess(client, user, mailboxId, "READ");
      breakGlass = access.viaBreakGlass || null;
      mailboxIds = [mailboxId];
    } else {
      mailboxIds = (await accessibleMailboxes(user)).filter((entry) => !entry.breakGlass).map((entry) => entry.mailbox.id);
    }
    if (!mailboxIds.length) return { items: [], nextCursor: null };
    const take = pageLimit(limit);
    const position = decodeCursor(cursor);
    const conditions = [Prisma.sql`m."mailbox_id"::text IN (${Prisma.join(mailboxIds)})`, Prisma.sql`m."deleted_at" IS NULL`, Prisma.sql`t."deleted_at" IS NULL`];
    const query = String(q || "").trim().slice(0, 200);
    const bodyTerms = query && searchIndex ? await searchIndex.queryTerms(mailboxIds, query) : null;
    if (query && bodyTerms && bodyTerms.length) {
      // Every word must appear in the metadata OR the body of the message.
      for (const entry of bodyTerms) {
        conditions.push(Prisma.sql`(to_tsvector('simple', m."metadata_search_text") @@ plainto_tsquery('simple', ${entry.word}) OR EXISTS (SELECT 1 FROM "mail_message_search_index" si WHERE si."message_id" = m."id" AND si."mailbox_id" = m."mailbox_id" AND si."terms" && ${entry.terms}::text[]))`);
      }
    } else if (query) {
      conditions.push(Prisma.sql`to_tsvector('simple', m."metadata_search_text") @@ plainto_tsquery('simple', ${query})`);
    }
    if (from) conditions.push(Prisma.sql`(m."from_address" ILIKE ${`%${String(from).slice(0, 120)}%`} OR m."from_name" ILIKE ${`%${String(from).slice(0, 120)}%`})`);
    if (subject) conditions.push(Prisma.sql`m."subject" ILIKE ${`%${String(subject).slice(0, 200)}%`}`);
    if (to) conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "mail_message_recipients" r WHERE r."message_id" = m."id" AND r."type" <> 'BCC' AND r."address" ILIKE ${`%${String(to).slice(0, 120)}%`})`);
    const afterDate = after ? new Date(after) : null;
    const beforeDate = before ? new Date(before) : null;
    if (afterDate && !Number.isNaN(afterDate.getTime())) conditions.push(Prisma.sql`m."created_at" >= ${afterDate}`);
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) conditions.push(Prisma.sql`m."created_at" < ${beforeDate}`);
    if (labelId && policy.isUuid(labelId)) conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "mail_thread_labels" l WHERE l."thread_id" = t."id" AND l."label_id" = ${labelId}::uuid)`);
    if (position) conditions.push(Prisma.sql`(t."last_message_at", t."id") < (${position.at}, ${position.id}::uuid)`);
    if (!query && !from && !to && !subject && !afterDate && !beforeDate) throw mailError("MAIL_VALIDATION_FAILED", { field: "q" });
    const rows = await client.$queryRaw(Prisma.sql`
      SELECT DISTINCT t."id", t."last_message_at"
      FROM "mail_messages" m JOIN "mail_threads" t ON t."id" = m."thread_id" AND t."mailbox_id" = m."mailbox_id"
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY t."last_message_at" DESC, t."id" DESC
      LIMIT ${take + 1}
    `);
    const page = rows.slice(0, take);
    const threads = page.length ? await client.mailThread.findMany({ where: { id: { in: page.map((row) => row.id) }, mailboxId: { in: mailboxIds } } }) : [];
    const order = new Map(page.map((row, index) => [row.id, index]));
    threads.sort((a, b) => order.get(a.id) - order.get(b.id));
    if (breakGlass) {
      // The query text is never logged; only that a search happened.
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_BREAK_GLASS_SEARCH", targetType: "mailbox", targetId: mailboxId, mailboxId, metadata: { breakGlassRequestId: breakGlass.id, results: threads.length } }, context);
    }
    return { items: await summarize(user, threads), nextCursor: rows.length > take ? encodeCursor(threads[threads.length - 1]) : null };
  }

  async function suggestContacts(user, q) {
    const prefix = String(q || "").trim().toLowerCase().slice(0, 80);
    if (prefix.length < 2) return [];
    const mailboxIds = (await accessibleMailboxes(user)).map((entry) => entry.mailbox.id);
    const results = new Map();
    const staff = await client.mailAddress.findMany({
      where: { status: "ACTIVE", kind: { in: ["PRIMARY", "SHARED"] }, mailbox: { status: "ACTIVE" }, OR: [{ address: { startsWith: prefix } }, { displayName: { contains: prefix, mode: "insensitive" } }] },
      take: 8,
    });
    for (const entry of staff) results.set(entry.address, { address: entry.address, name: entry.displayName, internal: true });
    if (mailboxIds.length) {
      const correspondents = await client.mailMessage.findMany({
        where: { mailboxId: { in: mailboxIds }, OR: [{ fromAddress: { startsWith: prefix } }, { fromName: { contains: prefix, mode: "insensitive" } }] },
        select: { fromAddress: true, fromName: true },
        distinct: ["fromAddress"],
        take: 8,
      });
      for (const entry of correspondents) if (!results.has(entry.fromAddress)) results.set(entry.fromAddress, { address: entry.fromAddress, name: entry.fromName, internal: false });
      const recipients = await client.mailMessageRecipient.findMany({
        where: { address: { startsWith: prefix }, type: { not: "BCC" }, message: { mailboxId: { in: mailboxIds } } },
        select: { address: true, name: true },
        distinct: ["address"],
        take: 8,
      });
      for (const entry of recipients) if (!results.has(entry.address)) results.set(entry.address, { address: entry.address, name: entry.name, internal: false });
    }
    return [...results.values()].slice(0, 10);
  }

  // Internal helper for already-authorized, mailbox-scoped filters.
  async function listThreadsWhere(user, where, page) {
    return pageThreads(user, where, page);
  }

  return { listThreadsWhere, accessibleMailboxes, listMyMailboxes, getMailbox, listThreads, getThread, getMessages, setThreadState, moveThread, bulk, deleteThread, listLabels, createLabel, setThreadLabel, search, suggestContacts, unreadCount, primaryAddressFor };
}

module.exports = { createMailboxService, VIEWS };
