const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAggregationService } = require("../aggregation/aggregation.service");
const { createFunnelEventListener } = require("../listeners/funnel-event.listener");
const { createFakePrisma } = require("./helpers/fake-prisma");

const silentLog = { info() {}, warn() {}, error() {} };

function buildHarness() {
  const prisma = createFakePrisma();
  const aggregation = createAggregationService({
    prisma,
    connectors: {},
    syncLock: {
      acquire: async () => null,
      release: async () => false,
    },
    log: silentLog,
  });
  const listener = createFunnelEventListener({
    prisma,
    aggregationService: {
      resolvePlatformFromSource: (source) => (String(source || "").toLowerCase() === "meta" ? "META" : null),
      reconcileSnapshotFunnel: async () => null,
    },
    log: silentLog,
  });
  return { prisma, aggregation, listener };
}

function addAttributedClick(prisma, campaignExternalId) {
  prisma.__state.funnelEvents.push({
    id: `click-${campaignExternalId}`,
    externalEventId: `click-${campaignExternalId}`,
    stage: "CLICK",
    userId: "user-1",
    anonId: null,
    source: "meta",
    platform: "META",
    connectionId: "conn-meta-1",
    accountExternalId: "act-meta-1",
    campaignExternalId,
    occurredAt: new Date("2026-07-01T09:00:00.000Z"),
  });
}

async function recordPayment(listener, overrides = {}) {
  return listener.recordFunnelEvent("PAYMENT", {
    eventId: "payment-100",
    userId: "user-1",
    source: "meta",
    platform: "META",
    campaignExternalId: "camp-revenue",
    amount: 100,
    currency: "EUR",
    occurredAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  });
}

async function recordRefund(listener, overrides = {}) {
  return listener.recordFunnelEvent("REFUND", {
    eventId: "refund-1",
    userId: "user-1",
    amount: 40,
    currency: "EUR",
    originalPaymentExternalEventId: "payment-100",
    occurredAt: "2026-07-01T11:00:00.000Z",
    ...overrides,
  });
}

test("refunds are immutable negative adjustments with duplicate and over-refund protection", async () => {
  const { prisma, aggregation, listener } = buildHarness();
  addAttributedClick(prisma, "camp-revenue");

  await recordPayment(listener);
  await recordRefund(listener, { eventId: "refund-40", amount: 40 });
  await recordRefund(listener, { eventId: "refund-60", amount: 60 });
  const duplicate = await recordRefund(listener, { eventId: "refund-60", amount: 60 });

  assert.equal(duplicate.duplicate, true);
  assert.equal(prisma.__state.funnelEvents.filter((event) => event.stage === "PAYMENT").length, 1);
  assert.equal(prisma.__state.funnelEvents.filter((event) => event.stage === "REFUND").length, 2);
  assert.equal(prisma.__state.funnelEvents.find((event) => event.externalEventId === "payment-100").value, 100);
  assert.deepEqual(
    prisma.__state.funnelEvents
      .filter((event) => event.stage === "REFUND")
      .map((event) => event.value)
      .sort((a, b) => a - b),
    [-60, -40],
  );

  await assert.rejects(
    () => recordRefund(listener, { eventId: "refund-over", amount: 1 }),
    /exceeds remaining refundable amount/,
  );
  await assert.rejects(
    () => recordRefund(listener, { eventId: "refund-wrong-currency", amount: 1, currency: "USD" }),
    /currency must match/,
  );

  const metrics = await aggregation.computeFunnelMetrics("META", "camp-revenue", "2026-07-01", {
    currency: "EUR",
  });
  assert.equal(metrics.payments, 1);
  assert.equal(metrics.refunds, 2);
  assert.equal(metrics.revenue, 100);
  assert.equal(metrics.netRevenue, 0);
  assert.equal(metrics.currencyCompatibility, true);
});

test("chargebacks follow the original payment and pending adjustments are excluded from net revenue", async () => {
  const { prisma, aggregation, listener } = buildHarness();
  addAttributedClick(prisma, "camp-chargeback");

  await recordPayment(listener, {
    eventId: "payment-chargeback",
    campaignExternalId: "camp-chargeback",
    amount: 75,
    currency: "USD",
  });
  addAttributedClick(prisma, "camp-pending");
  await listener.recordFunnelEvent("CHARGEBACK", {
    eventId: "chargeback-75",
    userId: "user-1",
    amount: 75,
    currency: "USD",
    originalPaymentExternalEventId: "payment-chargeback",
    occurredAt: "2026-07-01T12:00:00.000Z",
  });
  const duplicate = await listener.recordFunnelEvent("CHARGEBACK", {
    eventId: "chargeback-75",
    userId: "user-1",
    amount: 75,
    currency: "USD",
    originalPaymentExternalEventId: "payment-chargeback",
    occurredAt: "2026-07-01T12:00:00.000Z",
  });

  assert.equal(duplicate.duplicate, true);
  const chargeback = prisma.__state.funnelEvents.find((event) => event.stage === "CHARGEBACK");
  assert.equal(chargeback.value, -75);
  assert.equal(chargeback.campaignExternalId, "camp-chargeback");

  const chargebackMetrics = await aggregation.computeFunnelMetrics("META", "camp-chargeback", "2026-07-01", {
    currency: "USD",
  });
  assert.equal(chargebackMetrics.chargebacks, 1);
  assert.equal(chargebackMetrics.netRevenue, 0);

  await recordPayment(listener, {
    eventId: "payment-pending-refund",
    campaignExternalId: "camp-pending",
    amount: 50,
    currency: "USD",
  });
  await listener.recordFunnelEvent("REFUND", {
    eventId: "refund-pending",
    userId: "user-1",
    amount: 10,
    currency: "USD",
    monetaryStatus: "PENDING",
    originalPaymentExternalEventId: "payment-pending-refund",
    occurredAt: "2026-07-01T13:00:00.000Z",
  });

  const pendingMetrics = await aggregation.computeFunnelMetrics("META", "camp-pending", "2026-07-01", {
    currency: "USD",
  });
  assert.equal(pendingMetrics.refunds, 0);
  assert.equal(pendingMetrics.netRevenue, 50);
});

test("missing original payment references are persisted as unresolved adjustments", async () => {
  const { prisma, listener } = buildHarness();

  const result = await listener.recordFunnelEvent("REFUND", {
    eventId: "refund-missing-payment",
    userId: "user-1",
    amount: 12,
    currency: "EUR",
    originalPaymentExternalEventId: "payment-missing",
    occurredAt: "2026-07-01T11:00:00.000Z",
  });

  const event = prisma.__state.funnelEvents.find((row) => row.externalEventId === "refund-missing-payment");
  assert.equal(event.stage, "REFUND");
  assert.equal(event.attributionStatus, "UNRESOLVED");
  assert.equal(event.unresolvedReason, "MISSING_ORIGINAL_PAYMENT");
  assert.equal(result.attribution.unresolvedReason, "MISSING_ORIGINAL_PAYMENT");
});
