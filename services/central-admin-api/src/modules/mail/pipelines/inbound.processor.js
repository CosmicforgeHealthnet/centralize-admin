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
//    it after provisioning the address (nothing is stored or shown to staff).
//    In a mixed message (some recipients known) the known ones get their copy
//    and, under quarantine, the unknown ones are held in a separate
//    PROCESS_INBOUND job restricted to them (payload.onlyRecipients), which
//    ends FAILED(INBOUND_UNKNOWN_RECIPIENT_QUARANTINED) the same way and is
//    requeued by an operator after provisioning. Unknown recipients never
//    get a copy.
//    Routing depends on the domain being ours, not SUSPENDED and not having
//    receiving DISABLED at the provider; the overall (sending) verification
//    result never matters (a failing DKIM record must not lose inbound
//    mail). Recipients on one of our domains that is not receiving are held:
//    when nobody else gets the mail the job ends
//    FAILED(INBOUND_DOMAIN_NOT_RECEIVING) (requeueable, reported by the
//    reconciler as unrecovered), never SUCCEEDED with nothing delivered.
//    Receiving disabled (MAIL_RECEIVING_ENABLED=false) defers the job without
//    consuming an attempt.
//    Reserved senders (MAIL_RESERVED_SENDER_ADDRESSES, e.g. KarryGo's
//    no-reply@karryam.com) are an explicit no-reply policy, independent of
//    MAIL_UNKNOWN_RECIPIENT_POLICY: their copy is discarded and
//    MAIL_INBOUND_RESERVED_ADDRESS_DISCARDED is audited (counts and domains
//    only). They are never held, never delivered and never auto-answered.
// 4. assess sender authentication (provider-verified SPF/DKIM/DMARC only)
// 5. scan + encrypt attachments, encrypt body and archive original headers
//    (and raw MIME when approved) once; create one copy per mailbox (BCC
//    envelope data stays private to that mailbox's copy)
// 6. mailbox storage quota policy (accept + alert, or reject per mailbox)
// 7. thread by RFC identifiers, apply rules, Support SLA, mark unread,
//    index for body search (keyed, opt-in), notify members
// 8. after commit: approved forwarding and campaign reply attribution
//
// Provider echoes (GAP 8, MAIL_MIXED_RECIPIENT_MODE=full-headers): the
// provider is given internal To/Cc too and delivers them back to us via MX.
// Internal recipients already hold their single local copy, so for each
// target mailbox that already holds the referenced message the echo is
// dropped (no new copy) and MAIL_INBOUND_PROVIDER_ECHO_DEDUPED is audited.
// The echo is recognised by the signed X-CosmicForge-Origin header (HMAC
// verified in constant time; forged/invalid = normal mail) or by Message-ID
// (ours, or the provider's alias of ours). The From must be the original
// sender. Mailboxes without a copy still get the mail normally.

const { normalizeAddress } = require("../security/address.util");
const { normalizeMessageId } = require("../security/header-safety");
const { evaluateAttachment } = require("../scanning/attachment-scanner");
const { applyRules } = require("../services/mail-rules");
const { assessSenderAuthentication, authResultsRecord, loadSenderAuthPolicy } = require("../security/sender-auth");
const { originHeaderFromConfig } = require("../security/origin-header");
const { reservedSenderSet } = require("../security/reserved-senders");

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

// A domain we own receives mail unless an operator suspended it or receiving
// is disabled for it at the provider. Sending verification (SPF/DKIM, the
// provider's overall status) is irrelevant for routing.
function domainReceives(row) {
  return row.status !== "SUSPENDED" && row.receivingStatus !== "DISABLED";
}

const UNKNOWN_HOLD_SOURCE = "unknown-recipient-hold";

// The worker increments attemptCount when it claims a job and dead-letters a
// retryable failure once attemptCount >= maxAttempts: that run is the last.
function finalAttempt(job) {
  const attempt = Number(job?.attemptCount);
  const max = Number(job?.maxAttempts);
  return Number.isFinite(attempt) && Number.isFinite(max) && max > 0 && attempt >= max;
}
const RECEIVING_DISABLED_DEFER_SECONDS = 300;

