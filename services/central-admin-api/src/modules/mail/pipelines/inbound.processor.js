"use strict";

// Inbound email pipeline (job kind PROCESS_INBOUND), spec section 10.
// 1. retrieve the received message + attachments from the provider (the
//    webhook alone is never the whole email)
// 2. resolve every delivery address (To, Cc, Bcc, Received-for) on OUR
//    domains to ACTIVE local addresses/mailboxes. External addresses are
//    ignored; receiving-domain verification never auto-provisions addresses
//    and there is no catch-all.
// 3. unknown local recipients follow MAIL_UNKNOWN_RECIPIENT_POLICY:
//    reject = record and drop; quarantine = record and end the job as
//    FAILED(INBOUND_UNKNOWN_RECIPIENT_QUARANTINED) so an operator can requeue
//    it after provisioning the address (nothing is stored or shown to staff)
// 4. assess sender authentication (provider-verified SPF/DKIM/DMARC only)
// 5. scan + encrypt attachments, encrypt body and archive original headers
//    (and raw MIME when approved) once; create one copy per mailbox (BCC
//    envelope data stays private to that mailbox's copy)
// 6. mailbox storage quota policy (accept + alert, or reject per mailbox)
// 7. thread by RFC identifiers, apply rules, Support SLA, mark unread,
//    index for body search (keyed, opt-in), notify members
// 8. after commit: approved forwarding and campaign reply attribution

const { normalizeAddress } = require("../security/address.util");
const { normalizeMessageId } = require("../security/header-safety");
const { evaluateAttachment } = require("../scanning/attachment-scanner");
const { applyRules } = require("../services/mail-rules");
const { assessSenderAuthentication, authResultsRecord, loadSenderAuthPolicy } = require("../security/sender-auth");

class PipelineError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

// Unique violation on the per-mailbox RFC Message-ID index.
function isConcurrentDuplicate(error) {
  if (error?.code !== "P2002") return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.join(",") : String(target || error.message || "");
  return /rfc_message_id|rfcMessageId/.test(fields);
}

