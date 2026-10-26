"use strict";

// Message persistence and RFC 5322 threading. Threads are mailbox scoped and
// matched only through Message-ID / In-Reply-To / References inside the same
// mailbox. Subjects are never used alone to merge conversations.

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

function createMessageStore({ client, storage, config, encryption }) {
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

  // Finds the mailbox thread referenced by In-Reply-To/References. Deleted
  // threads are never reused: a reply to one starts a new, visible thread.
  async function findThreadForReferences(tx, mailboxId, { inReplyTo, references = [] }) {
    const ids = [...new Set([inReplyTo, ...references].map(normalizeMessageId).filter(Boolean))];
    if (!ids.length) return null;
    const match = await tx.mailMessage.findFirst({
      where: { mailboxId, rfcMessageId: { in: ids }, thread: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      select: { threadId: true },
    });
    if (match) return tx.mailThread.findUnique({ where: { id: match.threadId } });
    const root = await tx.mailThread.findFirst({ where: { mailboxId, rootRfcMessageId: { in: ids }, deletedAt: null } });
    return root || null;
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

  return { useSearchIndex, encryptSnippet, decryptSnippet, storeBody, readBody, storeAttachmentContent, readAttachmentContent, removeObject, createMessage, resolveThread, findThreadForReferences, generateMessageId, BODY_PURPOSE, ATTACHMENT_PURPOSE };
}

module.exports = { createMessageStore, generateMessageId, buildMetadataSearchText, SNIPPET_PURPOSE };