function createInboundProcessor({ client, config, adapter, store, scanner, audit, notifications, jobs = null, usage = null, archive = null, forwarding = null, campaignReplies = null, senderAuth = loadSenderAuthPolicy({}), clock = () => new Date(), logger = null }) {
  // Verification works in every mode, so echoes of mail sent before a switch
  // back to external-only are still recognised.
  const origin = originHeaderFromConfig(config);
  const reservedSenders = reservedSenderSet(config);

  // GAP 8: which target mailboxes received this inbound as a provider echo
  // of a message we sent (and already delivered locally)?
  async function providerEchoes({ inbound, rfcMessageId, local, job, providerEmailId }) {
    let source = null;
    let via = null;
    const presented = origin.extract(inbound.originalHeaders);
    if (presented) {
      const messageId = origin.verify(presented);
      const found = messageId ? await client.mailMessage.findUnique({ where: { id: messageId }, select: { id: true, rfcMessageId: true, fromAddress: true, direction: true } }) : null;
      if (found && found.direction === "OUTBOUND") {
        source = found;
        via = "origin-header";
      } else {
        // Forged, stale-key or unknown: never suppresses delivery.
        await audit.record({ action: "MAIL_INBOUND_ORIGIN_HEADER_INVALID", targetType: "webhook_event", targetId: job.webhookEventId, outcome: "DENIED", metadata: { reason: messageId ? "MESSAGE_NOT_FOUND" : "SIGNATURE_INVALID", providerEmailId, senderDomain: inbound.from.address.split("@")[1] } });
      }
    }
    if (!source && store.findOwnOutbound) {
      const own = await store.findOwnOutbound(client, rfcMessageId);
      if (own) {
        source = own;
        via = own.via;
      }
    }
    if (!source || normalizeAddress(source.fromAddress) !== normalizeAddress(inbound.from.address)) return new Map();
    const internallyDelivered = await client.mailMessageRecipient.count({ where: { messageId: source.id, status: "INTERNAL_DELIVERED" } });
    if (!internallyDelivered) return new Map();
    const copies = await client.mailMessage.findMany({ where: { mailboxId: { in: local.map((target) => target.mailboxId) }, rfcMessageId: source.rfcMessageId }, select: { mailboxId: true } });
    const echoes = new Map();
    for (const copy of copies) echoes.set(copy.mailboxId, { sourceId: source.id, via });
    return echoes;
  }

  // Every domain we own (`all`) and the subset currently receiving mail.
  async function ownDomainState() {
    const rows = await client.mailDomain.findMany({ select: { domain: true, status: true, receivingStatus: true } });
    const all = new Set();
    const receiving = new Set();
    for (const row of rows) {
      const name = row.domain.toLowerCase();
      all.add(name);
      if (domainReceives(row)) receiving.add(name);
    }
    return { all, receiving };
  }

  // `domains`: an ownDomainState() result (a plain Set of domain names is
  // accepted too and treated as all receiving).
  async function resolveRecipients(addresses, domains = null) {
    const normalized = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
    if (!normalized.length) return { local: [], unknown: [], domainHeld: [], reserved: [] };
    const state = domains instanceof Set ? { all: domains, receiving: domains } : domains || (await ownDomainState());
    const ownAll = normalized.filter((address) => state.all.has(address.split("@")[1]));
    // No-reply policy: reserved senders never receive, whatever their domain state.
    const reserved = ownAll.filter((address) => reservedSenders.has(address));
    const ours = ownAll.filter((address) => !reservedSenders.has(address));
    const candidates = ours.filter((address) => state.receiving.has(address.split("@")[1]));
    const domainHeld = ours.filter((address) => !state.receiving.has(address.split("@")[1]));
    if (!candidates.length) return { local: [], unknown: [], domainHeld, reserved };
    const rows = await client.mailAddress.findMany({
      where: { address: { in: candidates }, status: "ACTIVE", mailboxId: { not: null }, mailbox: { status: "ACTIVE" }, domain: { status: { not: "SUSPENDED" }, receivingStatus: { not: "DISABLED" } } },
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
    return { local, unknown: candidates.filter((address) => !known.has(address)), domainHeld, reserved };
  }

  async function mailboxUsageBytes(mailboxId) {
    const result = await client.mailMessage.aggregate({ where: { mailboxId, deletedAt: null }, _sum: { sizeBytes: true } });
    return Number(result._sum.sizeBytes || 0);
  }

  async function process(job) {
    // Receiving switched off: try again later without consuming an attempt
    // (a disabled flag must never dead-letter received mail).
    if (!config.receivingEnabled) return { defer: { seconds: RECEIVING_DISABLED_DEFER_SECONDS, code: "MAIL_RECEIVING_DISABLED", message: "receiving disabled" } };
    const providerEmailId = String(job.payload?.providerEmailId || "");
    if (!providerEmailId) throw new PipelineError("INBOUND_PAYLOAD_INVALID", "missing provider email id", { retryable: false });

    const inbound = await adapter.fetchInboundMessage(providerEmailId);
    if (!inbound.from?.address) throw new PipelineError("INBOUND_SENDER_INVALID", "sender missing or invalid", { retryable: false });

    const domainState = await ownDomainState();
    const domains = domainState.all;
    // Every address the email was delivered for (To, Cc, Bcc/envelope).
    // Only our own domains are considered; BCC data never becomes visible.
    let envelope = [...(job.payload?.to || []), ...(inbound.to || []).map((party) => party.address), ...(inbound.cc || []).map((party) => party.address), ...(inbound.envelopeRecipients || [])];
    // A held unknown-recipient job only (re)tries the recipients it holds.
    const restricted = Array.isArray(job.payload?.onlyRecipients) ? new Set(job.payload.onlyRecipients.map(normalizeAddress).filter(Boolean)) : null;
    if (restricted) envelope = envelope.map(normalizeAddress).filter((address) => address && restricted.has(address));
    const isHoldJob = job.payload?.source === UNKNOWN_HOLD_SOURCE;
    const resolved = await resolveRecipients(envelope, domainState);
    const { unknown, domainHeld, reserved } = resolved;
    let { local } = resolved;
    const quarantine = config.unknownRecipientPolicy === "quarantine";
    const senderDomain = inbound.from.address.split("@")[1];
    const domainsOf = (list) => [...new Set(list.map((address) => address.split("@")[1]))].slice(0, 10);
    if (reserved.length) {
      await audit.record({ action: "MAIL_INBOUND_RESERVED_ADDRESS_DISCARDED", targetType: "webhook_event", targetId: job.webhookEventId, outcome: "DENIED", metadata: { discardedCount: reserved.length, domains: domainsOf(reserved), providerEmailId, senderDomain, delivering: local.length > 0 } });
    }
    if (domainHeld.length) {
      await audit.record({ action: "MAIL_INBOUND_DOMAIN_NOT_RECEIVING", targetType: "webhook_event", targetId: job.webhookEventId, outcome: "DENIED", metadata: { heldCount: domainHeld.length, domains: domainsOf(domainHeld), providerEmailId, senderDomain, delivering: local.length > 0 } });
    }
    let held = null;
    if (unknown.length && quarantine && local.length && !isHoldJob) held = await holdUnknownRecipients({ job, providerEmailId, unknown });
    if (unknown.length) {
      await audit.record({
        action: quarantine ? "MAIL_INBOUND_UNKNOWN_RECIPIENT_QUARANTINED" : "MAIL_INBOUND_UNKNOWN_RECIPIENT_REJECTED",
        targetType: "webhook_event",
        targetId: job.webhookEventId,
        outcome: "DENIED",
        metadata: { unknownCount: unknown.length, domains: domainsOf(unknown), providerEmailId, senderDomain, mixed: local.length > 0, ...(held ? { heldJobId: held.id } : {}) },
      });
    }
    if (!local.length) {
      if (unknown.length && quarantine) throw new PipelineError("INBOUND_UNKNOWN_RECIPIENT_QUARANTINED", "no provisioned recipient; held for operator review", { retryable: false });
      // Mail for one of our domains that is not receiving (suspended, or
      // receiving disabled) is never counted as processed: FAILED and
      // requeueable once the domain receives again.
      if (domainHeld.length) throw new PipelineError("INBOUND_DOMAIN_NOT_RECEIVING", "recipient domain is not receiving; held for operator review", { retryable: false });
      return { delivered: 0, unknown: unknown.length, ...(reserved.length ? { discardedReserved: reserved.length } : {}) };
    }
    const finish = (result) => {
      // A hold job that still has unknown recipients keeps holding them.
      if (isHoldJob && quarantine && unknown.length) throw new PipelineError("INBOUND_UNKNOWN_RECIPIENT_QUARANTINED", "some recipients are still not provisioned; held for operator review", { retryable: false });
      return { ...result, ...(held ? { heldUnknown: unknown.length } : {}), ...(domainHeld.length ? { domainHeld: domainHeld.length } : {}), ...(reserved.length ? { discardedReserved: reserved.length } : {}) };
    };

    // Sender authentication: provider-verified results only.
    const assessment = assessSenderAuthentication(inbound, { settings: senderAuth, internalDomains: domains });
    if (assessment.warn || assessment.quarantineReason) {
      await audit.record({ action: assessment.quarantineReason ? "MAIL_INBOUND_AUTH_QUARANTINED" : "MAIL_INBOUND_AUTH_WARNING", targetType: "webhook_event", targetId: job.webhookEventId, outcome: assessment.quarantineReason ? "DENIED" : "SUCCESS", metadata: { verdict: assessment.verdict, reasons: assessment.reasons, source: assessment.source, senderDomain: assessment.fromDomain, providerEmailId } });
    }

    const rfcMessageId = normalizeMessageId(inbound.rfcMessageId) || `<resend-${providerEmailId.replace(/[^A-Za-z0-9_-]/g, "")}@inbound.cosmicforge.invalid>`;
    // Provider echoes of our own mixed-recipient sends: no second copy.
    const echoes = await providerEchoes({ inbound, rfcMessageId, local, job, providerEmailId });
    if (echoes.size) {
      for (const [mailboxId, echo] of echoes) {
        await audit.record({ action: "MAIL_INBOUND_PROVIDER_ECHO_DEDUPED", targetType: "message", targetId: echo.sourceId, mailboxId, metadata: { via: echo.via, providerEmailId } });
      }
      local = local.filter((target) => !echoes.has(target.mailboxId));
      if (!local.length) return finish({ delivered: 0, unknown: unknown.length, duplicate: true, echo: echoes.size });
    }
    // Replays (webhook retry, reconciliation) of an email every mailbox
    // already has: nothing to store. Checked before any object is written.
    const existingCopies = await client.mailMessage.count({ where: { mailboxId: { in: local.map((target) => target.mailboxId) }, rfcMessageId } });
    if (existingCopies >= local.length) return finish({ delivered: 0, unknown: unknown.length, duplicate: true });

    // Objects written by this job; removed again if no mailbox copy ends up
    // referencing them (duplicate race, quota rejection or a failure).
    const writtenKeys = [];
    let result;
    try {
      result = await deliver({ job, inbound, providerEmailId, local, unknown, domains, assessment, rfcMessageId, writtenKeys });
    } catch (error) {
      await discardUnreferenced(writtenKeys);
      throw error;
    }
    return finish(result);
  }

  // Quarantine policy, mixed message: the unknown recipients are held in
  // their own job (restricted to them). It runs once, finds them still
  // unknown and ends FAILED(INBOUND_UNKNOWN_RECIPIENT_QUARANTINED), exactly
  // like an all-unknown message; an operator requeues it after provisioning.
  // Idempotent per provider email (webhook retries / reconciliation).
  async function holdUnknownRecipients({ job, providerEmailId, unknown }) {
    if (!jobs) return null;
    const { job: holdJob } = await jobs.enqueue(null, {
      queue: "INBOUND",
      kind: "PROCESS_INBOUND",
      idempotencyKey: `inbound:unknown-hold:${providerEmailId}`.slice(0, 160),
      payload: { providerEmailId, to: unknown.slice(0, 100), onlyRecipients: unknown.slice(0, 100), source: UNKNOWN_HOLD_SOURCE, heldFromJobId: job.id || null },
      maxAttempts: config.worker?.maxAttempts || 6,
    }).catch(async (error) => {
      if (error?.code !== "P2002") throw error;
      return { job: await client.mailOutboxJob.findUnique({ where: { idempotencyKey: `inbound:unknown-hold:${providerEmailId}`.slice(0, 160) } }) };
    });
    return holdJob;
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
    // Gap 5: through the durable deletion queue when attached (migration 37);
    // the inline cleanup below otherwise.
    const queued = store.discardObjects ? await store.discardObjects(keys, { purpose: "INBOUND", reason: "INBOUND_ORPHAN_CLEANUP", sourceType: "inbound" }) : null;
    if (queued) return queued.removed;
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
          // Retryable (e.g. ATTACHMENT_URL_EXPIRED: the retry re-lists the
          // attachments with fresh signed links) - except on the job's final
          // attempt: the message is then delivered with this attachment
          // recorded as failed instead of dead-lettering the whole email.
          if (error.kind === "RETRYABLE" && !finalAttempt(job)) throw new PipelineError("ATTACHMENT_DOWNLOAD_RETRY", "attachment download failed", { retryable: true });
          storedAttachments.push({ meta: attachment, failed: true, reason: error.code === "ATTACHMENT_TOO_LARGE" ? "POLICY_SIZE_LIMIT" : String(error.code || "DOWNLOAD_FAILED").slice(0, 64) });
          if (error.kind === "RETRYABLE") await audit.record({ action: "MAIL_INBOUND_ATTACHMENT_GIVEN_UP", targetType: "webhook_event", targetId: job.webhookEventId, outcome: "FAILURE", metadata: { providerEmailId, code: String(error.code || "RETRYABLE").slice(0, 64), attempt: job.attemptCount } });
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

module.exports = { createInboundProcessor, PipelineError, domainReceives, UNKNOWN_HOLD_SOURCE };
