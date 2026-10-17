const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createIntelligenceService } = require("../intelligence.service");
const { createFakePrisma } = require("./helpers/fake-prisma");

// Small Decimal stand-in to prove the service converts before serializing.
class FakeDecimal {
  constructor(value) {
    this.value = value;
  }
  valueOf() {
    return this.value;
  }
  toJSON() {
    throw new Error("Decimal must not be serialized directly");
  }
}

function seedSnapshots(prisma) {
  const day = (dateString) => new Date(`${dateString}T00:00:00.000Z`);
  prisma.__state.snapshots.push(
    {
      id: "s1",
      platform: "META",
      campaignExternalId: "meta-1",
      campaignName: "Meta One",
      date: day("2026-07-01"),
      spend: new FakeDecimal(100),
      currency: "USD",
      impressions: 1000,
      clicks: 100,
      signups: 10,
      activeUsers: 5,
      payments: 2,
      revenue: new FakeDecimal(200),
    },
    {
      id: "s2",
      platform: "META",
      campaignExternalId: "meta-1",
      campaignName: "Meta One",
      date: day("2026-07-02"),
      spend: new FakeDecimal(300),
      currency: "USD",
      impressions: 2000,
      clicks: 100,
      signups: 30,
      activeUsers: 15,
      payments: 6,
      revenue: new FakeDecimal(600),
    },
    {
      id: "s3",
      platform: "TIKTOK",
      campaignExternalId: "tt-1",
      campaignName: "TikTok One",
      date: day("2026-07-01"),
      spend: new FakeDecimal(50),
      currency: "USD",
      impressions: 500,
      clicks: 50,
      signups: 5,
      activeUsers: 2,
      payments: 1,
      revenue: new FakeDecimal(75),
    },
    {
      id: "s4",
      platform: "META",
      campaignExternalId: "meta-2",
      campaignName: "Meta Two",
      date: day("2026-07-03"),
      spend: new FakeDecimal(999),
      currency: "USD",
      impressions: 100,
      clicks: 10,
      signups: 0,
      activeUsers: 0,
      payments: 0,
      revenue: new FakeDecimal(0),
    },
  );
}

test("groups snapshots by campaign and returns summary totals", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
    platform: "all",
  });

  assert.equal(result.campaigns.length, 3);
  assert.equal(result.summary.spend, 1449);
  assert.equal(result.summary.impressions, 3600);
  assert.equal(result.summary.clicks, 260);
  assert.equal(result.summary.signups, 45);
  assert.equal(result.summary.activeUsers, 22);
  assert.equal(result.summary.payments, 9);
  assert.equal(result.summary.revenue, 875);
  assert.equal(result.summary.netRevenue, 875);
  assert.equal(result.summary.currency, "USD");
  assert.equal(result.summary.mixedCurrencies, false);
  assert.equal(result.summaryByCurrency.length, 1);
  assert.equal(result.campaigns[0].currency, "USD");
});

test("mixed currencies return summaryByCurrency without combined money totals", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  prisma.__state.snapshots.push({
    id: "s5",
    platform: "LINKEDIN",
    campaignExternalId: "li-1",
    campaignName: "LinkedIn One",
    date: new Date("2026-07-01T00:00:00.000Z"),
    spend: new FakeDecimal(25),
    currency: "EUR",
    impressions: 250,
    clicks: 25,
    signups: 5,
    activeUsers: 3,
    payments: 1,
    revenue: new FakeDecimal(50),
  });
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
    platform: "all",
  });

  assert.equal(result.summary.mixedCurrencies, true);
  assert.equal(result.summary.spend, null);
  assert.equal(result.summary.revenue, null);
  assert.equal(result.summary.netRevenue, null);
  assert.equal(result.summary.cpa, null);
  assert.equal(result.summary.roas, null);
  assert.deepEqual(
    result.summaryByCurrency.map((row) => row.currency),
    ["EUR", "USD"],
  );
  assert.equal(result.summaryByCurrency.find((row) => row.currency === "EUR").spend, 25);
});

