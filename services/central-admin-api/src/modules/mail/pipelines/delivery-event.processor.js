"use strict";

// Delivery events (job kind PROCESS_DELIVERY_EVENT). Updates per-recipient and
// per-message status from provider evidence. Status never regresses from a
// terminal state, and bounces/complaints create brand-scoped suppressions.
//
// Recipient attribution:
// - Events are matched to the provider request (batch) by provider message id;
//   only recipients of that batch can change.
// - DELIVERED / DELAYED apply only to recipients the event names (to/cc/bcc
//   when present). Resend's `to` lists only the To addresses, so unnamed Cc /
//   Bcc recipients stay "Accepted by provider" rather than being guessed.
// - BOUNCED / COMPLAINED / FAILED apply to the named recipients only when the
//   event really singles them out (a single-recipient batch, or a named subset
//   that is not just the echoed To list). Otherwise the event is recorded on
//   the message as unattributed and no suppression is created. Soft bounces
//   update status but never suppress the address.
// - Events that arrive before acceptance commits are stored unmatched and are
//   re-applied once the batch's provider id is known (reapplyUnmatched).
// - Open/click tracking events are never recorded for mailbox mail.
// - Internal recipients (INTERNAL_DELIVERED, one local copy at queue time)
//   never change status from provider evidence. In MAIL_MIXED_RECIPIENT_MODE
//   =full-headers the provider is also given internal To/Cc and delivers to
//   our MX; an event naming only internal addresses is recorded for ops
//   (message_id null, detail.internalRecipient) and changes nothing, so an
//   internal recipient is never "Delivered to receiving server" nor FAILED.
//   Status derivation ignores internal rows, so a partial provider failure
//   is judged on external recipients only.
//   An event whose address list is just the echo of the request's To list
//   and that list contains internal addresses is not evidence for the
//   external To rows either (re-audit fix 5): it may be our own MX accepting
//   the internal copy. It is recorded as unattributed and changes no status;
//   DELIVERED/DELAYED apply only when an external address is singled out.
//   External BCC next to internal recipients are sent as individual requests
//   (outbound.processor.js), so they stay attributable.
// - The provider's own Message-ID (`message_id` in email webhooks) is stored
//   as an alias (mail_message_provider_ids, migration 37) when it differs
//   from ours, for threading and echo dedup. Before migration 37 it is not
//   stored and everything else works unchanged.

const { normalizeAddress } = require("../security/address.util");
const { normalizeMessageId } = require("../security/header-safety");

const EVENT_MAP = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.delivery_delayed": "DELIVERY_DELAYED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.failed": "FAILED",
  // No SUPPRESSED enum value: stored as FAILED with detail { suppressed: true }.
  "email.suppressed": "FAILED",
  "email.opened": "OPENED",
  "email.clicked": "CLICKED",
};
const TRACKING_TYPES = new Set(["OPENED", "CLICKED"]);
const FAILURE_TYPES = new Set(["BOUNCED", "COMPLAINED", "FAILED"]);
const RECIPIENT_STATUS = { DELIVERED: "DELIVERED", DELIVERY_DELAYED: "DELAYED", BOUNCED: "BOUNCED", COMPLAINED: "COMPLAINED", FAILED: "FAILED" };
const RANK = { PENDING: 0, OUTCOME_UNKNOWN: 0.5, PROVIDER_ACCEPTED: 1, DELAYED: 2, DELIVERED: 3, FAILED: 4, BOUNCED: 5, COMPLAINED: 6, INTERNAL_DELIVERED: 3 };
const ACCEPTED_LEVEL = new Set(["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED"]);

// Single message-status derivation shared by dispatch and delivery events.
// INTERNAL_DELIVERED rows are header participants, not delivery tracking.
function aggregateMessageStatus(recipients, current) {
  const external = recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED");
  if (!external.length) return current;
  const statuses = external.map((recipient) => recipient.status);
  if (statuses.includes("COMPLAINED")) return "COMPLAINED";
  if (statuses.includes("BOUNCED")) return "BOUNCED";
  if (statuses.includes("OUTCOME_UNKNOWN")) return "OUTCOME_UNKNOWN";
  if (statuses.every((status) => status === "FAILED")) return "FAILED";
  if (statuses.every((status) => status === "DELIVERED")) return "DELIVERED";
  // Some recipients still waiting for dispatch: not finished yet.
  if (statuses.includes("PENDING")) return statuses.some((status) => ACCEPTED_LEVEL.has(status)) ? "PROVIDER_ACCEPTED" : "QUEUED";
  if (statuses.includes("DELAYED")) return "DELAYED";
  if (statuses.includes("FAILED")) return "FAILED";
  return "PROVIDER_ACCEPTED";
}

