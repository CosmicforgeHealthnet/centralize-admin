"use strict";

// Outbound dispatch (job kind SEND_MESSAGE).
//
// Recipient selection (spec 11.8, MAIL_MIXED_RECIPIENT_MODE; full reasoning
// in docs/cosmicforge-mail-mixed-recipients.md):
// - Internal recipients always get exactly one local copy at queue time
//   (INTERNAL_DELIVERED, compose.service.js). That status is never changed
//   by dispatch or by provider events.
// - Resend builds the visible To/Cc headers from its to/cc fields and has no
//   documented way to separate the SMTP envelope from the header recipients:
//   every address in to/cc/bcc is also delivered to.
// - "external-only" (default until the receiving cutover is approved): only
//   PENDING (external) recipients are given to the provider, so external
//   recipients see only the external To/Cc (Reply-All misses internal
//   people). Resend requires `to`: with no external To, external CC are
//   promoted to `to`; with only external BCC, each BCC recipient gets an
//   individual request (`to` = that recipient).
// - "full-headers": the request carries the complete visible To and Cc
//   (internal + external, original types) and external BCC in `bcc`, so every
//   recipient sees the same To/Cc (RFC 5322 3.6.3) and no Bcc header. The
//   provider therefore also delivers to internal addresses via our MX: those
//   echoes are dropped by the inbound pipeline using the signed
//   X-CosmicForge-Origin header (security/origin-header.js) and Message-ID /
//   provider Message-ID aliases. Internal BCC are never given to the provider.
//   With no visible To, Cc are promoted to `to` (Resend requires it); with no
//   visible To/Cc, each external BCC gets an individual request as above.
//   When internal recipients are in the visible headers, external BCC are
//   ALWAYS sent as individual requests (re-audit fix 5): the main request's
//   delivery events cannot tell an external BCC from the internal echo, while
//   a single-recipient request is attributable (trade-off: such a BCC
//   recipient sees itself as To, as in external-only). A main request whose
//   visible To/Cc are all internal is not sent at all.
//   Org quota checks and usage count only the external recipients of a batch
//   (`batch.internal` rows are delivered locally, re-audit fix 4).
//   Before the receiving cutover this mode would deliver a duplicate copy to
//   the legacy mail system: it stays off until approved.
// - The plan (including the mode and the origin header value) is persisted at
//   the first attempt, so a later mode/key change never alters a payload.
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
// - The emergency stop / rollout halt and the org quota are re-checked before
//   EVERY batch's provider call: a stop raised mid-send defers the remaining
//   batches (already accepted batches stay accepted).
//
// Lease fencing (spec 17/20):
// - Every plan/payload write, including the acceptance transaction, is fenced
//   by the job's current lease token (jobs/mail-job.repository.js
//   writeJobPayload). A run whose lease was lost (worker heartbeat or a fenced
//   write) stops before its next provider call and never overwrites the newer
//   run's plan. A provider acceptance recorded by a stale run is rolled back;
//   the newer run replays the same Idempotency-Key and records it.
//
// Terminal failures: the worker runs onTerminalFailure (FAILED job) and
// onDeadLetter (exhausted job). Both apply the same ambiguity rules, so mail
// never stays QUEUED and a batch that may have been accepted becomes
// OUTCOME_UNKNOWN, never FAILED.
//
// MAIL_SENDING_ENABLED=false holds queued mail (defer, no attempt consumed,
// code MAIL_SENDING_DISABLED); it never exhausts or fails the job.

const { MailProviderError } = require("../adapters/mail-provider.contract");
const { quotaDeferSeconds } = require("../ops/provider-quota.service");
const { PipelineError } = require("./inbound.processor");
const policy = require("../authz/mail.policy");
const { externalSendBlockReason, SEND_BLOCK_REASONS } = require("../authz/sending-gate");
const { purposeForMailbox } = require("../ops/runtime-controls");
const { aggregateMessageStatus, createDeliveryEventApplier, recordProviderMessageId } = require("./delivery-event.processor");
const { originHeaderFromConfig, ORIGIN_HEADER } = require("../security/origin-header");
const { writeJobPayload, leaseLostError, correlationIdOf } = require("../jobs/mail-job.repository");

