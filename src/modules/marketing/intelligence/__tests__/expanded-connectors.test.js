const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateNormalizedRow } = require("../connectors/connector.interface");
const xConnector = require("../connectors/x.connector");
const linkedinConnector = require("../connectors/linkedin.connector");
const googleAdsConnector = require("../connectors/googleads.connector");
const { sanitizeProviderText } = require("../connectors/provider-http");

test("X connector normalizes micro-unit spend and daily analytics rows", () => {
  const rows = xConnector.normalizeAnalyticsRows(
    {
      data: [
        {
          id: "x-camp-1",
          id_data: [
            {
              segment: { segment_name: "2026-07-01" },
              metrics: {
                date: ["2026-07-01"],
                billed_charge_local_micro: [1234567],
                impressions: [1000],
                clicks: [25],
              },
            },
          ],
        },
      ],
    },
    new Map([["x-camp-1", "X Campaign"]]),
    "USD",
  );

  assert.equal(xConnector.microToSpend(1234567), "1.23");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, "X");
  assert.equal(rows[0].campaignExternalId, "x-camp-1");
  assert.equal(rows[0].campaignName, "X Campaign");
  assert.equal(rows[0].currency, "USD");
  assert.equal(rows[0].spend, "1.23");
  assert.equal(validateNormalizedRow(rows[0]).ok, true);
});

test("LinkedIn connector normalizes adAnalytics rows", () => {
  const row = linkedinConnector.normalizeAnalyticsRow(
    {
      pivotValues: ["urn:li:sponsoredCampaign:123"],
      dateRange: { start: { year: 2026, month: 7, day: 1 } },
      costInLocalCurrency: "45.678",
      impressions: 2000,
      clicks: 50,
    },
    new Map([["urn:li:sponsoredCampaign:123", "LinkedIn Campaign"]]),
    "EUR",
  );

  assert.equal(row.platform, "LINKEDIN");
  assert.equal(row.campaignExternalId, "123");
  assert.equal(row.campaignName, "LinkedIn Campaign");
  assert.equal(row.date, "2026-07-01");
  assert.equal(row.currency, "EUR");
  assert.equal(row.spend, "45.68");
  assert.equal(validateNormalizedRow(row).ok, true);
});

test("Google Ads connector normalizes GAQL rows and validates customer ids", () => {
  const row = googleAdsConnector.normalizeRow(
    {
      campaign: { id: "789", name: "Google Campaign" },
      segments: { date: "2026-07-01" },
      metrics: {
        costMicros: "9876543",
        impressions: "3000",
        clicks: "75",
      },
    },
    "GBP",
  );

  assert.equal(googleAdsConnector.normalizeCustomerId("123-456-7890"), "1234567890");
  assert.equal(row.platform, "GOOGLE_ADS");
  assert.equal(row.campaignExternalId, "789");
  assert.equal(row.currency, "GBP");
  assert.equal(row.spend, "9.88");
  assert.equal(validateNormalizedRow(row).ok, true);
});

test("provider error sanitizer redacts expanded provider secret names", () => {
  const sanitized = sanitizeProviderText(
    'consumer_secret=abc access_token_secret=def developer_token=ghi Authorization: Bearer token client_secret":"jkl"',
  );

  assert.ok(!sanitized.includes("abc"));
  assert.ok(!sanitized.includes("def"));
  assert.ok(!sanitized.includes("ghi"));
  assert.ok(!sanitized.includes("Bearer token"));
  assert.ok(!sanitized.includes("jkl"));
  assert.ok(sanitized.includes("***REDACTED***"));
});
