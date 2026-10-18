const { sanitizeForResponse } = require("./sanitization.service");

const SOCIAL_DOMAIN_EVENTS = Object.freeze({
  SOCIAL_POST_SUBMITTED: "SOCIAL_POST_SUBMITTED",
  SOCIAL_POST_APPROVED: "SOCIAL_POST_APPROVED",
  SOCIAL_POST_REJECTED: "SOCIAL_POST_REJECTED",
  SOCIAL_PUBLICATION_STARTED: "SOCIAL_PUBLICATION_STARTED",
  SOCIAL_PUBLICATION_SUCCEEDED: "SOCIAL_PUBLICATION_SUCCEEDED",
  SOCIAL_PUBLICATION_FAILED: "SOCIAL_PUBLICATION_FAILED",
  SOCIAL_MESSAGE_RECEIVED: "SOCIAL_MESSAGE_RECEIVED",
  SOCIAL_COMMENT_RECEIVED: "SOCIAL_COMMENT_RECEIVED",
  SOCIAL_ITEM_ASSIGNED: "SOCIAL_ITEM_ASSIGNED",
  SOCIAL_SLA_BREACHED: "SOCIAL_SLA_BREACHED",
  SOCIAL_REAUTHORIZATION_REQUIRED: "SOCIAL_REAUTHORIZATION_REQUIRED",
  SOCIAL_WEBHOOK_SUBSCRIPTION_DEGRADED:
    "SOCIAL_WEBHOOK_SUBSCRIPTION_DEGRADED",
  SOCIAL_PRIVACY_INCIDENT_FLAGGED: "SOCIAL_PRIVACY_INCIDENT_FLAGGED",
  SOCIAL_ESCALATION_CREATED: "SOCIAL_ESCALATION_CREATED",
  SOCIAL_OPERATIONAL_ALERT: "SOCIAL_OPERATIONAL_ALERT",
});

const inMemoryPublishedEvents = [];

function sanitizeDomainEventPayload(payload) {
  return sanitizeForResponse(payload);
}

async function publishSocialEvent({ type, payload = {}, publisher } = {}) {
  if (!Object.values(SOCIAL_DOMAIN_EVENTS).includes(type)) {
    throw new Error(`Unsupported Social Operations event: ${type}`);
  }

  const event = {
    type,
    payload: sanitizeDomainEventPayload(payload),
    emittedAt: new Date(),
  };

  if (publisher) {
    await publisher(event);
  } else {
    inMemoryPublishedEvents.push(event);
  }

  return event;
}

function listPublishedSocialEvents() {
  return [...inMemoryPublishedEvents];
}

function clearPublishedSocialEvents() {
  inMemoryPublishedEvents.length = 0;
}

module.exports = {
  SOCIAL_DOMAIN_EVENTS,
  publishSocialEvent,
  sanitizeDomainEventPayload,
  listPublishedSocialEvents,
  clearPublishedSocialEvents,
};
