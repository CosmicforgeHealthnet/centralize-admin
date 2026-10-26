"use strict";

// Message persistence and RFC 5322 threading. Threads are mailbox scoped and
// matched only through Message-ID / In-Reply-To / References inside the same
// mailbox. Subjects are never used alone to merge conversations.
// GAP 8: the provider may replace our Message-ID; its alias (stored in
// mail_message_provider_ids, migration 37) is accepted wherever our own
// rfcMessageId is (In-Reply-To / References resolution, provider echo
// dedup). Before migration 37 alias lookups are skipped.

const crypto = require("crypto");
const { normalizeSubject, sanitizeSubject, normalizeMessageId } = require("../security/header-safety");
const { snippetOf, htmlToText } = require("../security/html-sanitizer");

const BODY_PURPOSE = "mail-body";
const SNIPPET_PURPOSE = "mail-snippet";
const ATTACHMENT_PURPOSE = "mail-attachment";

function generateMessageId(domain) {
  const safeDomain = /^[a-z0-9.-]+$/.test(String(domain || "")) ? domain : "mail.cosmicforge.invalid";
  return `<${crypto.randomUUID()}.${Date.now().toString(36)}@${safeDomain}>`;
}

// Metadata-only search text: subject, sender and visible (non-BCC)
// recipients. Message bodies are NEVER included here: bodies live only in
// encrypted private storage; body search uses the keyed blind index
// (search-index.service.js, opt-in), never plaintext.
function buildMetadataSearchText({ subject, from, recipients = [] }) {
  const parts = [subject || "", from?.address || "", from?.name || "", ...recipients.filter((r) => r.type !== "BCC").map((r) => `${r.address} ${r.name || ""}`)];
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function createMessageStore({ client, storage, config, encryption, features = null }) {
  // Optional keyed blind index for body search (attached by the application).
  let searchIndex = null;
  function useSearchIndex(index) {
    searchIndex = index;
  }

  // Previews are body-derived, so they are stored only as AES-256-GCM
  // ciphertext in the row and decrypted in-process for authorized readers.
  function encryptSnippet(text) {
    const snippet = snippetOf(text);
    if (!snippet) return null;
    return encryption.encrypt(Buffer.from(snippet, "utf8"), SNIPPET_PURPOSE);
  }

  function decryptSnippet(envelope) {
    if (!envelope || !encryption?.available) return "";
    try {
      return encryption.decrypt(envelope, SNIPPET_PURPOSE).toString("utf8");
    } catch {
      return "";
    }
  }

  async function storeBody({ html, text }) {
    const plainText = text || (html ? htmlToText(html) : "");
    const stored = await storage.put("body", Buffer.from(JSON.stringify({ html: html || null, text: plainText || null })), { purpose: BODY_PURPOSE });
    return { key: stored.key, sha256: stored.sha256, sizeBytes: stored.sizeBytes, text: plainText };
  }

  async function readBody(message) {
    if (!message.contentObjectKey) return { html: null, text: null };
    const buffer = await storage.get(message.contentObjectKey, { purpose: BODY_PURPOSE, sha256: message.contentSha256 });
    return JSON.parse(buffer.toString("utf8"));
  }

  async function storeAttachmentContent(buffer) {
    return storage.put("attachment", buffer, { purpose: ATTACHMENT_PURPOSE });
  }

  async function readAttachmentContent(attachment) {
    return storage.get(attachment.storageKey, { purpose: ATTACHMENT_PURPOSE, sha256: attachment.sha256 });
  }

  // Callers check that nothing references the key any more.
  async function removeObject(key) {
    return storage.remove(key);
  }

  // Gap 5: durable deletion queue (ops/storage-deletion.service.js), attached
  // by the application. discardObjects() enqueues unreferenced keys in their
  // own transaction and settles them now; failures stay queued for the
  // worker. Returns null when no deletion service is attached (callers keep
  // their inline cleanup). Never throws.
  let storageDeletions = null;
  function useStorageDeletions(service) {
    storageDeletions = service;
  }

  async function discardObjects(keys, meta = {}) {
    if (!storageDeletions) return null;
    try {
      const plan = await client.$transaction(async (tx) => storageDeletions.enqueue(tx, keys, { purpose: "OBJECT", ...meta }));
      return await storageDeletions.settle(plan);
    } catch {
      // Could not enqueue: fall back to the inline, reference-checked removal.
      return storageDeletions.settle({ mode: "inline", keys: [...new Set((keys || []).filter(Boolean))] }).catch(() => ({ removed: 0, failed: (keys || []).length, shared: 0, held: 0, queued: 0 }));
    }
  }

  async function aliasesReady() {
    if (!features?.finalGap) return false;
    try {
      return Boolean(await features.finalGap.isReady());
    } catch {
      return false;
    }
  }

  // Our rfcMessageIds for provider-assigned Message-ID aliases (gated: the
  // table query only runs once migration 37 is known to exist, so it can
  // never abort the caller's transaction).
  async function rfcIdsForAliases(db, ids) {
    if (!ids.length || !(await aliasesReady())) return [];
    const rows = await db.mailMessageProviderId.findMany({ where: { providerRfcMessageId: { in: ids } }, select: { message: { select: { rfcMessageId: true } } }, take: 50 });
    return [...new Set(rows.map((row) => row.message.rfcMessageId))].filter((id) => !ids.includes(id));
  }

  async function matchThread(tx, mailboxId, ids) {
    const match = await tx.mailMessage.findFirst({
      where: { mailboxId, rfcMessageId: { in: ids }, thread: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      select: { threadId: true },
    });
    if (match) return tx.mailThread.findUnique({ where: { id: match.threadId } });
    return tx.mailThread.findFirst({ where: { mailboxId, rootRfcMessageId: { in: ids }, deletedAt: null } });
  }

  // Finds the mailbox thread referenced by In-Reply-To/References (our
  // Message-ID or the provider's alias of it). Deleted threads are never
  // reused: a reply to one starts a new, visible thread.
  async function findThreadForReferences(tx, mailboxId, { inReplyTo, references = [] }) {
    const ids = [...new Set([inReplyTo, ...references].map(normalizeMessageId).filter(Boolean))];
    if (!ids.length) return null;
    const direct = await matchThread(tx, mailboxId, ids);
    if (direct) return direct;
    const aliased = await rfcIdsForAliases(tx, ids);
    if (!aliased.length) return null;
    return (await matchThread(tx, mailboxId, aliased)) || null;
  }

  // GAP 8 echo dedup: the OUTBOUND message we sent with this Message-ID
  // (ours, or the provider's alias of ours). Returns null otherwise.
  async function findOwnOutbound(db, rfcMessageId) {
    const id = normalizeMessageId(rfcMessageId);
    if (!id) return null;
    const select = { id: true, rfcMessageId: true, fromAddress: true, mailboxId: true };
    const own = await db.mailMessage.findFirst({ where: { rfcMessageId: id, direction: "OUTBOUND" }, select });
    if (own) return { ...own, via: "message-id" };
    if (!(await aliasesReady())) return null;
    const alias = await db.mailMessageProviderId.findFirst({ where: { providerRfcMessageId: id }, select: { message: { select: { ...select, direction: true } } } });
    return alias?.message?.direction === "OUTBOUND" ? { id: alias.message.id, rfcMessageId: alias.message.rfcMessageId, fromAddress: alias.message.fromAddress, mailboxId: alias.message.mailboxId, via: "provider-alias" } : null;
  }

  async function resolveThread(tx, mailbox, { threadId, rfcMessageId, inReplyTo, references, subject, at }) {
    if (threadId) {
      const thread = await tx.mailThread.findUnique({ where: { id: threadId } });
      if (thread && thread.mailboxId === mailbox.id && !thread.deletedAt) return thread;
    }
    const existing = await findThreadForReferences(tx, mailbox.id, { inReplyTo, references });
    if (existing) return existing;
    const cleanSubject = sanitizeSubject(subject);
    return tx.mailThread.create({
      data: {
        mailboxId: mailbox.id,
        subject: cleanSubject,
        normalizedSubject: normalizeSubject(cleanSubject),
        rootRfcMessageId: references?.[0] || inReplyTo || rfcMessageId,
        lastMessageAt: at,
        conversationStatus: mailbox.type === "SHARED" && mailbox.purpose === "SUPPORT" ? "OPEN" : null,
      },
    });
  }

  function mergeParticipants(existing, parties) {
    const list = Array.isArray(existing) ? existing : [];
    const seen = new Set(list.map((party) => party.address));
    for (const party of parties) {
      if (!party?.address || seen.has(party.address) || list.length >= 20) continue;
      seen.add(party.address);
      list.push({ address: party.address, name: party.name || null });
    }
    return list;
  }

  // Creates a message (and recipients) inside a transaction and updates the
  // thread aggregate. Returns null when the mailbox already has this
  // Message-ID (dedupe: internal copies + provider echo / webhook replay).
  async function createMessage(tx, mailbox, input) {
    const duplicate = await tx.mailMessage.findUnique({
      where: { mailboxId_rfcMessageId: { mailboxId: mailbox.id, rfcMessageId: input.rfcMessageId } },
    });
    if (duplicate) return { message: duplicate, thread: null, duplicate: true };
    const at = input.at || new Date();
    const thread = await resolveThread(tx, mailbox, { ...input, at });
    const subject = sanitizeSubject(input.subject);
    const recipients = input.recipients || [];
    const message = await tx.mailMessage.create({
      data: {
        mailboxId: mailbox.id,
        threadId: thread.id,
        direction: input.direction,
        status: input.status,
        rfcMessageId: input.rfcMessageId,
        inReplyTo: input.inReplyTo || null,
        references: input.references || [],
        subject,
        encryptedSnippet: encryptSnippet(input.text),
        fromAddress: input.from.address,
        fromName: input.from.name || null,
        replyTo: input.replyTo || null,
        senderAddressId: input.senderAddressId || null,
        sentByAdminUserId: input.sentByAdminUserId || null,
        envelopeRecipient: input.envelopeRecipient || null,
        hasAttachments: Boolean(input.hasAttachments),
        sizeBytes: input.sizeBytes || 0,
        contentObjectKey: input.body?.key || null,
        contentSha256: input.body?.sha256 || null,
        metadataSearchText: buildMetadataSearchText({ subject, from: input.from, recipients }),
        providerMessageId: input.providerMessageId || null,
        idempotencyKey: input.idempotencyKey || null,
        authResults: input.authResults || undefined,
        spamVerdict: input.spamVerdict || null,
        quarantineReason: input.quarantineReason || null,
        sentAt: input.sentAt || null,
        receivedAt: input.receivedAt || null,
        lastStatusAt: at,
        recipients: { create: recipients.map((recipient) => ({ type: recipient.type, address: recipient.address, name: recipient.name || null, status: recipient.status || "PENDING" })) },
      },
    });
    const inbound = input.direction !== "OUTBOUND";
    await tx.mailThread.update({
      where: { id: thread.id },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: at,
        encryptedSnippet: encryptSnippet(input.text),
        hasInbound: inbound ? true : undefined,
        hasOutbound: inbound ? undefined : true,
        lastInboundAt: inbound ? at : undefined,
        participants: mergeParticipants(thread.participants, [input.from, ...recipients.filter((recipient) => recipient.type !== "BCC")]),
        folder: input.folder || (inbound && thread.folder === "TRASH" ? "INBOX" : undefined),
        revision: { increment: 1 },
      },
    });
    if (inbound) {
      // New inbound mail is unread for everyone with access (per-user state).
      await tx.mailUserThreadState.updateMany({ where: { threadId: thread.id }, data: { isRead: false } });
    }
    if (searchIndex && input.text) await searchIndex.indexMessage(tx, { messageId: message.id, mailboxId: mailbox.id, text: input.text });
    return { message, thread, duplicate: false };
  }

  return { useSearchIndex, encryptSnippet, decryptSnippet, storeBody, readBody, storeAttachmentContent, readAttachmentContent, removeObject, useStorageDeletions, discardObjects, createMessage, resolveThread, findThreadForReferences, findOwnOutbound, generateMessageId, BODY_PURPOSE, ATTACHMENT_PURPOSE };
}

module.exports = { createMessageStore, generateMessageId, buildMetadataSearchText, SNIPPET_PURPOSE };