function party(recipient) {
  return { address: recipient.address, name: recipient.name };
}

// Deterministic batch plan. external-only: built only from PENDING
// (external) recipients. full-headers: visible To/Cc of every status
// (internal rows stay INTERNAL_DELIVERED; status updates only ever touch
// PENDING rows) plus external BCC; internal BCC never reach the provider.
function buildDeliveryPlan(recipients, { mode = "external-only", origin = null } = {}) {
  const pending = recipients.filter((recipient) => recipient.status === "PENDING");
  const ids = (list) => list.map((recipient) => recipient.id);
  if (mode === "full-headers" && origin && pending.length) {
    const visible = recipients.filter((recipient) => recipient.type !== "BCC" && (recipient.status === "PENDING" || recipient.status === "INTERNAL_DELIVERED"));
    const to = visible.filter((recipient) => recipient.type === "TO");
    const cc = visible.filter((recipient) => recipient.type === "CC");
    const bcc = pending.filter((recipient) => recipient.type === "BCC");
    const internal = ids(visible.filter((recipient) => recipient.status === "INTERNAL_DELIVERED"));
    // The origin header is only needed when the provider will echo to us.
    const meta = { fullHeaders: true, internal, ...(internal.length ? { origin } : {}) };
    const individual = (list) => list.map((recipient) => ({ to: [recipient.id], cc: [], bcc: [], individualBcc: true, fullHeaders: true, internal: [] }));
    // Main request carries external BCC only when no internal echo exists.
    const mainBcc = internal.length ? [] : ids(bcc);
    const extra = internal.length ? individual(bcc) : [];
    // A main request with no external To/Cc would only echo to our own MX:
    // skip it (the external BCC still get their individual requests).
    const externalVisible = visible.some((recipient) => recipient.status === "PENDING");
    if (!externalVisible && internal.length) return extra;
    if (to.length) return [{ to: ids(to), cc: ids(cc), bcc: mainBcc, ...meta }, ...extra];
    if (cc.length) return [{ to: ids(cc), cc: [], bcc: mainBcc, promotedCc: true, ...meta }, ...extra];
    // No visible To/Cc at all: individual BCC requests, as in external-only.
    return individual(bcc);
  }
  const to = pending.filter((recipient) => recipient.type === "TO");
  const cc = pending.filter((recipient) => recipient.type === "CC");
  const bcc = pending.filter((recipient) => recipient.type === "BCC");
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

function createOutboundProcessor({ client, config, adapter, store, audit, notifications, runtime = null, usage = null, forwarding = null, features = null, clock = () => new Date() }) {
  const windowMs = (config.reconciliation?.idempotencyWindowHours || 23) * 3600 * 1000;
  const deliveryEvents = createDeliveryEventApplier({ client, audit, notifications, features });
  const originHeader = originHeaderFromConfig(config);
  // GAP 8: config validation already refused full-headers without a key;
  // a missing key here (defensive) falls back to external-only.
  const fullHeaders = config.mixedRecipients?.mode === "full-headers" && originHeader.available;

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

  // Fenced by lease token; throws MAIL_JOB_LEASE_LOST (no write) when this
  // run no longer holds the job.
  async function savePlan(job, plan, db = client) {
    const payload = { ...(job.payload || {}), plan };
    await writeJobPayload(db, job, payload);
    job.payload = payload;
  }

  function assertLeaseHeld(job) {
    if (job.lease?.lost) throw leaseLostError(job);
  }

  // Correlation for audits/logs (never secrets): job id, request id of the
  // send, and the batch's provider Idempotency-Key reference.
  function correlation(job, index = null) {
    return { jobId: job.id || null, correlationId: correlationIdOf(job), ...(index != null && job.idempotencyKey ? { idempotencyRef: `${job.idempotencyKey}:b${index}` } : {}) };
  }

  function auditContext(job) {
    const requestId = correlationIdOf(job);
    return requestId ? { requestId } : {};
  }

  async function haltFor(message, purpose) {
    return runtime ? runtime.haltReason(purpose, { organizationId: message.mailbox?.organizationId, mailboxId: message.mailboxId, senderAddressId: message.senderAddressId, adminUserId: message.sentByAdminUserId }) : null;
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

  // Spec 11.6 (re-audit 7a): a provider quota defer can hold mail as Queued
  // until the next daily/monthly reset. The wait is stored on the job payload
  // (`quotaWait`, read by the message status API) and the sender is told ONCE
  // per job (an alert, never the suppressible NEW_MAIL kind).
  async function noteQuotaWait(job, message, error) {
    const resetAt = new Date(error.quota.resetAt).toISOString();
    const previous = job.payload?.quotaWait || null;
    const quotaWait = { kind: error.quota.kind, resetAt, since: previous?.since || clock().toISOString(), notifiedAt: previous?.notifiedAt || null };
    const notify = !quotaWait.notifiedAt && Boolean(message.sentByAdminUserId);
    if (notify) quotaWait.notifiedAt = clock().toISOString();
    const payload = { ...(job.payload || {}), quotaWait };
    await writeJobPayload(client, job, payload);
    job.payload = payload;
    if (notify) {
      const until = resetAt.replace("T", " ").slice(0, 16);
      await notifications.notifyUsers([message.sentByAdminUserId], { icon: "alert", kind: "ALERT", title: "Email waiting for provider quota reset", subtitle: `Queued until ${until} UTC (${message.mailbox?.name || "your mailbox"})` }).catch(() => {});
    }
  }

  async function process(job) {
    // Hold, never consume attempts: a long sending pause must not dead-letter
    // queued mail (re-audit: it used to FAIL every recipient after ~6 tries).
    if (!config.sendingEnabled) return { defer: { seconds: 300, code: "MAIL_SENDING_DISABLED", message: "Sending is disabled (MAIL_SENDING_ENABLED=false); mail stays queued" } };
    const message = await client.mailMessage.findUnique({ where: { id: job.messageId }, include: { recipients: true, attachments: true, mailbox: true } });
    if (!message) throw new PipelineError("MESSAGE_MISSING", "message not found", { retryable: false });

    let plan = job.payload?.plan;
    if (!Array.isArray(plan)) {
      if (!message.recipients.some((recipient) => recipient.status === "PENDING")) return { skipped: true, status: message.status };
      plan = buildDeliveryPlan(message.recipients, fullHeaders ? { mode: "full-headers", origin: originHeader.sign(message.id) } : {});
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
      await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_SEND_BLOCKED_AT_DISPATCH", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "DENIED", metadata: { reason: error.code, ...correlation(job) } }, auditContext(job));
      await notifySender(message, "Email was not sent");
      throw new PipelineError(error.code, "send blocked at dispatch", { retryable: false });
    }

    // M9 kill switch: hold (never drop) queued mail while sending is stopped.
    const purpose = purposeForMailbox(message.mailbox);
    const halted = await haltFor(message, purpose);
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

    for (const [position, { batch, index }] of pendingBatches.entries()) {
      assertLeaseHeld(job);
      // A stop raised while earlier batches were being sent holds the rest.
      if (position > 0) {
        const haltedNow = await haltFor(message, purpose);
        if (haltedNow) return { defer: { seconds: 300, code: haltedNow } };
      }
      const recipientIds = [...batch.to, ...batch.cc, ...batch.bcc];
      // Internal To/Cc given to the provider in full-headers mode are
      // delivered locally: never counted against quota/usage.
      const internalIds = new Set(batch.internal || []);
      const externalCount = recipientIds.filter((id) => !internalIds.has(id)).length;
      // Org hard quota re-check before each provider call: defer, never fail.
      if (usage) {
        const quota = await usage.check(message.mailbox?.organizationId, purpose, externalCount, { includeQueued: false });
        if (!quota.allowed) return { defer: { seconds: 900, code: quota.reason || "MAIL_QUOTA_HARD_LIMIT" } };
      }
      const now = clock();
      if (batch.firstAttemptAt && now.getTime() - new Date(batch.firstAttemptAt).getTime() > windowMs) {
        // The provider no longer guarantees deduplication for this key.
        batch.outcome = "UNKNOWN";
        await savePlan(job, plan);
        await markRecipients(recipientIds, "OUTCOME_UNKNOWN", "IDEMPOTENCY_WINDOW_EXPIRED");
        await finalizeStatus(message.id);
        await audit.record({ action: "MAIL_SEND_OUTCOME_UNKNOWN", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "UNKNOWN", metadata: { batch: index, reason: "IDEMPOTENCY_WINDOW_EXPIRED", ...correlation(job, index) } }, auditContext(job));
        await notifySender(message, "Email delivery status unknown");
        continue;
      }
      if (!batch.firstAttemptAt) batch.firstAttemptAt = now.toISOString();
      // Still marked from an earlier attempt: that attempt crashed mid-call.
      if (batch.inFlight) batch.ambiguous = true;
      // Persisted before the call: a crash from here on leaves the outcome open.
      batch.inFlight = true;
      // Fenced: a lost lease throws here, before the provider call.
      await savePlan(job, plan);
      assertLeaseHeld(job);
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
        headers: batch.origin ? { ...headers, [ORIGIN_HEADER]: batch.origin } : headers,
        attachments,
      };
      let result;
      try {
        result = await adapter.sendMessage(request);
      } catch (error) {
        if (usage) await usage.record(null, { organizationId: message.mailbox?.organizationId, purpose, providerRequests: 1, rejected: error?.kind === "PERMANENT" ? externalCount : 0 }).catch(() => {});
        if (!(error instanceof MailProviderError)) throw error;
        // An earlier attempt may have been accepted: a later definitive error
        // cannot prove it was not.
        if (error.kind === "IDEMPOTENCY_CONFLICT" || (error.kind === "PERMANENT" && batch.ambiguous)) {
          batch.outcome = "UNKNOWN";
          batch.inFlight = false;
          await savePlan(job, plan);
          await markRecipients(recipientIds, "OUTCOME_UNKNOWN", error.code);
          await finalizeStatus(message.id);
          await audit.record({ action: "MAIL_SEND_OUTCOME_UNKNOWN", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "UNKNOWN", metadata: { batch: index, reason: error.code, ...correlation(job, index) } }, auditContext(job));
          await notifySender(message, "Email delivery status unknown");
          continue;
        }
        if (error.kind === "PERMANENT" || error.kind === "NOT_CONFIGURED") {
          batch.outcome = "FAILED";
          batch.inFlight = false;
          await savePlan(job, plan);
          await markRecipients(recipientIds, "FAILED", error.code);
          const status = await finalizeStatus(message.id);
          await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_SEND_FAILED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: "FAILURE", metadata: { batch: index, reason: error.code, ...correlation(job, index) } }, auditContext(job));
          if (status === "FAILED") await notifySender(message, "Email could not be sent");
          if (error.kind === "NOT_CONFIGURED") throw new PipelineError(error.code, error.message, { retryable: false });
          continue;
        }
        // Provider quota exhausted (429 daily/monthly_quota_exceeded): a
        // definitive refusal. Hold the job until the quota resets instead of
        // burning retries every hour; accepted batches stay recorded.
        const quotaWait = quotaDeferSeconds(error, clock());
        if (quotaWait) {
          batch.inFlight = false;
          // Nothing was sent: unless an earlier attempt was ambiguous, the
          // idempotency window starts again with the next real attempt (the
          // reset can be up to 24h away).
          if (!batch.ambiguous) delete batch.firstAttemptAt;
          await savePlan(job, plan);
          await noteQuotaWait(job, message, error);
          return { defer: { seconds: quotaWait, code: "PROVIDER_QUOTA_EXHAUSTED", message: `Waiting for provider ${String(error.quota.kind || "").toLowerCase()} quota reset until ${new Date(error.quota.resetAt).toISOString()}` } };
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
      // A lost lease rolls this back (fenced write throws inside the tx); the
      // newer run replays the same Idempotency-Key and records the acceptance.
      await client.$transaction(async (tx) => {
        await savePlan(job, plan, tx);
        await tx.mailMessageRecipient.updateMany({ where: { id: { in: recipientIds }, status: "PENDING" }, data: { status: "PROVIDER_ACCEPTED", providerMessageId: result.providerMessageId, lastEventAt: clock() } });
        // full-headers: internal rows the provider was also given keep
        // INTERNAL_DELIVERED; the provider id only lets delivery events know
        // the request had more than one recipient (never changes status).
        if (batch.internal?.length) await tx.mailMessageRecipient.updateMany({ where: { id: { in: batch.internal }, status: "INTERNAL_DELIVERED" }, data: { providerMessageId: result.providerMessageId } });
        await tx.mailMessage.update({ where: { id: message.id }, data: { providerMessageId: message.providerMessageId || result.providerMessageId, sentAt: message.sentAt || clock() } });
        await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: "MAIL_PROVIDER_ACCEPTED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { batch: index, recipients: externalCount, providerMessageId: result.providerMessageId, ...correlation(job, index) } }, auditContext(job), tx);
        if (usage) await usage.record(tx, { organizationId: message.mailbox?.organizationId, purpose, accepted: externalCount, providerRequests: 1, bytes: message.sizeBytes });
      });
      message.providerMessageId = message.providerMessageId || result.providerMessageId;
      message.sentAt = message.sentAt || clock();
      // Provider-assigned Message-ID, when the send response carries one
      // (Resend's POST /emails documents only `id`; webhooks carry it).
      if (result.rfcMessageId) await recordProviderMessageId({ client, features, messageId: message.id, rfcMessageId: message.rfcMessageId, providerRfcMessageId: result.rfcMessageId });
      // Events that arrived before this acceptance committed were stored
      // unmatched; apply them now (idempotent). Failure here never re-sends.
      await deliveryEvents.reapplyUnmatched(result.providerMessageId).catch(() => {});
    }
    const status = await finalizeStatus(message.id);
    return { providerMessageId: message.providerMessageId, status };
  }

  // Called when a job exhausts its attempts (onDeadLetter) or ends with a
  // non-retryable error (onTerminalFailure, e.g. ATTACHMENT_NOT_CLEAN after a
  // rescan, MESSAGE content unreadable): never claim success and never leave
  // the message QUEUED. Unresolved batches that were ever ambiguous, are
  // still marked in flight (crash), or whose last error was ambiguous become
  // OUTCOME_UNKNOWN; the rest FAILED. Recipients already resolved (accepted,
  // blocked, failed) are untouched, so a path that already cleaned up and
  // notified is a no-op here.
  async function onTerminalFailure(job, error) {
    return settleTerminal(job, error, "FAILED");
  }

  async function onDeadLetter(job, error) {
    return settleTerminal(job, error, "DEAD_LETTER");
  }

  async function settleTerminal(job, error, jobStatus) {
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
    await markRecipients(unknownIds, "OUTCOME_UNKNOWN", error?.code || jobStatus);
    await markRecipients(failedIds, "FAILED", error?.code || jobStatus);
    const status = await finalizeStatus(message.id);
    const anyUnknown = status === "OUTCOME_UNKNOWN";
    // `reason`, not `code`: the audit scrubber drops keys matching /code/.
    const metadata = { reason: error?.code || null, jobStatus, failedRecipients: failedIds.length, unknownRecipients: unknownIds.length, ...correlation(job) };
    await audit.record({ actorAdminUserId: message.sentByAdminUserId, action: anyUnknown ? "MAIL_SEND_OUTCOME_UNKNOWN" : "MAIL_SEND_FAILED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, outcome: anyUnknown ? "UNKNOWN" : "FAILURE", metadata }, auditContext(job));
    await notifySender(message, anyUnknown ? "Email delivery status unknown" : "Email could not be sent");
  }

  return { process, onDeadLetter, onTerminalFailure };
}

module.exports = { createOutboundProcessor, buildDeliveryPlan, possiblyAccepted };
