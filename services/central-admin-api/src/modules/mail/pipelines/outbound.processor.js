"use strict";

// Outbound dispatch (job kind SEND_MESSAGE).
//
// Recipient selection:
// - Only recipients still PENDING (i.e. external) are ever given to the
//   provider. Recipients delivered locally at queue time (INTERNAL_DELIVERED)
//   are never sent again, whatever their To/CC/BCC type.
// - Resend builds the visible To/Cc headers from its to/cc fields and has no
//   documented way to set them independently, so the provider envelope and
//   visible headers are the same: external recipients see only the external
//   To/Cc recipients. Internal recipients keep the full header set on their
//   own local copies (documented limitation).
// - Resend requires `to`. With no external To, external CC are promoted to
//   `to`; with only external BCC, each BCC recipient gets an individual
//   request (`to` = that recipient) so BCC recipients never see each other.
//
// Durability / idempotency:
// - The batch plan is persisted on the job at the first attempt and is never
//   recomputed, so each batch keeps an identical payload under its own stable
//   provider Idempotency-Key (`<jobKey>:b<n>`).
// - firstAttemptAt is persisted BEFORE each provider call. Resend keeps keys
//   for 24 hours; once a batch's first attempt is older than the configured
//   window (default 23h) it is never re-sent, and an unresolved batch becomes
//   OUTCOME_UNKNOWN for human review instead of risking a duplicate.
// - Each batch is marked inFlight in the plan immediately before every
//   provider call and cleared on a definitive answer; an ambiguous answer
//   sets a sticky `ambiguous` flag. A batch that dead-letters while inFlight
//   or ambiguous (timeout, crash, possibly-accepted 5xx) becomes
//   OUTCOME_UNKNOWN, never FAILED, so the sender is not told to re-send.
// - Dispatch is driven by unresolved batches in the persisted plan, not by
//   message.status: a delivery event on one batch never stops the others.
// - A 409 invalid_idempotent_request (same key, different payload) means an
//   earlier request may have been sent: OUTCOME_UNKNOWN, not FAILED.
//
// Authorization at dispatch time:
// - Before every provider call the sender, membership, sender identity,
//   mailbox, address and domain are re-checked. Revocation, offboarding,
//   suspension or a domain kill-switch cancel batches not yet accepted by the
//   provider (FAILED, reason recorded). Mail already accepted cannot be recalled.

const { MailProviderError } = require("../adapters/mail-provider.contract");
const { PipelineError } = require("./inbound.processor");
const policy = require("../authz/mail.policy");
const { externalSendBlockReason, SEND_BLOCK_REASONS } = require("../authz/sending-gate");
const { purposeForMailbox } = require("../ops/runtime-controls");
const { aggregateMessageStatus, createDeliveryEventApplier } = require("./delivery-event.processor");

function party(recipient) {
  return { address: recipient.address, name: recipient.name };
}

// Deterministic batch plan built only from PENDING (external) recipients.
function buildDeliveryPlan(recipients) {
  const pending = recipients.filter((recipient) => recipient.status === "PENDING");
  const to = pending.filter((recipient) => recipient.type === "TO");
  const cc = pending.filter((recipient) => recipient.type === "CC");
  const bcc = pending.filter((recipient) => recipient.type === "BCC");
  const ids = (list) => list.map((recipient) => recipient.id);
  if (to.length) return [{ to: ids(to), cc: ids(cc), bcc: ids(bcc) }];
  if (cc.length) return [{ to: ids(cc), cc: [], bcc: ids(bcc), promotedCc: true }];
  return bcc.map((recipient) => ({ to: [recipient.id], cc: [], bcc: [], individualBcc: true }));
}

function providerHttpStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const match = /_HTTP_(\d{3})$/.exec(String(error?.code || ""));
  return match ? Number(match[1]) : null;
}

