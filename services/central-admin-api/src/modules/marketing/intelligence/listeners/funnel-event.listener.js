const eventBus = require("../../../../shared/events/eventBus");
const EVENTS = require("../../../../shared/events/events");
const logger = require("../../../../shared/utils/logger");
const { prisma } = require("../../../../shared/config/database");
const attributionService = require("../attribution.service");
const { AD_PLATFORMS, normalizePlatform } = require("../platforms");
const { normalizeCurrency, toMoneyDecimal } = require("../utils/currency");
const { structuredLogger } = require("../observability");
const { marketingError } = require("../errors");
const { deterministicMarketingEventId } = require("../utils/event-id");

// Funnel event listener - subscribes through the existing event bus and
// persists immutable marketing_funnel_events, then records attribution
// decisions and reconciles affected snapshots. Listener errors are caught by
// eventBus.subscribe and never roll back the source system transaction.

const STAGE_BY_EVENT = {
  [EVENTS.MARKETING_CLICK_RECORDED]: "CLICK",
  [EVENTS.USER_SIGNUP_COMPLETED]: "SIGNUP",
  [EVENTS.USER_BECAME_ACTIVE]: "ACTIVE",
  [EVENTS.PAYMENT_SUCCESS]: "PAYMENT",
  [EVENTS.PAYMENT_REFUNDED]: "REFUND",
  [EVENTS.PAYMENT_CHARGEBACK]: "CHARGEBACK",
};

const MONETARY_STAGES = new Set(["PAYMENT", "REFUND", "CHARGEBACK"]);
const FINALIZED_STATUSES = new Set(["FINALIZED", "SUCCEEDED", "SUCCESS", "COMPLETED", "SETTLED"]);

function normalizeSource(source) {
  if (!source || typeof source !== "string") return null;
  return source.trim().toLowerCase().slice(0, 100) || null;
}

