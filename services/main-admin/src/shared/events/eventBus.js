const EventEmitter = require("events");
const logger = require("../utils/logger");

function booleanField(payload, ...names) {
  return names.some((name) => Boolean(payload?.[name]));
}

function sanitizedErrorCode(value) {
  const normalized = String(value || "HANDLER_ERROR").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized)
    ? normalized
    : "HANDLER_ERROR";
}

function safeEventSummary(event, payload = {}, extra = {}) {
  return {
    eventName: event,
    hasExternalEventId: booleanField(payload, "eventId", "externalEventId"),
    occurredAt: payload?.occurredAt || payload?.timestamp || undefined,
    eventVersion: payload?.eventVersion,
    handlerCount: extra.handlerCount,
    correlationIdPresent: booleanField(payload, "correlationId", "requestId"),
    hasUserIdentity: booleanField(payload, "userId"),
    hasAnonymousIdentity: booleanField(payload, "anonId", "anonymousId"),
    platform: payload?.platform,
    connectionPresent: booleanField(payload, "connectionId"),
    campaignPresent: booleanField(payload, "campaignExternalId", "campaign_id"),
    processingStatus: extra.processingStatus,
    durationMs: extra.durationMs,
    errorCode: extra.errorCode ? sanitizedErrorCode(extra.errorCode) : undefined,
    retryable: extra.retryable,
    handlerName: extra.handlerName,
  };
}

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  publish(event, payload) {
    logger.info("[EventBus] Publishing", safeEventSummary(event, payload, {
      handlerCount: this.listenerCount(event),
      processingStatus: "PUBLISHED",
    }));
    this.emit(event, payload);
  }

  subscribe(event, handler) {
    this.on(event, async (payload) => {
      const startedAt = Date.now();
      try {
        await handler(payload);
      } catch (err) {
        logger.error("[EventBus] Handler failed", safeEventSummary(event, payload, {
          durationMs: Date.now() - startedAt,
          processingStatus: "FAILED",
          errorCode: err.code || err.name || "HANDLER_ERROR",
          retryable: Boolean(err.retryable),
          handlerName: handler.name || "anonymous",
        }));
      }
    });
  }
}

const eventBus = new EventBus();

module.exports = eventBus;
module.exports.safeEventSummary = safeEventSummary;
module.exports.sanitizedErrorCode = sanitizedErrorCode;
