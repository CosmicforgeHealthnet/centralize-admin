const EVENTS = require("../../../shared/events/events");
const eventBus = require("../../../shared/events/eventBus");
const attributionService = require("./attribution.service");
const funnelListener = require("./listeners/funnel-event.listener");

const EVENT_STAGE = Object.freeze({
  [EVENTS.MARKETING_CLICK_RECORDED]: "CLICK",
  [EVENTS.USER_SIGNUP_COMPLETED]: "SIGNUP",
  [EVENTS.USER_BECAME_ACTIVE]: "ACTIVE",
  [EVENTS.PAYMENT_SUCCESS]: "PAYMENT",
});

function stableClickEventId(payload) {
  if (payload.eventId) return payload.eventId;
  const day = new Date(payload.occurredAt || payload.capturedAt || Date.now())
    .toISOString()
    .slice(0, 10);
  const source = payload.source || payload.platform || "unknown";
  const campaign = payload.campaignExternalId || "none";
  return `click:${payload.anonId}:${source}:${campaign}:${day}`;
}

function createFunnelIngestionService({
  attribution = attributionService,
  listener = funnelListener,
  bus = eventBus,
} = {}) {
  async function captureClick(payload = {}) {
    const incoming = attributionService.normalizeAttributionPayload(payload);
    const attributionRow = await attribution.captureClick(payload);
    if (!attributionService.hasPaidSignal(incoming)) {
      return {
        attribution: attributionRow,
        funnelEvent: { skipped: true, reason: "not_paid_click" },
      };
    }
    const eventPayload = {
      ...payload,
      eventId: stableClickEventId(payload),
      anonId: attributionRow.anonId,
      userId: attributionRow.userId || payload.userId || null,
      source: attributionRow.source,
      platform: attributionRow.platform,
      campaignExternalId: attributionRow.campaignExternalId,
      campaignName: attributionRow.campaignName,
      utmParams: attributionRow.utmParams,
      occurredAt: payload.occurredAt || payload.capturedAt || attributionRow.firstCapturedAt,
    };

    const result = await listener.recordFunnelEvent("CLICK", eventPayload);
    return { attribution: attributionRow, funnelEvent: result };
  }

  async function recordSignup(payload = {}) {
    await attribution.linkUser({
      userId: payload.userId,
      anonId: payload.anonId,
      occurredAt: payload.occurredAt,
    });
    const enriched = await attribution.enrichPayload(payload);
    return listener.recordFunnelEvent("SIGNUP", {
      ...enriched,
      eventId: enriched.eventId || (enriched.userId ? `signup:${enriched.userId}` : null),
    });
  }

  async function recordActiveUser(payload = {}) {
    const enriched = await attribution.enrichPayload(payload);
    return listener.recordFunnelEvent("ACTIVE", {
      ...enriched,
      eventId:
        enriched.eventId ||
        (enriched.userId ? `active:${enriched.userId}:${enriched.activationType || "default"}` : null),
    });
  }

  async function recordPayment(payload = {}) {
    const enriched = await attribution.enrichPayload(payload);
    return listener.recordFunnelEvent("PAYMENT", {
      ...enriched,
      eventId:
        enriched.eventId ||
        (enriched.transactionId ? `payment:${enriched.transactionId}` : null),
    });
  }

  async function ingestEnvelope(envelope = {}) {
    const eventType = envelope.eventType;
    const payload = {
      ...(envelope.payload || {}),
      eventId: envelope.eventId || envelope.payload?.eventId,
      occurredAt: envelope.occurredAt || envelope.payload?.occurredAt,
    };

    if (eventType === EVENTS.MARKETING_CLICK_RECORDED) return captureClick(payload);
    if (eventType === EVENTS.USER_SIGNUP_COMPLETED) return recordSignup(payload);
    if (eventType === EVENTS.USER_BECAME_ACTIVE) return recordActiveUser(payload);
    if (eventType === EVENTS.PAYMENT_SUCCESS) return recordPayment(payload);

    const error = new Error(`Unsupported marketing intelligence event type: ${eventType}`);
    error.statusCode = 400;
    throw error;
  }

  function publishSameProcess(eventType, payload) {
    if (!EVENT_STAGE[eventType]) {
      const error = new Error(`Unsupported marketing intelligence event type: ${eventType}`);
      error.statusCode = 400;
      throw error;
    }
    bus.publish(eventType, payload);
  }

  return {
    captureClick,
    recordSignup,
    recordActiveUser,
    recordPayment,
    ingestEnvelope,
    publishSameProcess,
  };
}

const defaultService = createFunnelIngestionService();

module.exports = {
  createFunnelIngestionService,
  EVENT_STAGE,
  stableClickEventId,
  ...defaultService,
};