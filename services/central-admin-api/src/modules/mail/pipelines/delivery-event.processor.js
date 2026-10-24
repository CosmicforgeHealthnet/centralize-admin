"use strict";

// Delivery events (job kind PROCESS_DELIVERY_EVENT). Updates per-recipient and
// per-message status from provider evidence. Status never regresses from a
// terminal state, and bounces/complaints create brand-scoped suppressions.

const { normalizeAddress } = require("../security/address.util");

const EVENT_MAP = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.delivery_delayed": "DELIVERY_DELAYED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.failed": "FAILED",
  "email.opened": "OPENED",
  "email.clicked": "CLICKED",
};
const RECIPIENT_STATUS = { DELIVERED: "DELIVERED", DELIVERY_DELAYED: "DELAYED", BOUNCED: "BOUNCED", COMPLAINED: "COMPLAINED", FAILED: "FAILED" };
const RANK = { PENDING: 0, PROVIDER_ACCEPTED: 1, DELAYED: 2, DELIVERED: 3, FAILED: 4, BOUNCED: 5, COMPLAINED: 6, INTERNAL_DELIVERED: 3 };

function aggregateMessageStatus(recipients, current) {
  const external = recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED");
  if (!external.length) return current;
  const statuses = external.map((recipient) => recipient.status);
  if (statuses.includes("COMPLAINED")) return "COMPLAINED";
  if (statuses.includes("BOUNCED")) return "BOUNCED";
  if (statuses.every((status) => status === "FAILED")) return "FAILED";
  if (statuses.every((status) => status === "DELIVERED")) return "DELIVERED";
  if (statuses.includes("DELAYED")) return "DELAYED";
  if (statuses.includes("FAILED")) return "FAILED";
  return current === "QUEUED" ? "PROVIDER_ACCEPTED" : current;
}

function createDeliveryEventProcessor({ client, audit, notifications }) {
  async function process(job) {
    const event = await client.mailWebhookEvent.findUnique({ where: { id: job.webhookEventId } });
    if (!event) return { skipped: true };
    const type = EVENT_MAP[event.eventType];
    const data = event.payload?.data || {};
    const providerMessageId = String(data.email_id || data.id || "");
    if (!type || !providerMessageId) return { skipped: true };
    const occurredAt = new Date(event.payload?.created_at || data.created_at || event.receivedAt);
    const recipients = [...new Set((Array.isArray(data.to) ? data.to : [data.to]).map(normalizeAddress).filter(Boolean))];
    const messages = await client.mailMessage.findMany({ where: { providerMessageId, direction: "OUTBOUND" }, include: { recipients: true, mailbox: true } });
    if (!messages.length) {
      await client.mailDeliveryEvent.create({ data: { webhookEventId: event.id, providerMessageId, eventType: type, occurredAt, recipient: recipients[0] || null, detail: { unmatched: true } } });
      return { matched: 0 };
    }
    for (const message of messages) {
      await client.$transaction(async (tx) => {
        const already = await tx.mailDeliveryEvent.findFirst({ where: { webhookEventId: event.id, messageId: message.id } });
        if (already) return;
        await tx.mailDeliveryEvent.create({
          data: { messageId: message.id, webhookEventId: event.id, providerMessageId, eventType: type, occurredAt, recipient: recipients.join(",").slice(0, 320) || null, detail: { bounceType: data.bounce?.type || null, reason: String(data.bounce?.message || data.reason || "").slice(0, 300) || null } },
        });
        const nextStatus = RECIPIENT_STATUS[type];
        if (nextStatus) {
          for (const recipient of message.recipients) {
            if (recipients.length && !recipients.includes(recipient.address)) continue;
            if (recipient.status === "INTERNAL_DELIVERED") continue;
            if ((RANK[nextStatus] ?? 0) < (RANK[recipient.status] ?? 0) && recipient.status !== "DELAYED") continue;
            await tx.mailMessageRecipient.update({ where: { id: recipient.id }, data: { status: nextStatus, lastEventAt: occurredAt, lastEventDetail: type } });
            recipient.status = nextStatus;
          }
          const status = aggregateMessageStatus(message.recipients, message.status);
          if (status !== message.status) await tx.mailMessage.update({ where: { id: message.id }, data: { status, lastStatusAt: occurredAt } });
        }
        if (type === "BOUNCED" || type === "COMPLAINED") {
          for (const address of recipients) {
            const active = await tx.marketingSuppression.findFirst({ where: { organizationId: message.mailbox.organizationId, email: address, liftedAt: null } });
            if (!active) await tx.marketingSuppression.create({ data: { organizationId: message.mailbox.organizationId, email: address, reason: type === "BOUNCED" ? "BOUNCED" : "COMPLAINED", source: "provider_event" } });
          }
        }
        await audit.record({ action: `MAIL_DELIVERY_${type}`, targetType: "message", targetId: message.id, mailboxId: message.mailboxId, metadata: { recipients: recipients.length } }, {}, tx);
      });
      if (["BOUNCED", "FAILED", "COMPLAINED"].includes(type) && message.sentByAdminUserId) {
        await notifications.notifyUsers([message.sentByAdminUserId], { icon: "xcircle", title: type === "COMPLAINED" ? "Recipient marked your email as spam" : "Email delivery failed", subtitle: `From ${message.mailbox.name}` });
      }
    }
    return { matched: messages.length };
  }

  return { process };
}

module.exports = { createDeliveryEventProcessor, aggregateMessageStatus, EVENT_MAP };