// Could the provider have accepted the request that produced this error?
// Resend classifies 429 and 5xx as RETRYABLE. A 429 is a definitive refusal.
// A 5xx (or a non-idempotency 409 such as a concurrent request with the same
// key) can be returned after the provider already accepted the email, so it
// is treated conservatively as possibly-accepted. Unknown statuses likewise.
function possiblyAccepted(error) {
  if (error?.kind === "AMBIGUOUS") return true;
  if (error?.kind !== "RETRYABLE") return false;
  const status = providerHttpStatus(error);
  if (status === 429) return false;
  if (status !== null && status >= 400 && status < 500 && status !== 409) return false;
  return true;
}

class DispatchBlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.code = reason;
  }
}

function createOutboundProcessor({ client, config, adapter, store, audit, notifications, runtime = null, usage = null, forwarding = null, clock = () => new Date() }) {
  const windowMs = (config.reconciliation?.idempotencyWindowHours || 23) * 3600 * 1000;
  const deliveryEvents = createDeliveryEventApplier({ client, audit, notifications });

  async function assertStillAuthorized(message) {
    if (!message.sentByAdminUserId || !message.senderAddressId) throw new DispatchBlockedError("SENDER_UNKNOWN");
    const sender = await client.adminUser.findUnique({ where: { id: message.sentByAdminUserId }, select: { id: true, status: true, tier: true } });
    if (!sender || sender.status !== "ACTIVE") throw new DispatchBlockedError("SENDER_NOT_ACTIVE");
    const access = await policy.resolveMailboxAccess(client, sender, message.mailboxId, { now: clock() });
    if (!access || access.viaBreakGlass || !access.canSend) throw new DispatchBlockedError("SENDER_MEMBERSHIP_REVOKED");
    const identities = await policy.listSenderIdentities(client, sender, access, { now: clock() });
    if (!identities.some((identity) => identity.addressId === message.senderAddressId)) throw new DispatchBlockedError("SENDER_IDENTITY_REVOKED");
    const address = await client.mailAddress.findUnique({ where: { id: message.senderAddressId }, include: { domain: { include: { organization: { select: { id: true, slug: true } } } } } });
    if (!address || address.status !== "ACTIVE") throw new DispatchBlockedError("SENDER_ADDRESS_NOT_ACTIVE");
    // Same gate as enqueue time: empty/changed allowlist, unconfigured
    // provider or a disabled/suspended domain cancel queued external mail.
    const blocked = externalSendBlockReason({ config, providerReady: () => adapter.name !== "unconfigured", domain: address.domain });
    if (blocked && blocked !== SEND_BLOCK_REASONS.SENDING_DISABLED) throw new DispatchBlockedError(blocked);
    // Auto-forwarded copies stop as soon as their rule is disabled.
    if (forwarding && String(message.idempotencyKey || "").startsWith("fwd:") && !(await forwarding.ruleStillActive(message.idempotencyKey))) throw new DispatchBlockedError("FORWARDING_RULE_DISABLED");
  }

  async function savePlan(job, plan) {
    const payload = { ...(job.payload || {}), plan };
    await client.mailOutboxJob.update({ where: { id: job.id }, data: { payload } });
    job.payload = payload;
  }

  // Same derivation as delivery events, so dispatch never regresses an
  // event-derived state (BOUNCED, DELIVERED, ...).
  async function finalizeStatus(messageId, extra = {}) {
    const message = await client.mailMessage.findUnique({ where: { id: messageId }, select: { status: true, recipients: { select: { status: true } } } });
    const status = aggregateMessageStatus(message.recipients, message.status);
    if (status !== message.status || Object.keys(extra).length) await client.mailMessage.update({ where: { id: messageId }, data: { status, lastStatusAt: clock(), ...extra } });
    return status;
  }

  async function markRecipients(ids, status, detail, data = {}) {
    if (!ids.length) return;
    await client.mailMessageRecipient.updateMany({ where: { id: { in: ids }, status: "PENDING" }, data: { status, lastEventAt: clock(), lastEventDetail: detail ? String(detail).slice(0, 500) : null, ...data } });
  }

  async function notifySender(message, title) {
    if (message.sentByAdminUserId) await notifications.notifyUsers([message.sentByAdminUserId], { icon: title.includes("unknown") ? "alert" : "xcircle", title, subtitle: `From ${message.mailbox?.name || "your mailbox"}` });
  }

  async function process(job) {
    if (!config.sendingEnabled) throw new PipelineError("MAIL_SENDING_DISABLED", "sending disabled", { retryable: true });
    const message = await client.mailMessage.findUnique({ where: { id: job.messageId }, include: { recipients: true, attachments: true, mailbox: true } });
    if (!message) throw new PipelineError("MESSAGE_MISSING", "message not found", { retryable: false });

    let plan = job.payload?.plan;
    if (!Array.isArray(plan)) {
      if (!message.recipients.some((recipient) => recipient.status === "PENDING")) return { skipped: true, status: message.status };
      plan = buildDeliveryPlan(message.recipients);
      await savePlan(job, plan);
    }
    if (!plan.length) {
      await finalizeStatus(message.id);
      return { skipped: true, reason: "NO_EXTERNAL_RECIPIENTS" };
    }

    const byId = new Map(message.recipients.map((recipient) => [recipient.id, recipient]));
    const pendingBatches = plan.map((batch, index) => ({ batch, index })).filter(({ batch }) => !batch.providerMessageId && !batch.outcome);
    if (!pendingBatches.length) {
      await finalizeStatus(message.id);
      return { skipped: true, reason: "ALL_BATCHES_RESOLVED" };
    }

    // Revocation / suspension / kill-switch: cancel unsent batches.
    try {
      await assertStillAuthorized(message);
    } catch (error) {
      if (!(error instanceof DispatchBlockedError)) throw error;
      for (const { batch } of pendingBatches) batch.outcome = "BLOCKED";
      await savePlan(job, plan);
      await markRecipients(pendingBatches.flatMap(({ batch }) => [...batch.to, ...batch.cc, ...batch.bcc]), "FAILED", error.code);
      await finalizeStatus(message.id);
      await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_SEND_BLOCKED_AT_DISPATCH", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "DENIED", metadata: { reason: error.code } });
      await notifySender(message, "Email was not sent");
      throw new PipelineError(error.code, "send blocked at dispatch", { retryable: false });
    }

    // M9 kill switch: hold (never drop) queued mail while sending is stopped.
    const purpose = purposeForMailbox(message.mailbox);
    const halted = runtime ? await runtime.haltReason(purpose, { organizationId: message.mailbox?.organizationId, mailboxId: message.mailboxId, senderAddressId: message.senderAddressId, adminUserId: message.sentByAdminUserId }) : null;
    if (halted) return { defer: { seconds: 300, code: halted } };

    const body = await store.readBody(message);
    const attachments = [];
    for (const attachment of message.attachments) {
      if (attachment.quarantined || attachment.scanStatus !== "CLEAN") throw new PipelineError("ATTACHMENT_NOT_CLEAN", "attachment not clean", { retryable: false });
      attachments.push({ filename: attachment.filename, contentType: attachment.contentType, content: await store.readAttachmentContent(attachment), contentId: attachment.contentId, inline: attachment.isInline });
    }
    const headers = {
      "Message-ID": message.rfcMessageId,
      ...(message.inReplyTo ? { "In-Reply-To": message.inReplyTo } : {}),
      ...(message.references?.length ? { References: message.references.join(" ") } : {}),
      ...(forwarding ? forwarding.forwardHeaders(message.idempotencyKey) : {}),
    };

    for (const { batch, index } of pendingBatches) {
      const recipientIds = [...batch.to, ...batch.cc, ...batch.bcc];
      // Org hard quota re-check before each provider call: defer, never fail.
      if (usage) {
        const quota = await usage.check(message.mailbox?.organizationId, purpose, recipientIds.length, { includeQueued: false });
        if (!quota.allowed) return { defer: { seconds: 900, code: quota.reason || "MAIL_QUOTA_HARD_LIMIT" } };
      }
      const now = clock();
      if (batch.firstAttemptAt && now.getTime() - new Date(batch.firstAttemptAt).getTime() > windowMs) {
        // The provider no longer guarantees deduplication for this key.
        batch.outcome = "UNKNOWN";
        await savePlan(job, plan);
        await markRecipients(recipientIds, "OUTCOME_UNKNOWN", "IDEMPOTENCY_WINDOW_EXPIRED");
        await finalizeStatus(message.id);
        await audit.record({ action: "MAIL_SEND_OUTCOME_UNKNOWN", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "UNKNOWN", metadata: { batch: index, reason: "IDEMPOTENCY_WINDOW_EXPIRED" } });
        await notifySender(message, "Email delivery status unknown");
        continue;
      }
      if (!batch.firstAttemptAt) batch.firstAttemptAt = now.toISOString();
      // Still marked from an earlier attempt: that attempt crashed mid-call.
      if (batch.inFlight) batch.ambiguous = true;
      // Persisted before the call: a crash from here on leaves the outcome open.
      batch.inFlight = true;
      await savePlan(job, plan);
      const request = {
        idempotencyKey: `${job.idempotencyKey}:b${index}`,
        from: { address: message.fromAddress, name: message.fromName },
        replyTo: message.replyTo,
        to: batch.to.map((id) => party(byId.get(id))),
        cc: batch.cc.map((id) => party(byId.get(id))),
        bcc: batch.bcc.map((id) => party(byId.get(id))),
        subject: message.subject,
        html: body.html,
        text: body.text,
        headers,
        attachments,
      };
      let result;
      try {
        result = await adapter.sendMessage(request);
      } catch (error) {
        if (usage) await usage.record(null, { organizationId: message.mailbox?.organizationId, purpose, providerRequests: 1, rejected: error?.kind === "PERMANENT" ? recipientIds.length : 0 }).catch(() => {});
        if (!(error instanceof MailProviderError)) throw error;
        // An earlier attempt may have been accepted: a later definitive error
        // cannot prove it was not.
        if (error.kind === "IDEMPOTENCY_CONFLICT" || (error.kind === "PERMANENT" && batch.ambiguous)) {
          batch.outcome = "UNKNOWN";
          batch.inFlight = false;
          await savePlan(job, plan);
          await markRecipients(recipientIds, "OUTCOME_UNKNOWN", error.code);
          await finalizeStatus(message.id);
          await audit.record({ action: "MAIL_SEND_OUTCOME_UNKNOWN", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "UNKNOWN", metadata: { batch: index, reason: error.code } });
          await notifySender(message, "Email delivery status unknown");
          continue;
        }
        if (error.kind === "PERMANENT" || error.kind === "NOT_CONFIGURED") {
          batch.outcome = "FAILED";
          batch.inFlight = false;
          await savePlan(job, plan);
          await markRecipients(recipientIds, "FAILED", error.code);
          const status = await finalizeStatus(message.id);
          await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_SEND_FAILED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "FAILURE", metadata: { batch: index, reason: error.code } });
          if (status === "FAILED") await notifySender(message, "Email could not be sent");
          if (error.kind === "NOT_CONFIGURED") throw new PipelineError(error.code, error.message, { retryable: false });
          continue;
        }
        if (possiblyAccepted(error)) batch.ambiguous = true;
        batch.inFlight = false;
        await savePlan(job, plan);
        const pipelineError = new PipelineError(error.code, error.message, { retryable: true });
        pipelineError.reconcile = error.kind === "AMBIGUOUS";
        pipelineError.retryAfterSeconds = error.retryAfterSeconds;
        throw pipelineError;
      }
      batch.providerMessageId = result.providerMessageId;
      batch.acceptedAt = clock().toISOString();
      batch.inFlight = false;
      await client.$transaction(async (tx) => {
        await tx.mailOutboxJob.update({ where: { id: job.id }, data: { payload: { ...(job.payload || {}), plan } } });
        await tx.mailMessageRecipient.updateMany({ where: { id: { in: recipientIds }, status: "PENDING" }, data: { status: "PROVIDER_ACCEPTED", providerMessageId: result.providerMessageId, lastEventAt: clock() } });
        await tx.mailMessage.update({ where: { id: message.id }, data: { providerMessageId: message.providerMessageId || result.providerMessageId, sentAt: message.sentAt || clock() } });
        await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_PROVIDER_ACCEPTED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { batch: index, recipients: recipientIds.length } }, {}, tx);
        if (usage) await usage.record(tx, { organizationId: message.mailbox?.organizationId, purpose, accepted: recipientIds.length, providerRequests: 1, bytes: message.sizeBytes });
      });
      message.providerMessageId = message.providerMessageId || result.providerMessageId;
      message.sentAt = message.sentAt || clock();
      // Events that arrived before this acceptance committed were stored
      // unmatched; apply them now (idempotent). Failure here never re-sends.
      await deliveryEvents.reapplyUnmatched(result.providerMessageId).catch(() => {});
    }
    const status = await finalizeStatus(message.id);
    return { providerMessageId: message.providerMessageId, status };
  }

  // Called when a job exhausts its attempts: never claim success. Unresolved
  // batches that were ever ambiguous, are still marked in flight (crash), or
  // whose last error was ambiguous become OUTCOME_UNKNOWN; the rest FAILED.
  async function onDeadLetter(job, error) {
    if (!job.messageId) return;
    const message = await client.mailMessage.findUnique({ where: { id: job.messageId }, include: { mailbox: true, recipients: true } });
    if (!message) return;
    const fresh = await client.mailOutboxJob.findUnique({ where: { id: job.id } });
    const plan = Array.isArray(fresh?.payload?.plan) ? fresh.payload.plan : null;
    const pending = message.recipients.filter((recipient) => recipient.status === "PENDING");
    if (!pending.length) return;
    const lastAmbiguous = Boolean(error?.reconcile) || error?.code === "LEASE_EXPIRED";
    // Recipients whose batch may have reached the provider without an answer.
    const unresolved = plan ? plan.filter((batch) => batch.firstAttemptAt && !batch.providerMessageId && !batch.outcome) : [];
    const uncertain = new Set(unresolved.filter((batch) => batch.ambiguous || batch.inFlight || lastAmbiguous).flatMap((batch) => [...batch.to, ...batch.cc, ...batch.bcc]));
    const unknownIds = pending.filter((recipient) => uncertain.has(recipient.id)).map((recipient) => recipient.id);
    const failedIds = pending.map((recipient) => recipient.id).filter((id) => !unknownIds.includes(id));
    await markRecipients(unknownIds, "OUTCOME_UNKNOWN", error?.code || "DEAD_LETTER");
    await markRecipients(failedIds, "FAILED", error?.code || "DEAD_LETTER");
    const status = await finalizeStatus(message.id);
    await audit.record({ action: status === "OUTCOME_UNKNOWN" ? "MAIL_SEND_OUTCOME_UNKNOWN" : "MAIL_SEND_FAILED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: status === "OUTCOME_UNKNOWN" ? "UNKNOWN" : "FAILURE", metadata: { code: error?.code || null } });
    await notifySender(message, status === "OUTCOME_UNKNOWN" ? "Email delivery status unknown" : "Email could not be sent");
  }

  return { process, onDeadLetter };
}

module.exports = { createOutboundProcessor, buildDeliveryPlan, possiblyAccepted };