function addressList(value) {
  return (Array.isArray(value) ? value : [value]).map(normalizeAddress).filter(Boolean);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

// Recipients of the batch that the provider put in the request's `to` field.
function toFieldOf(batch) {
  const to = batch.filter((recipient) => recipient.type === "TO");
  if (to.length) return to;
  const cc = batch.filter((recipient) => recipient.type === "CC");
  return cc.length ? cc : batch;
}

// Addresses of the message's internal (locally delivered) recipients.
function internalAddresses(message) {
  return new Set(message.recipients.filter((recipient) => recipient.status === "INTERNAL_DELIVERED").map((recipient) => recipient.address));
}

// Returns { targets, unattributed, internalOnly } for one message.
function attribute(message, providerMessageId, type, named) {
  let batch = message.recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED" && recipient.providerMessageId === providerMessageId);
  if (!batch.length && message.providerMessageId === providerMessageId) batch = message.recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED" && !recipient.providerMessageId);
  // Every row the provider request addressed: in full-headers mode internal
  // To/Cc rows carry the request's provider id too (status unchanged).
  const addressed = [...message.recipients.filter((recipient) => recipient.status === "INTERNAL_DELIVERED" && recipient.providerMessageId === providerMessageId), ...batch];
  const internal = internalAddresses(message);
  // Evidence that singles out internal addresses only: ops record, no
  // status change. An event that merely echoes the request's To list
  // (Resend lists the To addresses) is not attribution and falls through.
  const echoedTo = sameSet(named, toFieldOf(addressed).map((recipient) => recipient.address));
  if (named.length && named.every((address) => internal.has(address)) && !echoedTo) return { targets: [], unattributed: false, internalOnly: true };
  const namedRecipients = batch.filter((recipient) => named.includes(recipient.address));
  if (!FAILURE_TYPES.has(type)) {
    if (echoedTo && named.some((address) => internal.has(address))) return { targets: [], unattributed: namedRecipients.length > 0 };
    return { targets: namedRecipients, unattributed: false };
  }
  if (batch.length === 1 && addressed.length === 1) return { targets: batch, unattributed: false };
  const namedAddressed = addressed.filter((recipient) => named.includes(recipient.address));
  const ambiguous = !namedRecipients.length || sameSet(namedAddressed.map((r) => r.id), toFieldOf(addressed).map((r) => r.id));
  return ambiguous ? { targets: [], unattributed: true } : { targets: namedRecipients, unattributed: false };
}

// Stores the provider-assigned Message-ID as an alias of our message when it
// differs from ours. Gated by migration 37; never throws (core paths).
async function recordProviderMessageId({ client, features, messageId, rfcMessageId, providerRfcMessageId }) {
  const alias = normalizeMessageId(providerRfcMessageId);
  if (!alias || !messageId || alias === normalizeMessageId(rfcMessageId)) return false;
  try {
    if (!features?.finalGap || !(await features.finalGap.isReady())) return false;
    const result = await client.mailMessageProviderId.createMany({ data: [{ messageId, providerRfcMessageId: alias }], skipDuplicates: true });
    return result.count > 0;
  } catch {
    return false;
  }
}

function createDeliveryEventApplier({ client, audit, notifications, features = null }) {
  async function findMessages(db, providerMessageId) {
    // A message may span several provider requests (e.g. individual BCC
    // sends); match on the per-recipient provider id as well.
    return db.mailMessage.findMany({
      where: { direction: "OUTBOUND", OR: [{ providerMessageId }, { recipients: { some: { providerMessageId } } }] },
      include: { recipients: true, mailbox: true },
    });
  }

  async function applyToMessage(event, message, ctx) {
    const { type, providerMessageId, occurredAt, named, data, suppressed } = ctx;
    return client.$transaction(async (tx) => {
      // Serializes the worker and dispatch-time re-match for one event.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mail-delivery-event:${event.id}`}))`;
      const already = await tx.mailDeliveryEvent.findFirst({ where: { webhookEventId: event.id, messageId: message.id } });
      if (already) return false;
      const opsRows = await tx.mailDeliveryEvent.findMany({ where: { webhookEventId: event.id, messageId: null }, select: { detail: true } });
      if (opsRows.some((row) => row.detail?.internalRecipient === true && row.detail?.outboundMessageId === message.id)) return false;
      const fresh = await tx.mailMessage.findUnique({ where: { id: message.id }, include: { recipients: true } });
      const { targets, unattributed, internalOnly } = attribute(fresh, providerMessageId, type, named);
      if (internalOnly) {
        // Ops-only record: not linked to the message, so the sender's
        // delivery details never show an internal address as delivered or
        // failed by the provider. No status change, no suppression.
        await tx.mailDeliveryEvent.create({ data: { webhookEventId: event.id, providerMessageId, eventType: type, occurredAt, recipient: named.join(",").slice(0, 320) || null, detail: { internalRecipient: true, ignored: true, outboundMessageId: message.id } } });
        await tx.mailDeliveryEvent.updateMany({ where: { webhookEventId: event.id, messageId: null, detail: { path: ["unmatched"], equals: true } }, data: { detail: { unmatched: false, rematched: true } } });
        await audit.record({ action: "MAIL_DELIVERY_INTERNAL_RECIPIENT_IGNORED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { eventType: type, recipients: named.length } }, {}, tx);
        return false;
      }
      const internal = internalAddresses(fresh);
      const detail = {
        bounceType: data.bounce?.type || null,
        reason: String(data.bounce?.message || data.reason || "").slice(0, 300) || null,
        ...(suppressed ? { suppressed: true } : {}),
        ...(unattributed ? { unattributed: true } : {}),
      };
      const shown = targets.length ? targets.map((recipient) => recipient.address) : named.filter((address) => !internal.has(address));
      await tx.mailDeliveryEvent.create({
        data: { messageId: message.id, webhookEventId: event.id, providerMessageId, eventType: type, occurredAt, recipient: shown.join(",").slice(0, 320) || null, detail },
      });
      const nextStatus = RECIPIENT_STATUS[type];
      if (nextStatus) {
        for (const recipient of targets) {
          if ((RANK[nextStatus] ?? 0) < (RANK[recipient.status] ?? 0) && recipient.status !== "DELAYED") continue;
          await tx.mailMessageRecipient.update({ where: { id: recipient.id }, data: { status: nextStatus, lastEventAt: occurredAt, lastEventDetail: suppressed ? "SUPPRESSED_BY_PROVIDER" : type } });
          recipient.status = nextStatus;
        }
        const status = aggregateMessageStatus(fresh.recipients, fresh.status);
        if (status !== fresh.status) await tx.mailMessage.update({ where: { id: message.id }, data: { status, lastStatusAt: occurredAt } });
      }
      // Suppress only recipients the event actually attributed, and only on
      // evidence the address is dead (hard bounce) or a complaint.
      const hardBounce = type === "BOUNCED" && /^(permanent|hard)$/i.test(String(data.bounce?.type || ""));
      if (hardBounce || type === "COMPLAINED") {
        for (const recipient of targets) {
          const active = await tx.marketingSuppression.findFirst({ where: { organizationId: message.mailbox.organizationId, email: recipient.address, liftedAt: null } });
          if (!active) await tx.marketingSuppression.create({ data: { organizationId: message.mailbox.organizationId, email: recipient.address, reason: type === "BOUNCED" ? "BOUNCED" : "COMPLAINED", source: "provider_event" } });
        }
      }
      // An earlier unmatched copy of this event is now resolved.
      await tx.mailDeliveryEvent.updateMany({ where: { webhookEventId: event.id, messageId: null, detail: { path: ["unmatched"], equals: true } }, data: { detail: { unmatched: false, rematched: true } } });
      await audit.record({ action: `MAIL_DELIVERY_${type}`, targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { recipients: targets.length, ...(unattributed ? { unattributed: true } : {}) } }, {}, tx);
      return true;
    });
  }

  async function applyWebhookEvent(event, { storeUnmatched = true } = {}) {
    const type = EVENT_MAP[event.eventType];
    const data = event.payload?.data || {};
    const providerMessageId = String(data.email_id || data.id || "");
    if (!type || !providerMessageId) return { skipped: true };
    // Open/click tracking is not recorded for private mailbox mail.
    if (TRACKING_TYPES.has(type)) return { skipped: true, reason: "TRACKING_NOT_RECORDED" };
    const occurredAt = new Date(event.payload?.created_at || data.created_at || event.receivedAt);
    const named = [...new Set([...addressList(data.to), ...addressList(data.cc), ...addressList(data.bcc)])];
    const ctx = { type, providerMessageId, occurredAt, named, data, suppressed: event.eventType === "email.suppressed" };
    let messages = await findMessages(client, providerMessageId);
    // Provider-assigned Message-ID (threading / echo dedup alias).
    if (data.message_id) {
      for (const message of messages) await recordProviderMessageId({ client, features, messageId: message.id, rfcMessageId: message.rfcMessageId, providerRfcMessageId: data.message_id });
    }
    if (!messages.length) {
      if (!storeUnmatched) return { matched: 0 };
      const exists = await client.mailDeliveryEvent.findFirst({ where: { webhookEventId: event.id, messageId: null } });
      if (!exists) await client.mailDeliveryEvent.create({ data: { webhookEventId: event.id, providerMessageId, eventType: type, occurredAt, recipient: named[0] || null, detail: { unmatched: true } } });
      // Acceptance may have committed meanwhile: look once more.
      messages = await findMessages(client, providerMessageId);
      if (!messages.length) return { matched: 0 };
      if (data.message_id) {
        for (const message of messages) await recordProviderMessageId({ client, features, messageId: message.id, rfcMessageId: message.rfcMessageId, providerRfcMessageId: data.message_id });
      }
    }
    for (const message of messages) {
      const applied = await applyToMessage(event, message, ctx);
      if (applied && FAILURE_TYPES.has(type) && message.sentByAdminUserId) {
        await notifications.notifyUsers([message.sentByAdminUserId], { icon: "xcircle", title: type === "COMPLAINED" ? "Recipient marked your email as spam" : "Email delivery failed", subtitle: `From ${message.mailbox.name}` });
      }
    }
    return { matched: messages.length };
  }

  // Re-applies events stored unmatched for a provider id (idempotent).
  async function reapplyUnmatched(providerMessageId) {
    if (!providerMessageId) return 0;
    const rows = await client.mailDeliveryEvent.findMany({ where: { providerMessageId, messageId: null, webhookEventId: { not: null }, detail: { path: ["unmatched"], equals: true } } });
    let applied = 0;
    for (const row of rows) {
      const event = await client.mailWebhookEvent.findUnique({ where: { id: row.webhookEventId } });
      if (!event) continue;
      const result = await applyWebhookEvent(event, { storeUnmatched: false });
      if (result.matched) applied += 1;
    }
    return applied;
  }

  return { applyWebhookEvent, reapplyUnmatched };
}

function createDeliveryEventProcessor({ client, audit, notifications, marketingEvents = null, features = null }) {
  const applier = createDeliveryEventApplier({ client, audit, notifications, features });

  async function process(job) {
    const event = await client.mailWebhookEvent.findUnique({ where: { id: job.webhookEventId } });
    if (!event) return { skipped: true };
    // Marketing (M7) events are reconciled against marketing records; anything
    // else falls through to the transactional mailbox path unchanged. An
    // email.suppressed the marketing side does not recognise may belong to
    // staff mail, so it falls through as well.
    if (marketingEvents) {
      const routed = await marketingEvents.route(event);
      const unmatchedSuppressed = event.eventType === "email.suppressed" && routed?.reason === "UNMATCHED";
      if (routed && !unmatchedSuppressed) return routed;
    }
    return applier.applyWebhookEvent(event);
  }

  return { process, reapplyUnmatched: applier.reapplyUnmatched };
}

module.exports = { createDeliveryEventProcessor, createDeliveryEventApplier, aggregateMessageStatus, deriveMessageStatus: aggregateMessageStatus, recordProviderMessageId, attribute, EVENT_MAP };
