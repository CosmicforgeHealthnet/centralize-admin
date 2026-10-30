"use strict";

// Re-scan of attachments that could not be scanned (scanner unavailable,
// timeout, oversize, malformed reply). Only a mail administrator may trigger
// it; the attachment becomes CLEAN only if the type policy AND the scanner
// both pass now. INFECTED attachments are never released by this path, and
// there is no manual "mark clean" override. Every attempt is audited. The
// administrator never receives the attachment content.
//
// Re-audit fix 3: with the IT quarantine workflow available (migration 37,
// `feature` ready) a rescan NEVER releases: it records the new verdict
// (scanStatus/scanDetail) and the file stays quarantined. Releasing a clean
// file is a separate decision (IT quarantine release: MFA step-up
// MAIL_QUARANTINE_RELEASE, a reason and an append-only RELEASED decision; or
// the message release, which clears clean attachments of that message).
// Before migration 37 there is no release action, so the legacy behaviour is
// kept (a CLEAN rescan clears the quarantine flag).

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");
const { evaluateAttachment } = require("../scanning/attachment-scanner");

const RESCANNABLE = new Set(["PENDING", "SCAN_FAILED", "SCANNER_UNAVAILABLE"]);

function createAttachmentReviewService({ client, config, store, scanner, audit, feature = null }) {
  async function releaseWorkflowReady() {
    if (!feature) return false;
    return feature.isReady().catch(() => false);
  }

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
    const keepQuarantined = await releaseWorkflowReady();
    const changed = await client.mailAttachment.updateMany({
      where: { id: attachment.id, scanStatus: attachment.scanStatus },
      data: { scanStatus: verdict.scanStatus, scanDetail: verdict.scanDetail, ...(keepQuarantined ? (verdict.quarantined ? { quarantined: true } : {}) : { quarantined: verdict.quarantined }) },
    });
    const quarantined = keepQuarantined ? (verdict.quarantined || attachment.quarantined) : verdict.quarantined;
    await audit.record({
      actorAdminUserId: user.id,
      action: verdict.quarantined ? "MAIL_ATTACHMENT_RESCAN_QUARANTINED" : "MAIL_ATTACHMENT_RESCAN_CLEAN",
      targetType: "attachment",
      targetId: attachment.id,
      mailboxId: attachment.mailboxId,
      outcome: changed.count === 1 ? "SUCCESS" : "CONFLICT",
      metadata: { from: attachment.scanStatus, to: verdict.scanStatus, scanner: scanner.name, released: !quarantined && attachment.quarantined },
    }, context);
    if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { resource: "attachment" });
    // previousScanStatus/scanDetail/scanner: scan evidence for the IT
    // quarantine decision log (gap 6); never content.
    return { id: attachment.id, scanStatus: verdict.scanStatus, quarantined, downloadable: !quarantined && verdict.scanStatus === "CLEAN", releaseRequired: quarantined && verdict.scanStatus === "CLEAN", previousScanStatus: attachment.scanStatus, scanDetail: verdict.scanDetail || null, scanner: scanner.name };
  }

  return { rescanAttachment };
}

module.exports = { createAttachmentReviewService, RESCANNABLE };
