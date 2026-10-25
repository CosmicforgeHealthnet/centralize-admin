"use strict";

// Original headers and raw MIME preservation (spec 10.6).
//
// - Objects are written once per inbound email (before the per-mailbox
//   transactions) as AES-256-GCM encrypted private objects, like bodies and
//   attachments, and referenced by every local copy's mail_message_archives
//   row. Nothing lands in searchable columns.
// - Headers: archived whenever migration 35 is present (MAIL_ARCHIVE_HEADERS,
//   default on). Raw MIME: only with MAIL_ARCHIVE_RAW_MIME=true (separate
//   approval), downloaded from the provider's signed, expiring link, bounded
//   by MAIL_ARCHIVE_RAW_MAX_BYTES, SHA-256 recorded and verified on read.
// - Reading needs READ access to the mailbox; raw MIME of a quarantined
//   message is mail-admin only. Every read is audited. Retention purges the
//   rows with their message and removes objects only once unreferenced.

const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");

const HEADERS_PURPOSE = "mail-archive-headers";
const RAW_PURPOSE = "mail-raw-mime";

function createMessageArchive({ client, config, storage, features, audit, logger = null }) {
  async function ready() {
    return features.isReady();
  }

  // Outside any DB transaction. Returns what each mailbox copy should record,
  // or null when archiving is unavailable (no migration 35).
  async function captureInbound(inbound) {
    if (!(await ready())) return null;
    const capture = { headersObjectKey: null, headersSha256: null, headerCount: 0, rawMimeStatus: "NOT_REQUESTED", rawMimeObjectKey: null, rawMimeSha256: null, rawMimeSizeBytes: null };
    if (config.archive.storeHeaders && Array.isArray(inbound.originalHeaders) && inbound.originalHeaders.length) {
      const stored = await storage.put("archive", Buffer.from(JSON.stringify({ headers: inbound.originalHeaders, rfcMessageId: inbound.rfcMessageId || null, inReplyTo: inbound.inReplyTo || null, references: inbound.references || [] })), { purpose: HEADERS_PURPOSE });
      Object.assign(capture, { headersObjectKey: stored.key, headersSha256: stored.sha256, headerCount: inbound.originalHeaders.length });
    }
    if (config.archive.storeRawMime) {
      if (!inbound.rawMime?.download) capture.rawMimeStatus = "UNAVAILABLE";
      else {
        try {
          const buffer = await inbound.rawMime.download(config.archive.rawMimeMaxBytes);
          const stored = await storage.put("archive", buffer, { purpose: RAW_PURPOSE });
          Object.assign(capture, { rawMimeStatus: "STORED", rawMimeObjectKey: stored.key, rawMimeSha256: stored.sha256, rawMimeSizeBytes: stored.sizeBytes });
        } catch (error) {
          // Transient failures retry the whole inbound job (nothing committed yet).
          if (error?.kind === "RETRYABLE") throw error;
          capture.rawMimeStatus = error?.code === "ATTACHMENT_TOO_LARGE" ? "TOO_LARGE" : "FAILED";
          logger?.warn?.(`[MailArchive] raw MIME not archived (${error?.code || "error"})`);
        }
      }
    }
    return capture;
  }

  async function recordCopy(tx, { messageId, mailboxId, capture }) {
    if (!capture) return;
    await tx.mailMessageArchive.upsert({ where: { messageId }, create: { messageId, mailboxId, ...capture }, update: {} });
  }

  // Integrity or storage failures are an honest 503, never a 500 or bad data.
  async function readVerified(key, purpose, sha256) {
    try {
      return await storage.get(key, { purpose, sha256 });
    } catch (error) {
      logger?.warn?.(`[MailArchive] archived object unreadable (${error?.code || error?.name || "error"})`);
      throw mailError("MAIL_STORAGE_UNAVAILABLE", { reason: "ARCHIVE_UNREADABLE" });
    }
  }

  async function load(user, messageId) {
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "archive" });
    if (!policy.isUuid(messageId)) throw mailError("MAIL_NOT_FOUND", { resource: "message" });
    const message = await client.mailMessage.findUnique({ where: { id: messageId }, select: { id: true, mailboxId: true, status: true, deletedAt: true, direction: true } });
    if (!message || message.deletedAt) throw mailError("MAIL_NOT_FOUND", { resource: "message" });
    let access;
    try {
      access = await policy.requireMailboxAccess(client, user, message.mailboxId, "READ");
    } catch (error) {
      if (error.code === "MAIL_NOT_FOUND") throw mailError("MAIL_NOT_FOUND", { resource: "message" });
      throw error;
    }
    const archive = await client.mailMessageArchive.findUnique({ where: { messageId } });
    return { message, access, archive };
  }

  async function originalHeaders(user, messageId, context = {}) {
    const { message, access, archive } = await load(user, messageId);
    if (!archive?.headersObjectKey) return { available: false, headers: [], rawMime: { status: archive?.rawMimeStatus || "NOT_REQUESTED" } };
    const content = JSON.parse((await readVerified(archive.headersObjectKey, HEADERS_PURPOSE, archive.headersSha256)).toString("utf8"));
    await audit.record({ actorAdminUserId: user.id, action: access.viaBreakGlass ? "MAIL_BREAK_GLASS_HEADERS_READ" : "MAIL_ORIGINAL_HEADERS_READ", targetType: "message", targetId: message.id, mailboxId: message.mailboxId }, context);
    return { available: true, headers: content.headers, rfcMessageId: content.rfcMessageId, rawMime: { status: archive.rawMimeStatus, sizeBytes: archive.rawMimeSizeBytes } };
  }

  async function rawMime(user, messageId, context = {}) {
    const { message, access, archive } = await load(user, messageId);
    if (message.status === "QUARANTINED" && !(await policy.canAdministerMail(client, user, "EDIT"))) throw mailError("MAIL_ATTACHMENT_QUARANTINED", { reason: "QUARANTINED_MESSAGE" });
    if (!archive || archive.rawMimeStatus !== "STORED") throw mailError("MAIL_NOT_FOUND", { resource: "raw_mime", status: archive?.rawMimeStatus || "NOT_REQUESTED" });
    const content = await readVerified(archive.rawMimeObjectKey, RAW_PURPOSE, archive.rawMimeSha256);
    await audit.record({ actorAdminUserId: user.id, action: access.viaBreakGlass ? "MAIL_BREAK_GLASS_RAW_DOWNLOAD" : "MAIL_RAW_MIME_DOWNLOADED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { sizeBytes: archive.rawMimeSizeBytes } }, context);
    return { content, sha256: archive.rawMimeSha256 };
  }

  return { ready, captureInbound, recordCopy, originalHeaders, rawMime, HEADERS_PURPOSE, RAW_PURPOSE };
}

module.exports = { createMessageArchive, HEADERS_PURPOSE, RAW_PURPOSE };
