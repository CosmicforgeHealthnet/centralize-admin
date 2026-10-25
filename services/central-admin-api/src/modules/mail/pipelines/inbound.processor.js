"use strict";

// Inbound email pipeline (job kind PROCESS_INBOUND).
// 1. retrieve the received message + attachments from the provider
// 2. resolve envelope recipients to ACTIVE local addresses/mailboxes
//    (receiving-domain verification does NOT auto-provision addresses)
// 3. unknown recipients follow MAIL_UNKNOWN_RECIPIENT_POLICY (reject|quarantine)
// 4. scan + encrypt attachments, encrypt body, create one copy per mailbox
//    (per-mailbox copies keep BCC envelope data private to that mailbox)
// 5. thread by RFC identifiers, apply rules, mark unread, notify members

const { normalizeAddress } = require("../security/address.util");
const { normalizeMessageId } = require("../security/header-safety");
const { evaluateAttachment } = require("../scanning/attachment-scanner");
const { applyRules } = require("../services/mail-rules");

class PipelineError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function createInboundProcessor({ client, config, adapter, store, scanner, audit, notifications, clock = () => new Date() }) {
  async function resolveRecipients(addresses) {
    const normalized = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
    if (!normalized.length) return { local: [], unknown: [] };
    const rows = await client.mailAddress.findMany({
      where: { address: { in: normalized }, status: "ACTIVE", mailboxId: { not: null }, mailbox: { status: "ACTIVE" }, domain: { status: { in: ["VERIFIED", "PENDING_VERIFICATION"] } } },
      include: { mailbox: true },
    });
    const known = new Map(rows.map((row) => [row.address, row]));
    const local = [];
    const seenMailboxes = new Set();
    for (const address of normalized) {
      const row = known.get(address);
      if (!row || seenMailboxes.has(row.mailboxId)) continue;
      seenMailboxes.add(row.mailboxId);
      local.push(row);
    }
    return { local, unknown: normalized.filter((address) => !known.has(address)) };
  }

