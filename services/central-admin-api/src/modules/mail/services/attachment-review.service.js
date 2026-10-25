"use strict";

// Re-scan of attachments that could not be scanned (scanner unavailable,
// timeout, oversize, malformed reply). Only a mail administrator may trigger
// it; the attachment becomes CLEAN only if the type policy AND the scanner
// both pass now. INFECTED attachments are never released by this path, and
// there is no manual "mark clean" override. Every attempt is audited. The
// administrator never receives the attachment content.

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");
const { evaluateAttachment } = require("../scanning/attachment-scanner");

const RESCANNABLE = new Set(["PENDING", "SCAN_FAILED", "SCANNER_UNAVAILABLE"]);

function createAttachmentReviewService({ client, config, store, scanner, audit }) {
  async function rescanAttachment(user, attachmentId, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!policy.isUuid(attachmentId)) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
    const attachment = await client.mailAttachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
    if (!RESCANNABLE.has(attachment.scanStatus) || !attachment.storageKey) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_ATTACHMENT_RESCAN_REFUSED", targetType: "attachment", targetId: attachment.id, mailboxId: attachment.mailboxId, outcome: "DENIED", metadata: { scanStatus: attachment.scanStatus } }, context);
      throw mailError("MAIL_ATTACHMENT_QUARANTINED", { scanStatus: attachment.scanStatus, reason: "NOT_RESCANNABLE" });
    }
    const buffer = await store.readAttachmentContent(attachment);
    const verdict = await evaluateAttachment(scanner, { filename: attachment.filename, contentType: attachment.contentType, buffer, maxBytes: config.limits.attachmentMaxBytes });
    // Guard against a concurrent rescan / status change.
    const changed = await client.mailAttachment.updateMany({
      where: { id: attachment.id, scanStatus: attachment.scanStatus },
      data: { scanStatus: verdict.scanStatus, scanDetail: verdict.scanDetail, quarantined: verdict.quarantined },
    });
    await audit.record({
      actorAdminUserId: user.id,
      action: verdict.quarantined ? "MAIL_ATTACHMENT_RESCAN_QUARANTINED" : "MAIL_ATTACHMENT_RESCAN_CLEAN",
      targetType: "attachment",
      targetId: attachment.id,
      mailboxId: attachment.mailboxId,
      outcome: changed.count === 1 ? "SUCCESS" : "CONFLICT",
      metadata: { from: attachment.scanStatus, to: verdict.scanStatus, scanner: scanner.name },
    }, context);
    if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { resource: "attachment" });
    return { id: attachment.id, scanStatus: verdict.scanStatus, quarantined: verdict.quarantined, downloadable: !verdict.quarantined && verdict.scanStatus === "CLEAN" };
  }

  return { rescanAttachment };
}

module.exports = { createAttachmentReviewService, RESCANNABLE };
