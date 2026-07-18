const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createAttributionService } = require("../attribution.service");
const { createFunnelIngestionService } = require("../funnel-ingestion.service");
const { createFunnelEventListener } = require("../listeners/funnel-event.listener");
const { createFakePrisma } = require("./helpers/fake-prisma");

const silentLog = { info() {}, warn() {}, error() {} };

function harness() {
  const prisma = createFakePrisma();
  const aggregationService = {
    resolvePlatformFromSource(source) {
      if (["meta", "facebook", "instagram"].includes(String(source).toLowerCase())) return "META";
      if (String(source).toLowerCase() === "tiktok") return "TIKTOK";
      return null;
    },
    async reconcileSnapshotFunnel() {
      return null;
    },
  };
  const listener = createFunnelEventListener({ prisma, aggregationService, log: silentLog });
  const attribution = createAttributionService({ prisma });
  const ingestion = createFunnelIngestionService({ attribution, listener });
  return { prisma, attribution, ingestion };
}

test("captures paid click attribution and records one click funnel event", async () => {
  const { prisma, ingestion } = harness();

  const result = await ingestion.captureClick({
    anonId: "anon-1",
    source: "facebook",
    campaignExternalId: "meta-camp-1",
    campaignName: "Doctor Acquisition July",
    utmParams: {
      utm_source: "facebook",
      utm_medium: "paid_social",
      utm_campaign: "doctor_acquisition_july",
      utm_content: "creative_a",
      utm_term: null,
    },
    occurredAt: "2026-07-15T10:00:00.000Z",
  });

  assert.equal(result.attribution.platform, "META");
  assert.equal(result.attribution.campaignExternalId, "meta-camp-1");
  assert.equal(prisma.__state.funnelEvents.length, 1);
  assert.equal(prisma.__state.funnelEvents[0].stage, "CLICK");
  assert.equal(prisma.__state.funnelEvents[0].externalEventId, "click:anon-1:facebook:meta-camp-1:2026-07-15");
});

test("duplicate click capture is idempotent for the funnel event", async () => {
  const { prisma, ingestion } = harness();
  const payload = {
    anonId: "anon-dup",
    source: "tiktok",
    campaignExternalId: "tt-camp-1",
    occurredAt: "2026-07-15T10:00:00.000Z",
  };

  await ingestion.captureClick(payload);
  const second = await ingestion.captureClick(payload);

  assert.equal(second.funnelEvent.duplicate, true);
  assert.equal(prisma.__state.funnelEvents.length, 1);
});

test("first paid touch survives later direct visits", async () => {
  const { prisma, ingestion } = harness();

  await ingestion.captureClick({
    anonId: "anon-first-touch",
    source: "facebook",
    campaignExternalId: "meta-camp-1",
    occurredAt: "2026-07-15T10:00:00.000Z",
  });
  const direct = await ingestion.captureClick({
    anonId: "anon-first-touch",
    source: "direct",
    occurredAt: "2026-07-15T11:00:00.000Z",
  });

  const attribution = prisma.__state.attributions[0];
  assert.equal(attribution.source, "facebook");
  assert.equal(attribution.campaignExternalId, "meta-camp-1");
  assert.equal(direct.funnelEvent.skipped, true);
  assert.equal(prisma.__state.funnelEvents.length, 1);
});

test("signup links anonymous attribution to the user and preserves campaign data", async () => {
  const { prisma, ingestion } = harness();

  await ingestion.captureClick({
    anonId: "anon-signup",
    source: "facebook",
    campaignExternalId: "meta-camp-1",
    occurredAt: "2026-07-15T10:00:00.000Z",
  });
  await ingestion.recordSignup({
    userId: "user-1",
    anonId: "anon-signup",
    occurredAt: "2026-07-15T10:05:00.000Z",
  });

  const attribution = prisma.__state.attributions[0];
  const signup = prisma.__state.funnelEvents.find((event) => event.stage === "SIGNUP");
  assert.equal(attribution.userId, "user-1");
  assert.ok(attribution.convertedAt instanceof Date);
  assert.equal(signup.campaignExternalId, "meta-camp-1");
  assert.equal(signup.source, "facebook");
  assert.equal(signup.externalEventId, "signup:user-1");
});

test("payment attribution resolves from the linked user without checkout resending UTM", async () => {
  const { prisma, ingestion } = harness();

  await ingestion.captureClick({
    anonId: "anon-payment",
    source: "tiktok",
    campaignExternalId: "tt-camp-1",
    occurredAt: "2026-07-15T10:00:00.000Z",
  });
  await ingestion.recordSignup({ userId: "user-pay", anonId: "anon-payment" });
  await ingestion.recordPayment({
    transactionId: "tx-1",
    userId: "user-pay",
    amount: 150.5,
    currency: "USD",
    occurredAt: "2026-07-15T12:00:00.000Z",
  });

  const payment = prisma.__state.funnelEvents.find((event) => event.stage === "PAYMENT");
  assert.equal(payment.campaignExternalId, "tt-camp-1");
  assert.equal(payment.source, "tiktok");
  assert.equal(payment.value, 150.5);
  assert.equal(payment.currency, "USD");
  assert.equal(payment.externalEventId, "payment:tx-1");
});