test("net revenue and ROAS respect same-currency compatibility", async () => {
  const prisma = createFakePrisma();
  prisma.__state.snapshots.push(
    {
      id: "net-1",
      platform: "META",
      campaignExternalId: "camp-net",
      campaignName: "Net Revenue",
      date: new Date("2026-07-01T00:00:00.000Z"),
      spend: new FakeDecimal(100),
      currency: "USD",
      impressions: 1000,
      clicks: 100,
      signups: 10,
      activeUsers: 4,
      payments: 2,
      refunds: 1,
      chargebacks: 1,
      revenue: new FakeDecimal(150),
      netRevenue: new FakeDecimal(110),
      currencyCompatibility: true,
    },
    {
      id: "net-2",
      platform: "META",
      campaignExternalId: "camp-incompatible",
      campaignName: "Currency Mismatch",
      date: new Date("2026-07-01T00:00:00.000Z"),
      spend: new FakeDecimal(50),
      currency: "USD",
      impressions: 500,
      clicks: 50,
      signups: 5,
      activeUsers: 2,
      payments: 1,
      refunds: 0,
      chargebacks: 0,
      revenue: new FakeDecimal(75),
      netRevenue: new FakeDecimal(75),
      currencyCompatibility: false,
    },
  );
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-01",
    platform: "meta",
  });

  const net = result.campaigns.find((row) => row.campaignExternalId === "camp-net");
  const incompatible = result.campaigns.find((row) => row.campaignExternalId === "camp-incompatible");
  assert.equal(net.netRevenue, 110);
  assert.equal(net.roas, 1.1);
  assert.equal(incompatible.roas, null);
  assert.equal(result.summary.currencyCompatibility, false);
  assert.equal(result.summary.roas, null);
  assert.equal(result.summaryByCurrency[0].roas, null);
});

test("aggregate CPA uses total spend / total signups, never averaged dailies", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
    platform: "meta",
  });

  const metaOne = result.campaigns.find((c) => c.campaignExternalId === "meta-1");
  // Daily CPAs are 10 and 10  but totals are 400 / 40 = 10. Construct the
  // asymmetric check on conversion rate instead: totals 8/200*100 = 4%,
  // while averaging dailies (2% and 6%) would also give 4  so assert on the
  // summary across unequal campaigns: total spend 1399 / 40 signups.
  assert.equal(metaOne.cpa, 10);
  assert.equal(result.summary.cpa, Math.round((1399 / 40) * 100) / 100);
  assert.equal(result.summary.conversionRate, Math.round((8 / 210) * 100 * 100) / 100);
});

test("campaign-level zero denominators yield 0", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
  });
  const metaTwo = result.campaigns.find((c) => c.campaignExternalId === "meta-2");
  assert.equal(metaTwo.cpa, 0);
  assert.equal(metaTwo.conversionRate, 0);
});

test("platform filter narrows results", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
    platform: "tiktok",
  });

  assert.equal(result.campaigns.length, 1);
  assert.equal(result.campaigns[0].platform, "TIKTOK");
  assert.equal(result.summary.spend, 50);
});

test("date filter narrows results", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-01",
  });

  assert.equal(result.summary.spend, 150); // s1 + s3 only
});

test("campaigns sort by spend descending", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
  });

  const spends = result.campaigns.map((c) => c.spend);
  assert.deepEqual(spends, [...spends].sort((a, b) => b - a));
  assert.equal(result.campaigns[0].campaignExternalId, "meta-2");
});

test("values serialize as plain JSON numbers, not Decimal objects", async () => {
  const prisma = createFakePrisma();
  seedSnapshots(prisma);
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({
    from: "2026-07-01",
    to: "2026-07-31",
  });

  const serialized = JSON.parse(JSON.stringify(result));
  assert.equal(typeof serialized.summary.spend, "number");
  assert.equal(typeof serialized.campaigns[0].revenue, "number");
  assert.ok(Number.isFinite(serialized.summary.cpa));
});

test("the dashboard never talks to advertising providers", async () => {
  // The service must be constructible with nothing but a database handle and
  // must not import connectors or any HTTP client.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "intelligence.service.js"),
    "utf8",
  );
  assert.ok(!source.includes("connectors/"));
  assert.ok(!source.includes("axios"));
  assert.ok(!/https?:\/\//.test(source.replace(/\/\/.*$/gm, "")));

  // And functionally: a prisma-only fake is sufficient to serve the dashboard.
  const prisma = createFakePrisma();
  const service = createIntelligenceService({ prisma });
  const result = await service.getPerformanceDashboard({ platform: "meta" });
  assert.deepEqual(result.campaigns, []);
});

test("an empty range returns a valid empty response with defaults applied", async () => {
  const prisma = createFakePrisma();
  const service = createIntelligenceService({ prisma });

  const result = await service.getPerformanceDashboard({});

  assert.deepEqual(result.campaigns, []);
  assert.equal(result.summary.spend, 0);
  assert.equal(result.summary.cpa, 0);
  assert.equal(result.summary.conversionRate, 0);
  assert.equal(result.filters.platform, "all");
  assert.match(result.filters.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(result.filters.to, /^\d{4}-\d{2}-\d{2}$/);
});