function createInboundProcessor({ client, config, adapter, store, scanner, audit, notifications, usage = null, archive = null, forwarding = null, campaignReplies = null, senderAuth = loadSenderAuthPolicy({}), clock = () => new Date(), logger = null }) {
  async function ownDomains() {
    const rows = await client.mailDomain.findMany({ select: { domain: true } });
    return new Set(rows.map((row) => row.domain.toLowerCase()));
  }

  async function resolveRecipients(addresses, domains = null) {
    const normalized = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
    if (!normalized.length) return { local: [], unknown: [] };
    const ours = domains || (await ownDomains());
    const candidates = normalized.filter((address) => ours.has(address.split("@")[1]));
    if (!candidates.length) return { local: [], unknown: [] };
    const rows = await client.mailAddress.findMany({
      where: { address: { in: candidates }, status: "ACTIVE", mailboxId: { not: null }, mailbox: { status: "ACTIVE" }, domain: { status: { in: ["VERIFIED", "PENDING_VERIFICATION"] } } },
      include: { mailbox: true },
    });
    const known = new Map(rows.map((row) => [row.address, row]));
    const local = [];
    const seenMailboxes = new Set();
    for (const address of candidates) {
      const row = known.get(address);
      if (!row || seenMailboxes.has(row.mailboxId)) continue;
      seenMailboxes.add(row.mailboxId);
      local.push(row);
    }
    return { local, unknown: candidates.filter((address) => !known.has(address)) };
  }

  async function mailboxUsageBytes(mailboxId) {
    const result = await client.mailMessage.aggregate({ where: { mailboxId, deletedAt: null }, _sum: { sizeBytes: true } });
    return Number(result._sum.sizeBytes || 0);
  }

  async function process(job) {
    if (!config.receivingEnabled) throw new PipelineError("MAIL_RECEIVING_DISABLED", "receiving disabled", { retryable: true });
    const providerEmailId = String(job.payload?.providerEmailId || "");
    if (!providerEmailId) throw new PipelineError("INBOUND_PAYLOAD_INVALID", "missing provider email id", { retryable: false });

    const inbound = await adapter.fetchInboundMessage(providerEmailId);
    if (!inbound.from?.address) throw new PipelineError("INBOUND_SENDER_INVALID", "sender missing or invalid", { retryable: false });

    const domains = await ownDomains();
    // Every address the email was delivered for (To, Cc, Bcc/envelope).
    // Only our own domains are considered; BCC data never becomes visible.
    const envelope = [...(job.payload?.to || []), ...(inbound.to || []).map((party) => party.address), ...(inbound.cc || []).map((party) => party.address), ...(inbound.envelopeRecipients || [])];
    const { local, unknown } = await resolveRecipients(envelope, domains);
    if (unknown.length) {
      await audit.record({
        action: config.unknownRecipientPolicy === "quarantine" ? "MAIL_INBOUND_UNKNOWN_RECIPIENT_QUARANTINED" : "MAIL_INBOUND_UNKNOWN_RECIPIENT_REJECTED",
        targetType: "webhook_event",
        targetId: job.webhookEventId,
        outcome: "DENIED",
        metadata: { unknownCount: unknown.length, domains: [...new Set(unknown.map((address) => address.split("@")[1]))].slice(0, 10), providerEmailId, senderDomain: inbound.from.address.split("@")[1] },
      });
    }
    if (!local.length) {
      if (unknown.length && config.unknownRecipientPolicy === "quarantine") throw new PipelineError("INBOUND_UNKNOWN_RECIPIENT_QUARANTINED", "no provisioned recipient; held for operator review", { retryable: false });
      return { delivered: 0, unknown: unknown.length };
    }

    // Sender authentication: provider-verified results only.
    const assessment = assessSenderAuthentication(inbound, { settings: senderAuth, internalDomains: domains });
    if (assessment.warn || assessment.quarantineReason) {
      await audit.record({ action: assessment.quarantineReason ? "MAIL_INBOUND_AUTH_QUARANTINED" : "MAIL_INBOUND_AUTH_WARNING", targetType: "webhook_event", targetId: job.webhookEventId, outcome: assessment.quarantineReason ? "DENIED" : "SUCCESS", metadata: { verdict: assessment.verdict, reasons: assessment.reasons, source: assessment.source, senderDomain: assessment.fromDomain, providerEmailId } });
    }

    const rfcMessageId = normalizeMessageId(inbound.rfcMessageId) || `<resend-${providerEmailId.replace(/[^A-Za-z0-9_-]/g, "")}@inbound.cosmicforge.invalid>`;
    // Replays (webhook retry, reconciliation) of an email every mailbox
    // already has: nothing to store. Checked before any object is written.
    const existingCopies = await client.mailMessage.count({ where: { mailboxId: { in: local.map((target) => target.mailboxId) }, rfcMessageId } });
    if (existingCopies >= local.length) return { delivered: 0, unknown: unknown.length, duplicate: true };

    // Objects written by this job; removed again if no mailbox copy ends up
    // referencing them (duplicate race, quota rejection or a failure).
    const writtenKeys = [];
    try {
      return await deliver({ job, inbound, providerEmailId, local, unknown, domains, assessment, rfcMessageId, writtenKeys });
    } catch (error) {
      await discardUnreferenced(writtenKeys);
      throw error;
    }
  }

  async function stillReferenced(key) {
    const [messages, attachments] = await Promise.all([
      client.mailMessage.count({ where: { OR: [{ contentObjectKey: key }, { rawMimeObjectKey: key }] } }),
      client.mailAttachment.count({ where: { storageKey: key } }),
    ]);
    if (messages || attachments) return true;
    if (!archive || !(await archive.ready().catch(() => false))) return false;
    return (await client.mailMessageArchive.count({ where: { OR: [{ headersObjectKey: key }, { rawMimeObjectKey: key }] } })) > 0;
  }

  async function discardUnreferenced(keys) {
    let removed = 0;
    for (const key of keys) {
      try {
        if (await stillReferenced(key)) continue;
        await store.removeObject(key);
        removed += 1;
      } catch (error) {
        logger?.warn?.(`[Mail] inbound orphan cleanup failed (${error?.code || "error"})`);
      }
    }
    return removed;
  }

  async function deliver({ job, inbound, providerEmailId, local, unknown, assessment, rfcMessageId, writtenKeys }) {
    // Attachments are scanned once, stored once, referenced per mailbox copy.
    const storedAttachments = [];
    const maxBytes = config.limits.attachmentMaxBytes;
    if (inbound.attachmentCount > 0) {
      const attachments = await adapter.fetchInboundAttachments(providerEmailId);
      for (const attachment of attachments.slice(0, config.limits.maxAttachmentsPerMessage * 2)) {
        let buffer;
        try {
          // Same cap as the policy check below, so the download stops early.
          buffer = await attachment.download(maxBytes);
        } catch (error) {
          if (error.kind === "RETRYABLE") throw new PipelineError("ATTACHMENT_DOWNLOAD_RETRY", "attachment download failed", { retryable: true });
          storedAttachments.push({ meta: attachment, failed: true, reason: error.code === "ATTACHMENT_TOO_LARGE" ? "POLICY_SIZE_LIMIT" : error.code || "DOWNLOAD_FAILED" });
          continue;
        }
        const verdict = await evaluateAttachment(scanner, { filename: attachment.filename, contentType: attachment.contentType, buffer, maxBytes });
        const stored = await store.storeAttachmentContent(buffer);
        writtenKeys.push(stored.key);
        storedAttachments.push({ meta: attachment, stored, verdict });
      }
    }

    const body = await store.storeBody({ html: inbound.html, text: inbound.text });
    writtenKeys.push(body.key);
    // Original headers / raw MIME (spec 10.6), encrypted, stored once.
    const archived = archive ? await archive.captureInbound(inbound) : null;
    if (archived) writtenKeys.push(...[archived.headersObjectKey, archived.rawMimeObjectKey].filter(Boolean));
    const isSpam = ["yes", "true", "spam"].includes(String(inbound.spamVerdict || "").toLowerCase());
    const visibleRecipients = [
      ...(inbound.to || []).map((party) => ({ ...party, type: "TO", status: "DELIVERED" })),
      ...(inbound.cc || []).map((party) => ({ ...party, type: "CC", status: "DELIVERED" })),
    ];
    // Only a scanner detection is "malicious"; policy refusals just keep the
    // attachment itself quarantined.
    const anyInfected = storedAttachments.some((entry) => entry.verdict?.scanStatus === "INFECTED");
    const quarantineReason = anyInfected ? "MALICIOUS_ATTACHMENT" : assessment.quarantineReason || (isSpam ? "PROVIDER_SPAM_VERDICT" : null);
    const sizeBytes = body.sizeBytes + storedAttachments.reduce((sum, entry) => sum + (entry.stored?.sizeBytes || 0), 0);

    let delivered = 0;
    let overQuota = 0;
    for (const target of local) {
      const mailbox = target.mailbox;
      const used = await mailboxUsageBytes(mailbox.id);
      if (used + sizeBytes > config.quota.mailboxStorageBytes) {
        overQuota += 1;
        await audit.record({ action: config.quota.overQuotaPolicy === "reject" ? "MAIL_INBOUND_OVER_QUOTA_REJECTED" : "MAIL_MAILBOX_OVER_QUOTA", targetType: "mailbox", targetId: mailbox.id, mailboxId: mailbox.id, outcome: config.quota.overQuotaPolicy === "reject" ? "DENIED" : "SUCCESS", metadata: { usedBytes: used, incomingBytes: sizeBytes, quotaBytes: config.quota.mailboxStorageBytes, policy: config.quota.overQuotaPolicy } });
        if (config.quota.overQuotaPolicy === "reject") {
          const members = await notifications.mailboxMemberIds(mailbox.id);
          await notifications.notifyUsers(members, { icon: "alert", title: `${mailbox.name} is full`, subtitle: "An incoming email could not be delivered. Free up space or ask IT for more." }).catch(() => {});
          continue;
        }
      }
      // A concurrent worker processing the same email can win the race past
      // createMessage's duplicate check; the (mailbox_id, rfc_message_id)
      // unique index then rejects this copy, which is a duplicate, not a failure.
      const outcome = await client.$transaction(async (tx) => {
        const created = await store.createMessage(tx, mailbox, {
          direction: "INBOUND",
          status: quarantineReason ? "QUARANTINED" : "RECEIVED",
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
          sizeBytes,
          providerMessageId: providerEmailId,
          authResults: authResultsRecord(inbound, assessment),
          spamVerdict: inbound.spamVerdict,
          quarantineReason,
          receivedAt: inbound.receivedAt,
          at: inbound.receivedAt || clock(),
          folder: quarantineReason ? "SPAM" : undefined,
        });
        if (created.duplicate) return created;
        const attachmentRows = [];
        for (const entry of storedAttachments) {
          attachmentRows.push(await tx.mailAttachment.create({
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
          }));
        }
        if (archive) await archive.recordCopy(tx, { messageId: created.message.id, mailboxId: mailbox.id, capture: archived });
        await applyRules(tx, mailbox, created, { from: inbound.from, subject: inbound.subject, to: visibleRecipients, hasAttachments: storedAttachments.length > 0 });
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
        if (usage) await usage.record(tx, { organizationId: mailbox.organizationId, purpose: "INBOUND", received: 1, bytes: created.message.sizeBytes || 0 });
        await audit.record({ action: "MAIL_INBOUND_DELIVERED", targetType: "message", targetId: created.message.id, mailboxId: mailbox.id, metadata: { attachments: storedAttachments.length, quarantined: created.message.status === "QUARANTINED", authVerdict: assessment.verdict } }, {}, tx);
        return { ...created, attachmentRows };
      }).catch((error) => {
        if (isConcurrentDuplicate(error)) return { duplicate: true };
        throw error;
      });
      if (!outcome.duplicate) {
        delivered += 1;
        const members = await notifications.mailboxMemberIds(mailbox.id);
        await notifications.notifyUsers(members, { icon: "bell", kind: "NEW_MAIL", title: `New email in ${mailbox.name}`, subtitle: `From ${inbound.from.name || inbound.from.address}` });
        // Post-commit side effects never undo the delivery.
        if (forwarding) {
          await forwarding.forwardInbound({ mailbox, message: outcome.message, inbound, body, attachments: outcome.attachmentRows }).catch((error) => logger?.warn?.(`[Mail] forwarding failed (${error?.code || "error"})`));
        }
        if (campaignReplies) {
          await campaignReplies.attributeInbound({ mailbox, message: outcome.message }).catch((error) => logger?.warn?.(`[Mail] reply attribution failed (${error?.code || "error"})`));
        }
      }
    }
    if (!delivered) await discardUnreferenced(writtenKeys);
    return { delivered, unknown: unknown.length, overQuota, authVerdict: assessment.verdict };
  }

  return { process, resolveRecipients };
}

module.exports = { createInboundProcessor, PipelineError };