function trimString(value, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function toOccurredAt(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeMonetaryStatus(value) {
  return String(value || "FINALIZED").trim().toUpperCase().slice(0, 40);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function stageSign(stage) {
  return stage === "PAYMENT" ? 1 : -1;
}

function signedAmount(stage, value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = toMoneyDecimal(value, { allowZero: false });
  if (stage === "PAYMENT" && parsed.isNegative()) throw badRequest("PAYMENT amount must be positive");
  return parsed.abs().mul(stageSign(stage));
}

function createFunnelEventListener({
  prisma: db = prisma,
  bus = eventBus,
  aggregationService,
  attribution = attributionService,
  log = logger,
} = {}) {
  log = structuredLogger(log, "marketing.event_ingestion.operation");
  let registered = false;

  function getAggregationService() {
    return aggregationService || require("../aggregation/aggregation.service");
  }

  async function paymentByExternalEventId(store, externalEventId) {
    if (!externalEventId) return null;
    return store.marketing_funnel_events.findUnique({
      where: { externalEventId },
    });
  }

  async function adjustmentTotal(store, originalPaymentExternalEventId) {
    const rows = await store.marketing_funnel_events.findMany({
      where: {
        originalPaymentExternalEventId,
        stage: { in: ["REFUND", "CHARGEBACK"] },
      },
      select: { value: true, monetaryStatus: true },
    });

    return rows
      .filter((row) => FINALIZED_STATUSES.has(normalizeMonetaryStatus(row.monetaryStatus)))
      .reduce(
        (sum, row) => sum.plus(row.value === null || row.value === undefined ? 0 : row.value),
        toMoneyDecimal(0),
      );
  }

  async function resolveMonetaryFields(stage, payload, store = db) {
    if (!MONETARY_STAGES.has(stage)) {
      return { value: null, currency: null, monetaryStatus: null, originalPaymentExternalEventId: null };
    }

    const value = signedAmount(stage, payload.amount);
    const currency = value === null ? null : normalizeCurrency(payload.currency, { allowUnspecified: false });
    const monetaryStatus = normalizeMonetaryStatus(payload.monetaryStatus || payload.status);
    const originalPaymentExternalEventId = trimString(
      payload.originalPaymentExternalEventId || payload.originalPaymentEventId,
      255,
    );

    if (stage === "PAYMENT") {
      return { value, currency, monetaryStatus, originalPaymentExternalEventId: null };
    }

    if (!originalPaymentExternalEventId) {
      return { value, currency, monetaryStatus, originalPaymentExternalEventId, unresolvedReason: "MISSING_ORIGINAL_PAYMENT" };
    }

    const payment = await paymentByExternalEventId(store, originalPaymentExternalEventId);
    if (!payment || payment.stage !== "PAYMENT") {
      return { value, currency, monetaryStatus, originalPaymentExternalEventId, unresolvedReason: "MISSING_ORIGINAL_PAYMENT" };
    }

    if (currency && payment.currency && currency !== payment.currency) {
      throw badRequest("Adjustment currency must match original payment currency");
    }

    if (FINALIZED_STATUSES.has(monetaryStatus) && value !== null) {
      const paymentValue = toMoneyDecimal(payment.value || 0);
      const remaining = paymentValue.plus(
        await adjustmentTotal(store, originalPaymentExternalEventId),
      );
      if (value.abs().greaterThan(remaining)) {
        throw badRequest("Adjustment exceeds remaining refundable amount");
      }
    }

    return {
      value,
      currency: currency || payment.currency || null,
      monetaryStatus,
      originalPaymentExternalEventId,
      inheritedPayment: payment,
    };
  }

  async function maybeRecordAttribution(stage, event) {
    const scopedAttribution = attribution.createAttributionService({ prisma: db });
    if (stage === "SIGNUP" && event.userId && event.anonId) {
      await scopedAttribution.linkUser({
        userId: event.userId,
        anonId: event.anonId,
        occurredAt: event.occurredAt,
        sourceSignupEventId: event.externalEventId,
      });
    }

    if (["SIGNUP", "PAYMENT", "ACTIVE"].includes(stage)) {
      return scopedAttribution.resolveLastTouchForConversion(event);
    }
    if (["REFUND", "CHARGEBACK"].includes(stage)) {
      return scopedAttribution.copyOriginalPaymentAttribution(event);
    }
    return null;
  }

  async function reconcileDecisionContext(stage, event, decision) {
    if (stage === "CLICK") return;
    const campaignExternalId = decision?.campaignExternalId || event.campaignExternalId;
    const platform = decision?.platform || event.platform;
    if (!campaignExternalId || !platform) return;

    const service = getAggregationService();
    const date = event.occurredAt.toISOString().slice(0, 10);
    try {
      await service.reconcileSnapshotFunnel({
        platform,
        campaignExternalId,
        date,
        connectionId: decision?.connectionId || event.connectionId || undefined,
        accountId: decision?.accountExternalId || event.accountExternalId || undefined,
        currency: event.currency || undefined,
      });
    } catch (error) {
      log.warn(
        `[MarketingIntelligence] Snapshot reconciliation failed for attributed ${stage}: ${error.message}`,
      );
    }
  }

  async function recordFunnelEvent(stage, payload = {}) {
    payload = await attribution
      .createAttributionService({ prisma: db })
      .enrichPayload(payload);
    const externalEventId =
      payload.eventId ||
      (stage === "PAYMENT" && payload.transactionId
        ? deterministicMarketingEventId("payment", payload.transactionId)
        : null);

    if (externalEventId) {
      const existing = await db.marketing_funnel_events.findUnique({
        where: { externalEventId },
        select: { id: true, stage: true, userId: true, anonId: true, platform: true, connectionId: true, accountExternalId: true, campaignExternalId: true, value: true, currency: true, occurredAt: true, originalPaymentExternalEventId: true },
      });
      if (existing) {
        const comparisons = [
          [existing.stage, stage],
          [existing.userId, trimString(payload.userId, 255)],
          [existing.anonId, trimString(payload.anonId || payload.anonymousId, 255)],
          [existing.connectionId, trimString(payload.connectionId, 255)],
          [existing.accountExternalId, trimString(payload.accountExternalId || payload.accountId, 255)],
          [existing.campaignExternalId, trimString(payload.campaignExternalId, 255)],
          [existing.originalPaymentExternalEventId, trimString(payload.originalPaymentExternalEventId || payload.originalPaymentEventId, 255)],
        ];
        const conflict = comparisons.some(([stored, provided]) => stored !== undefined && stored !== null && provided !== undefined && provided !== null && String(stored) !== String(provided));
        const occurredConflict = payload.occurredAt && existing.occurredAt && new Date(existing.occurredAt).getTime() !== toOccurredAt(payload.occurredAt).getTime();
        const suppliedCurrency = payload.currency ? normalizeCurrency(payload.currency, { allowUnspecified: false }) : null;
        const currencyConflict = suppliedCurrency && existing.currency && suppliedCurrency !== existing.currency;
        let amountConflict = false;
        if ((payload.amount ?? payload.value) !== undefined && existing.value !== null && existing.value !== undefined) {
          const suppliedAmount = toMoneyDecimal(payload.amount ?? payload.value).abs();
          const storedAmount = toMoneyDecimal(existing.value).abs();
          amountConflict = !suppliedAmount.equals(storedAmount);
        }
        if (conflict || occurredConflict || currencyConflict || amountConflict) {
          throw marketingError("DUPLICATE_ACTION", [], { message: "The external event ID conflicts with an existing immutable event" });
        }
        return { duplicate: true, id: existing.id };
      }
    }

    const userId = trimString(payload.userId, 255);
    const anonId = trimString(payload.anonId || payload.anonymousId, 255);

    if (!userId && !anonId && !externalEventId) {
      log.warn(
        `[MarketingIntelligence] Dropping ${stage} funnel event without any identifying value`,
      );
      return { dropped: true };
    }

    const source = normalizeSource(payload.source);
    const platform =
      normalizePlatform(payload.platform) ||
      (source ? getAggregationService().resolvePlatformFromSource(source) : null) ||
      null;
    const campaignExternalId = trimString(payload.campaignExternalId, 255);
    const connectionId = trimString(payload.connectionId, 255);
    const accountExternalId = trimString(payload.accountExternalId || payload.accountId, 255);
    const occurredAt = toOccurredAt(payload.occurredAt);
    const createEvent = async (store) => {
      const monetary = await resolveMonetaryFields(stage, payload, store);
      const inherited = monetary.inheritedPayment || null;
      return store.marketing_funnel_events.create({
        data: {
          userId,
          anonId,
          stage,
          source,
          platform: platform || inherited?.platform || null,
          connectionId: connectionId || inherited?.connectionId || null,
          accountExternalId: accountExternalId || inherited?.accountExternalId || null,
          campaignExternalId: campaignExternalId || inherited?.campaignExternalId || null,
          utmParams:
            payload.utmParams && typeof payload.utmParams === "object"
              ? payload.utmParams
              : undefined,
          value: monetary.value,
          currency: monetary.currency,
          originalPaymentExternalEventId: monetary.originalPaymentExternalEventId,
          monetaryStatus: monetary.monetaryStatus,
          attributionStatus: monetary.unresolvedReason ? "UNRESOLVED" : undefined,
          unresolvedReason: monetary.unresolvedReason || undefined,
          externalEventId,
          occurredAt,
        },
      });
    };

    let event;
    const needsSerializableAdjustment =
      ["REFUND", "CHARGEBACK"].includes(stage) && typeof db.$transaction === "function";
    for (let attempt = 0; attempt < (needsSerializableAdjustment ? 3 : 1); attempt += 1) {
      try {
        event = needsSerializableAdjustment
          ? await db.$transaction((tx) => createEvent(tx), {
              isolationLevel: "Serializable",
            })
          : await createEvent(db);
        break;
      } catch (error) {
        if (error.code === "P2002") return { duplicate: true };
        if (error.code === "P2034" && attempt < 2) continue;
        throw error;
      }
    }

    log.info("[MarketingIntelligence] Funnel event stored", {
      eventName: stage,
      externalEventId: Boolean(externalEventId),
      occurredAt: occurredAt.toISOString(),
      hasUserIdentity: Boolean(userId),
      hasAnonymousIdentity: Boolean(anonId),
      platform: event.platform || null,
      connectionPresent: Boolean(event.connectionId),
      campaignPresent: Boolean(event.campaignExternalId),
    });

    const decision = await maybeRecordAttribution(stage, event);
    await reconcileDecisionContext(stage, event, decision);

    return { id: event.id, attribution: decision || null };
  }

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
