const eventBus = require("../../../../shared/events/eventBus");
const EVENTS = require("../../../../shared/events/events");
const logger = require("../../../../shared/utils/logger");
const { prisma } = require("../../../../shared/config/database");
const attributionService = require("../attribution.service");
const { AD_PLATFORMS } = require("../platforms");

// Funnel event listener - subscribes through the existing event bus and
// persists marketing_funnel_events, then reconciles affected snapshots.
//
// Events consumed:
//   PAYMENT_SUCCESS          (existing) - confirmed payments only; the bus
//                            only emits this on a transition to SUCCESS, so
//                            pending/failed/abandoned payments never arrive.
//   USER_SIGNUP_COMPLETED    (new)      - end-user signup with attribution.
//   USER_BECAME_ACTIVE       (new)      - activation per the app's definition.
//   MARKETING_CLICK_RECORDED (new)      - attributed ad click landing.
//
// The eventBus.subscribe wrapper already catches handler errors, so a
// listener failure can never break the original emitter's transaction.

const STAGE_BY_EVENT = {
  [EVENTS.MARKETING_CLICK_RECORDED]: "CLICK",
  [EVENTS.USER_SIGNUP_COMPLETED]: "SIGNUP",
  [EVENTS.USER_BECAME_ACTIVE]: "ACTIVE",
  [EVENTS.PAYMENT_SUCCESS]: "PAYMENT",
};

function normalizeSource(source) {
  if (!source || typeof source !== "string") return null;
  return source.trim().toLowerCase().slice(0, 100) || null;
}

function toOccurredAt(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function safeAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
}

function createFunnelEventListener({
  prisma: db = prisma,
  bus = eventBus,
  aggregationService,
  log = logger,
} = {}) {
  let registered = false;

  function getAggregationService() {
    // Lazy to avoid a require cycle at module load.
    return aggregationService || require("../aggregation/aggregation.service");
  }

  // PAYMENT_SUCCESS must carry amount/currency in the emitted payload when
  // revenue attribution is required. The Admin backend intentionally does not
  // reach into the main application database from this Marketing Intelligence
  // runtime path.
  async function resolvePaymentAmount(payload) {
    if (payload.amount !== undefined && payload.amount !== null) {
      return {
        value: safeAmount(payload.amount),
        currency: (payload.currency || "USD").toUpperCase().slice(0, 16),
      };
    }

    return { value: null, currency: null };
  }

  // Persist one funnel event. Duplicate externalEventIds are dropped
  // silently (idempotent), and snapshot reconciliation runs when the event
  // carries campaign attribution that maps to an ad platform.
  async function recordFunnelEvent(stage, payload = {}) {
    payload = await attributionService
      .createAttributionService({ prisma: db })
      .enrichPayload(payload);
    const externalEventId =
      payload.eventId ||
      (stage === "PAYMENT" && payload.transactionId
        ? `payment:${payload.transactionId}`
        : null);

    if (externalEventId) {
      const existing = await db.marketing_funnel_events.findUnique({
        where: { externalEventId },
        select: { id: true },
      });
      if (existing) return { duplicate: true, id: existing.id };
    }

    const userId = payload.userId ? String(payload.userId) : null;
    const anonId = payload.anonId ? String(payload.anonId) : null;

    if (!userId && !anonId && !externalEventId) {
      log.warn(
        `[MarketingIntelligence] Dropping ${stage} funnel event without any identifying value`,
      );
      return { dropped: true };
    }

    const source = normalizeSource(payload.source);
    const campaignExternalId = payload.campaignExternalId
      ? String(payload.campaignExternalId).slice(0, 255)
      : null;
    const occurredAt = toOccurredAt(payload.occurredAt);

    let value = null;
    let currency = null;
    if (stage === "PAYMENT") {
      const amount = await resolvePaymentAmount(payload);
      value = amount.value;
      currency = amount.currency;
    }

    let event;
    try {
      event = await db.marketing_funnel_events.create({
        data: {
          userId,
          anonId,
          stage,
          source,
          campaignExternalId,
          utmParams:
            payload.utmParams && typeof payload.utmParams === "object"
              ? payload.utmParams
              : undefined,
          value,
          currency,
          externalEventId,
          occurredAt,
        },
      });
    } catch (error) {
      // Unique race on externalEventId - a concurrent handler stored it first.
      if (error.code === "P2002") return { duplicate: true };
      throw error;
    }

    log.info(
      `[MarketingIntelligence] Funnel event stored (stage=${stage}, source=${source || "n/a"}, campaign=${campaignExternalId || "n/a"})`,
    );

    // Reconcile the affected snapshot when the campaign and platform can be
    // determined. Soft failure - the event itself is already stored.
    if (campaignExternalId) {
      const service = getAggregationService();
      const platform = service.resolvePlatformFromSource
        ? service.resolvePlatformFromSource(source)
        : require("../aggregation/aggregation.service").resolvePlatformFromSource(source);

      const platforms = platform ? [platform] : AD_PLATFORMS;
      for (const candidate of platforms) {
        try {
          await service.reconcileSnapshotFunnel({
            platform: candidate,
            campaignExternalId,
            date: occurredAt.toISOString().slice(0, 10),
          });
        } catch (error) {
          log.warn(
            `[MarketingIntelligence] Snapshot reconciliation failed for ${candidate}/${campaignExternalId}: ${error.message}`,
          );
        }
      }
    }

    return { id: event.id };
  }

  // Idempotent event-bus registration - called once from the shared events
  // bootstrap. eventBus.subscribe wraps handlers in try/catch already.
  function register() {
    if (registered) return;
    registered = true;

    for (const [eventName, stage] of Object.entries(STAGE_BY_EVENT)) {
      bus.subscribe(eventName, (payload) => recordFunnelEvent(stage, payload));
    }

    log.info("[MarketingIntelligence] Funnel event listener registered");
  }

  return { register, recordFunnelEvent };
}

const defaultListener = createFunnelEventListener();

module.exports = {
  createFunnelEventListener,
  STAGE_BY_EVENT,
  register: defaultListener.register,
  recordFunnelEvent: defaultListener.recordFunnelEvent,
};
