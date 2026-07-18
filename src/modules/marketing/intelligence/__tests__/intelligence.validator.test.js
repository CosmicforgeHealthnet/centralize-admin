const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  performanceQuerySchema,
  connectionUpsertSchema,
} = require("../intelligence.validator");

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

test("rejects malformed dates", () => {
  assert.equal(performanceQuerySchema.safeParse({ from: "01-06-2026" }).success, false);
  assert.equal(performanceQuerySchema.safeParse({ from: "2026-02-31" }).success, false);
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
