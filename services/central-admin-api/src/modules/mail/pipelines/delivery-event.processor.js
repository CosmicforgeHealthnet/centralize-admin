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

const { normalizeAddress } = require("../security/address.util");

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

// Returns { targets, unattributed } for one message.
function attribute(message, providerMessageId, type, named) {
  let batch = message.recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED" && recipient.providerMessageId === providerMessageId);
  if (!batch.length && message.providerMessageId === providerMessageId) batch = message.recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED" && !recipient.providerMessageId);
  const namedRecipients = batch.filter((recipient) => named.includes(recipient.address));
  if (!FAILURE_TYPES.has(type)) return { targets: namedRecipients, unattributed: false };
  if (batch.length === 1) return { targets: batch, unattributed: false };
  const ambiguous = !namedRecipients.length || sameSet(namedRecipients.map((r) => r.id), toFieldOf(batch).map((r) => r.id));
  return ambiguous ? { targets: [], unattributed: true } : { targets: namedRecipients, unattributed: false };
}

function createDeliveryEventApplier({ client, audit, notifications }) {
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
      const fresh = await tx.mailMessage.findUnique({ where: { id: message.id }, include: { recipients: true } });
      const { targets, unattributed } = attribute(fresh, providerMessageId, type, named);
      const detail = {
        bounceType: data.bounce?.type || null,
        reason: String(data.bounce?.message || data.reason || "").slice(0, 300) || null,
        ...(suppressed ? { suppressed: true } : {}),
        ...(unattributed ? { unattributed: true } : {}),
      };
      const shown = targets.length ? targets.map((recipient) => recipient.address) : named;
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
    if (!messages.length) {
      if (!storeUnmatched) return { matched: 0 };
      const exists = await client.mailDeliveryEvent.findFirst({ where: { webhookEventId: event.id, messageId: null } });
      if (!exists) await client.mailDeliveryEvent.create({ data: { webhookEventId: event.id, providerMessageId, eventType: type, occurredAt, recipient: named[0] || null, detail: { unmatched: true } } });
      // Acceptance may have committed meanwhile: look once more.
      messages = await findMessages(client, providerMessageId);
      if (!messages.length) return { matched: 0 };
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

function createDeliveryEventProcessor({ client, audit, notifications, marketingEvents = null }) {
  const applier = createDeliveryEventApplier({ client, audit, notifications });

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

module.exports = { createDeliveryEventProcessor, createDeliveryEventApplier, aggregateMessageStatus, deriveMessageStatus: aggregateMessageStatus, EVENT_MAP };
