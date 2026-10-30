const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  performanceQuerySchema,
  connectionUpsertSchema,
  funnelEventEnvelopeSchema,
  providerValidationEvidenceSchema,
  FUNNEL_EVENT_TYPES,
} = require("../intelligence.validator");
const {
  creativeSyncSchema,
  creativeScoreSchema,
} = require("../creative/creative.validator");

test("accepts a valid query", () => {
  const result = performanceQuerySchema.safeParse({
    from: "2026-06-01",
    to: "2026-07-01",
    platform: "meta",
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    from: "2026-06-01",
    to: "2026-07-01",
    platform: "meta",
  });
});

test("defaults platform to all and allows omitted dates", () => {
  const result = performanceQuerySchema.safeParse({});
  assert.equal(result.success, true);
  assert.equal(result.data.platform, "all");
  assert.equal(result.data.from, undefined);
});

test("platform is case-insensitive", () => {
  const result = performanceQuerySchema.safeParse({ platform: "TikTok" });
  assert.equal(result.success, true);
  assert.equal(result.data.platform, "tiktok");
});

test("accepts expanded provider platform filters", () => {
  for (const platform of ["x", "linkedin", "google_ads"]) {
    const result = performanceQuerySchema.safeParse({ platform });
    assert.equal(result.success, true);
    assert.equal(result.data.platform, platform);
  }
});

test("rejects an unknown platform", () => {
  const result = performanceQuerySchema.safeParse({ platform: "google" });
  assert.equal(result.success, false);
});

test("accepts provider-specific encrypted credential payloads", () => {
  const result = connectionUpsertSchema.safeParse({
    platform: "GOOGLE_ADS",
    accountId: "1234567890",
    credentials: {
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      developerToken: "developer",
    },
    connectionMetadata: {
      customerId: "1234567890",
      loginCustomerId: "0987654321",
      apiVersion: "v24",
    },
    currency: "usd",
  });

  assert.equal(result.success, true);
});

test("accepts refund and chargeback funnel event envelopes with normalized currency", () => {
  assert.ok(FUNNEL_EVENT_TYPES.includes("PAYMENT_REFUNDED"));
  assert.ok(FUNNEL_EVENT_TYPES.includes("PAYMENT_CHARGEBACK"));

  for (const eventType of ["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK"]) {
    const result = funnelEventEnvelopeSchema.safeParse({
      eventId: `${eventType}-1`,
      eventType,
      occurredAt: "2026-07-01T10:00:00.000Z",
      payload: {
        userId: "user-1",
        amount: "12.50",
        currency: "usd",
        originalPaymentExternalEventId: "payment-1",
        occurredAt: "2026-07-01T10:00:00.000Z",
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.data.payload.currency, "USD");
  }
});

test("rejects invalid currencies and zero monetary adjustments", () => {
  assert.equal(
    funnelEventEnvelopeSchema.safeParse({
      eventId: "refund-invalid-currency",
      eventType: "PAYMENT_REFUNDED",
      payload: {
        amount: "10.00",
        currency: "US_D",
        originalPaymentExternalEventId: "payment-1",
      },
    }).success,
    false,
  );
  assert.equal(
    funnelEventEnvelopeSchema.safeParse({
      eventId: "refund-zero",
      eventType: "PAYMENT_REFUNDED",
      payload: {
        amount: "0",
        currency: "USD",
        originalPaymentExternalEventId: "payment-1",
      },
    }).success,
    false,
  );
});

test("rejects malformed dates", () => {
  assert.equal(performanceQuerySchema.safeParse({ from: "01-06-2026" }).success, false);
  assert.equal(performanceQuerySchema.safeParse({ from: "2026-02-31" }).success, false);
});

test("creative sync and scoring reject impossible and oversized date ranges", () => {
  assert.equal(creativeSyncSchema.safeParse({ since: "2026-02-31", until: "2026-03-01" }).success, false);
  assert.equal(creativeScoreSchema.safeParse({ since: "2026-01-01", until: "2027-02-01" }).success, false);
  assert.equal(creativeSyncSchema.safeParse({ since: "2026-01-01", until: "2027-02-01" }).success, false);
});

test("rejects a reversed date range", () => {
  const result = performanceQuerySchema.safeParse({
    from: "2026-07-05",
    to: "2026-07-01",
  });
  assert.equal(result.success, false);
});

test("rejects an unreasonably large date range", () => {
  const result = performanceQuerySchema.safeParse({
    from: "2020-01-01",
    to: "2026-07-01",
  });
  assert.equal(result.success, false);
});

test("rejects unknown query parameters", () => {
  const result = performanceQuerySchema.safeParse({ platform: "all", nope: "1" });
  assert.equal(result.success, false);
});

test("provider validation evidence requires explicit completed checks", () => {
  assert.equal(providerValidationEvidenceSchema.safeParse({}).success, false);
  assert.equal(
    providerValidationEvidenceSchema.safeParse({ metricReconciled: false }).success,
    false,
  );
  assert.equal(
    providerValidationEvidenceSchema.safeParse({
      connectionTestPassed: true,
      checkedAt: "2026-07-19T08:00:00.000Z",
    }).success,
    true,
  );
});
