"use strict";

// Delivery-status polling (job kind POLL_DELIVERY_STATUS, queue EVENTS).
//
// One Resend webhook serves both deployments and points at the inbound owner
// (MAIL_INBOUND_ACTIVE_ENVIRONMENT). That deployment acknowledges and drops
// delivery events tagged with the other deployment's cf_env, so a deployment
// that sends without owning the webhook never hears whether its mail was
// delivered. This poller asks the provider for the latest status of this
// deployment's own recent sends (GET /emails/{id}, last_event) and feeds it
// through the normal delivery-event applier, so status, history, audit and
// failure notifications behave exactly as for a webhook event.
//
// - Only OUTBOUND messages still waiting for a final outcome are polled:
//   PROVIDER_ACCEPTED / DELAYED, with a provider id, sent within the lookback.
// - Each observed status is stored once, as a provider event of provider
//   "resend-poll" with id "poll:<provider message id>:<status>" (unique), and
//   signature_verified=false: it is provider API evidence, not a signed
//   webhook. Re-polling the same status is a no-op.
// - The event names the request's To recipients, which is what the provider's
//   own webhook lists, so the applier's recipient attribution is unchanged.
// - Only status metadata is read from the provider response; message content
//   it returns is never stored.

const { createDeliveryEventApplier } = require("./delivery-event.processor");

const PROVIDER = "resend-poll";
const WAITING = ["PROVIDER_ACCEPTED", "DELAYED"];
const WEBHOOK_TYPE = {
  DELIVERED: "email.delivered",
  DELIVERY_DELAYED: "email.delivery_delayed",
  BOUNCED: "email.bounced",
  COMPLAINED: "email.complained",
  FAILED: "email.failed",
};

function requestToAddresses(message, providerMessageId) {
  let batch = message.recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED" && recipient.providerMessageId === providerMessageId);
  if (!batch.length && message.providerMessageId === providerMessageId) batch = message.recipients.filter((recipient) => recipient.status !== "INTERNAL_DELIVERED" && !recipient.providerMessageId);
  const to = batch.filter((recipient) => recipient.type === "TO");
  const cc = batch.filter((recipient) => recipient.type === "CC");
  return (to.length ? to : cc.length ? cc : batch).map((recipient) => recipient.address);
}

function createDeliveryStatusPoller({ client, config, adapter, audit, notifications, features = null, clock = () => new Date(), logger = null }) {
  const settings = config.deliveryPolling || { enabled: false };
  const applier = createDeliveryEventApplier({ client, audit, notifications, features });

  async function candidates() {
    const since = new Date(clock().getTime() - settings.lookbackHours * 3600 * 1000);
    const messages = await client.mailMessage.findMany({
      where: { direction: "OUTBOUND", status: { in: WAITING }, sentAt: { gte: since } },
      include: { recipients: true },
      orderBy: { sentAt: "asc" },
      take: settings.maxPerRun,
    });
    const requests = [];
    for (const message of messages) {
      const ids = new Set([message.providerMessageId, ...message.recipients.map((recipient) => recipient.providerMessageId)].filter(Boolean));
      for (const providerMessageId of ids) requests.push({ message, providerMessageId });
    }
    return requests.slice(0, settings.maxPerRun);
  }

  async function record(message, providerMessageId, type, occurredAt) {
    const eventType = WEBHOOK_TYPE[type];
    if (!eventType) return { skipped: true };
    const providerEventId = `poll:${providerMessageId}:${type}`.slice(0, 255);
    const payload = { type: eventType, created_at: occurredAt.toISOString(), source: "provider_status_poll", data: { email_id: providerMessageId, to: requestToAddresses(message, providerMessageId), created_at: occurredAt.toISOString() } };
    let event = await client.mailWebhookEvent.findUnique({ where: { provider_providerEventId: { provider: PROVIDER, providerEventId } } });
    if (!event) {
      const crypto = require("crypto");
      try {
        event = await client.mailWebhookEvent.create({
          data: { provider: PROVIDER, providerEventId, eventType, payloadSha256: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload, signatureVerified: false, status: "RECEIVED" },
        });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        event = await client.mailWebhookEvent.findUnique({ where: { provider_providerEventId: { provider: PROVIDER, providerEventId } } });
      }
    }
    const result = await applier.applyWebhookEvent(event);
    await client.mailWebhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: clock() } });
    return { recorded: true, matched: result.matched || 0 };
  }

  async function process() {
    if (!settings.enabled) return { skipped: "DELIVERY_POLLING_DISABLED" };
    if (typeof adapter.retrieveDeliveryEvents !== "function") return { skipped: "PROVIDER_STATUS_UNSUPPORTED" };
    let polled = 0;
    let recorded = 0;
    let unchanged = 0;
    let errors = 0;
    for (const { message, providerMessageId } of await candidates()) {
      polled += 1;
      let events;
      try {
        events = await adapter.retrieveDeliveryEvents(providerMessageId);
      } catch (error) {
        errors += 1;
        logger?.warn?.({ event: "mail.delivery_poll.provider_error", code: error?.code || "PROVIDER_ERROR" }, "Mail delivery status poll failed for one message");
        continue;
      }
      const latest = events.find((event) => WEBHOOK_TYPE[event.type]);
      if (!latest) {
        unchanged += 1;
        continue;
      }
      // The provider reports the latest status, not when it happened: record the
      // time it was observed.
      const outcome = await record(message, providerMessageId, latest.type, clock());
      if (outcome.recorded) recorded += 1;
    }
    // A provider outage for every candidate is a retryable failure, so the
    // job's retry and dead-letter handling applies.
    if (polled && errors === polled) {
      const error = new Error("Provider status unavailable for every polled message");
      error.code = "MAIL_PROVIDER_UNAVAILABLE";
      throw error;
    }
    return { polled, recorded, unchanged, errors };
  }

  return { process, settings };
}

module.exports = { createDeliveryStatusPoller, requestToAddresses, POLL_PROVIDER: PROVIDER };