  async function process(job) {
    if (!config.receivingEnabled) throw new PipelineError("MAIL_RECEIVING_DISABLED", "receiving disabled", { retryable: true });
    const providerEmailId = String(job.payload?.providerEmailId || "");
    if (!providerEmailId) throw new PipelineError("INBOUND_PAYLOAD_INVALID", "missing provider email id", { retryable: false });

    const inbound = await adapter.fetchInboundMessage(providerEmailId);
    if (!inbound.from?.address) throw new PipelineError("INBOUND_SENDER_INVALID", "sender missing or invalid", { retryable: false });

    const envelope = [...(job.payload?.to || []), ...(inbound.envelopeRecipients || [])];
    const { local, unknown } = await resolveRecipients(envelope);
    if (unknown.length) {
      await audit.record({
        action: config.unknownRecipientPolicy === "quarantine" ? "MAIL_INBOUND_UNKNOWN_RECIPIENT_QUARANTINED" : "MAIL_INBOUND_UNKNOWN_RECIPIENT_REJECTED",
        targetType: "webhook_event",
        targetId: job.webhookEventId,
        outcome: "DENIED",
        metadata: { unknownCount: unknown.length, domains: [...new Set(unknown.map((address) => address.split("@")[1]))].slice(0, 10), providerEmailId, senderDomain: inbound.from.address.split("@")[1] },
      });
    }
    if (!local.length) return { delivered: 0, unknown: unknown.length };

    // Attachments are scanned once, stored once, referenced per mailbox copy.
    const storedAttachments = [];
    if (inbound.attachmentCount > 0) {
      const attachments = await adapter.fetchInboundAttachments(providerEmailId);
      for (const attachment of attachments.slice(0, config.limits.maxAttachmentsPerMessage * 2)) {
        let buffer;
        try {
          buffer = await attachment.download();
        } catch (error) {
          if (error.kind === "RETRYABLE") throw new PipelineError("ATTACHMENT_DOWNLOAD_RETRY", "attachment download failed", { retryable: true });
          storedAttachments.push({ meta: attachment, failed: true, reason: error.code || "DOWNLOAD_FAILED" });
          continue;
        }
        const verdict = await evaluateAttachment(scanner, { filename: attachment.filename, contentType: attachment.contentType, buffer, maxBytes: config.limits.attachmentMaxBytes });
        const stored = await store.storeAttachmentContent(buffer);
        storedAttachments.push({ meta: attachment, stored, verdict });
      }
    }

    const body = await store.storeBody({ html: inbound.html, text: inbound.text });
    const rfcMessageId = normalizeMessageId(inbound.rfcMessageId) || `<resend-${providerEmailId.replace(/[^A-Za-z0-9_-]/g, "")}@inbound.cosmicforge.invalid>`;
    const isSpam = ["yes", "true", "spam"].includes(String(inbound.spamVerdict || "").toLowerCase());
    const visibleRecipients = [
      ...inbound.to.map((party) => ({ ...party, type: "TO", status: "DELIVERED" })),
      ...inbound.cc.map((party) => ({ ...party, type: "CC", status: "DELIVERED" })),
    ];
    const anyInfected = storedAttachments.some((entry) => entry.verdict?.scanStatus === "INFECTED");

    let delivered = 0;
    for (const target of local) {
      const mailbox = target.mailbox;
      const outcome = await client.$transaction(async (tx) => {
        const created = await store.createMessage(tx, mailbox, {
          direction: "INBOUND",
          status: isSpam || anyInfected ? "QUARANTINED" : "RECEIVED",
          rfcMessageId,
          inReplyTo: inbound.inReplyTo,
          references: inbound.references,
          subject: inbound.subject,
          from: inbound.from,
          replyTo: inbound.replyTo,
          recipients: visibleRecipients,
          envelopeRecipient: target.address,
          text: body.text,
          body,
          hasAttachments: storedAttachments.length > 0,
          sizeBytes: body.sizeBytes + storedAttachments.reduce((sum, entry) => sum + (entry.stored?.sizeBytes || 0), 0),
          providerMessageId: providerEmailId,
          authResults: inbound.authResults,
          spamVerdict: inbound.spamVerdict,
          quarantineReason: anyInfected ? "MALICIOUS_ATTACHMENT" : isSpam ? "PROVIDER_SPAM_VERDICT" : null,
          receivedAt: inbound.receivedAt,
          at: inbound.receivedAt || clock(),
          folder: isSpam || anyInfected ? "SPAM" : undefined,
        });
        if (created.duplicate) return created;
        for (const entry of storedAttachments) {
          await tx.mailAttachment.create({
            data: {
              mailboxId: mailbox.id,
              messageId: created.message.id,
              filename: entry.meta.filename,
              contentType: entry.meta.contentType,
              sizeBytes: entry.stored?.sizeBytes ?? entry.meta.sizeBytes ?? 0,
              sha256: entry.stored?.sha256 || "0".repeat(64),
              storageKey: entry.stored?.key || null,
              isInline: Boolean(entry.meta.inline),
              contentId: entry.meta.contentId,
              scanStatus: entry.failed ? "SCAN_FAILED" : entry.verdict.scanStatus,
              scanDetail: entry.failed ? entry.reason : entry.verdict.scanDetail,
              quarantined: entry.failed ? true : entry.verdict.quarantined,
              providerAttachmentId: entry.meta.providerAttachmentId || null,
            },
          });
        }
        await applyRules(tx, mailbox, created, { from: inbound.from, subject: inbound.subject, to: visibleRecipients });
        if (mailbox.type === "SHARED" && mailbox.purpose === "SUPPORT") {
          const thread = await tx.mailThread.findUnique({ where: { id: created.thread.id } });
          const reopen = !thread.conversationStatus || ["RESOLVED", "CLOSED"].includes(thread.conversationStatus);
          await tx.mailThread.update({
            where: { id: thread.id },
            data: {
              conversationStatus: reopen ? "OPEN" : undefined,
              slaDueAt: mailbox.slaFirstResponseMinutes && (reopen || !thread.slaDueAt) ? new Date((inbound.receivedAt || clock()).getTime() + mailbox.slaFirstResponseMinutes * 60000) : undefined,
              firstResponseAt: reopen ? null : undefined,
            },
          });
        }
        await audit.record({ action: "MAIL_INBOUND_DELIVERED", targetType: "message", targetId: created.message.id, mailboxId: mailbox.id, metadata: { attachments: storedAttachments.length, quarantined: created.message.status === "QUARANTINED" } }, {}, tx);
        return created;
      });
      if (!outcome.duplicate) {
        delivered += 1;
        const members = await notifications.mailboxMemberIds(mailbox.id);
        await notifications.notifyUsers(members, { icon: "bell", title: `New email in ${mailbox.name}`, subtitle: `From ${inbound.from.name || inbound.from.address}` });
      }
    }
    return { delivered, unknown: unknown.length };
  }

  return { process, resolveRecipients };
}

module.exports = { createInboundProcessor, PipelineError };
