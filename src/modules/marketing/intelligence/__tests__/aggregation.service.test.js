const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createAggregationService,
  deriveMetrics,
  resolvePlatformFromSource,
} = require("../aggregation/aggregation.service");
const { createSyncLock } = require("../aggregation/sync-lock");
const { createFakePrisma } = require("./helpers/fake-prisma");

const silentLog = { info() {}, warn() {}, error() {} };

function metaRow(overrides = {}) {
  return {
    platform: "META",
    campaignExternalId: "meta-camp-1",
    campaignName: "Meta Campaign",
    date: "2026-07-01",
    spend: "100.00",
    impressions: 5000,
    clicks: 200,
    raw: { campaign_id: "meta-camp-1", spend: "100.00" },
    ...overrides,
  };
}

function tiktokRow(overrides = {}) {
  return {
    platform: "TIKTOK",
    campaignExternalId: "tt-camp-1",
    campaignName: "TikTok Campaign",
    date: "2026-07-01",
    spend: "50.00",
    impressions: 3000,
    clicks: 100,
    raw: { dimensions: { campaign_id: "tt-camp-1" } },
    ...overrides,
  };
}

function connectorStub(platform, rows) {
  return {
    platform,
    validateConfiguration: () => ({ ok: true }),
    fetchDailyCampaignInsights: async () => rows,
  };
}

function buildService(prisma, connectors) {
  return createAggregationService({
    prisma,
    connectors,
    syncLock: createSyncLock({ prisma }),
    log: silentLog,
  });
}

test("sync stores raw insights and inserts snapshots for both platforms", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, {
    META: connectorStub("META", [metaRow()]),
    TIKTOK: connectorStub("TIKTOK", [tiktokRow()]),
  });

  const result = await service.syncMarketingInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    trigger: "test",
  });

  assert.equal(result.platforms.META.status, "SUCCESS");
  assert.equal(result.platforms.META.inserted, 1);
  assert.equal(result.platforms.TIKTOK.inserted, 1);
  assert.equal(prisma.__state.rawInsights.length, 2);
  assert.equal(prisma.__state.snapshots.length, 2);
  // Raw provider rows are stored untouched.
  assert.deepEqual(prisma.__state.rawInsights[0].rawJson, {
    campaign_id: "meta-camp-1",
    spend: "100.00",
  });
});

test("default sync covers all five advertising platforms", async () => {
  const prisma = createFakePrisma();
  const platforms = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];
  const connectors = Object.fromEntries(
    platforms.map((platform) => [
      platform,
      connectorStub(platform, [
        metaRow({
          platform,
          campaignExternalId: `${platform.toLowerCase()}-camp-1`,
          campaignName: `${platform} Campaign`,
          currency: platform === "LINKEDIN" ? "EUR" : "USD",
          raw: { platform },
        }),
      ]),
    ]),
  );
  const service = buildService(prisma, connectors);

  const result = await service.syncMarketingInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    trigger: "test",
  });

  for (const platform of platforms) {
    assert.equal(result.platforms[platform].status, "SUCCESS");
    assert.equal(result.platforms[platform].inserted, 1);
  }
  assert.equal(prisma.__state.snapshots.length, 5);
  assert.equal(prisma.__state.snapshots.find((row) => row.platform === "LINKEDIN").currency, "EUR");
});

test("re-running the same range updates instead of duplicating", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, {
    META: connectorStub("META", [metaRow()]),
  });

  await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });
  const second = await service.syncMarketingInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    platforms: ["META"],
  });

  assert.equal(second.platforms.META.inserted, 0);
  assert.equal(second.platforms.META.updated, 1);
  assert.equal(prisma.__state.snapshots.length, 1);
  assert.equal(prisma.__state.rawInsights.length, 1);
});

test("same campaign id in two active accounts is stored as two snapshots", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push(
    {
      id: "conn-meta-a",
      platform: "META",
      accountId: "act_111",
      status: "ACTIVE",
      lastSyncedAt: null,
      lastSyncError: null,
    },
    {
      id: "conn-meta-b",
      platform: "META",
      accountId: "act_222",
      status: "ACTIVE",
      lastSyncedAt: null,
      lastSyncError: null,
    },
  );
  const service = buildService(prisma, {
    META: {
      platform: "META",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async () => [metaRow({ campaignExternalId: "shared-campaign" })],
    },
  });

  const result = await service.syncMarketingInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    platforms: ["META"],
  });

  assert.equal(result.platforms.META.inserted, 2);
  assert.equal(prisma.__state.snapshots.length, 2);
  assert.deepEqual(
    prisma.__state.snapshots.map((row) => row.accountId).sort(),
    ["act_111", "act_222"],
  );
});

test("funnel events aggregate into the snapshot with CPA, conversion rate and revenue", async () => {
  const prisma = createFakePrisma();

  const day = (time) => new Date(`2026-07-01T${time}:00.000Z`);
  prisma.__state.funnelEvents.push(
    { stage: "SIGNUP", source: "facebook", campaignExternalId: "meta-camp-1", occurredAt: day("01:00"), value: null },
    { stage: "SIGNUP", source: "meta", campaignExternalId: "meta-camp-1", occurredAt: day("02:00"), value: null },
    { stage: "ACTIVE", source: "instagram", campaignExternalId: "meta-camp-1", occurredAt: day("03:00"), value: null },
    { stage: "PAYMENT", source: "meta", campaignExternalId: "meta-camp-1", occurredAt: day("04:00"), value: 150.5 },
    { stage: "PAYMENT", source: null, campaignExternalId: "meta-camp-1", occurredAt: day("05:00"), value: 49.5 },
    // Different platform source must NOT attribute to the Meta snapshot.
    { stage: "PAYMENT", source: "tiktok", campaignExternalId: "meta-camp-1", occurredAt: day("06:00"), value: 999 },
    // Outside the day window must not count.
    { stage: "SIGNUP", source: "meta", campaignExternalId: "meta-camp-1", occurredAt: new Date("2026-07-02T00:00:00.000Z"), value: null },
  );

  const service = buildService(prisma, {
    META: connectorStub("META", [metaRow()]),
  });

  await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });

  const snapshot = prisma.__state.snapshots[0];
  assert.equal(snapshot.signups, 2);
  assert.equal(snapshot.activeUsers, 1);
  assert.equal(snapshot.payments, 2);
  assert.equal(snapshot.revenue, 200);
  assert.equal(snapshot.cpa, 50); // 100.00 spend / 2 signups
  assert.equal(snapshot.conversionRate, 1); // 2 payments / 200 clicks * 100
});

test("zero denominators produce 0, never Infinity or NaN", () => {
  assert.deepEqual(
    deriveMetrics({ spend: 100, signups: 0, clicks: 0, payments: 0 }),
    { cpa: 0, conversionRate: 0 },
  );
});

test("a failing platform does not stop the other platform", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, {
    META: {
      platform: "META",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async () => {
        throw new Error("Meta exploded");
      },
    },
    TIKTOK: connectorStub("TIKTOK", [tiktokRow()]),
  });

  const result = await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01" });

  assert.equal(result.platforms.META.status, "FAILED");
  assert.equal(result.platforms.TIKTOK.status, "SUCCESS");
  assert.equal(prisma.__state.snapshots.length, 1);
});

test("a failing TikTok does not stop Meta (reverse direction)", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, {
    META: connectorStub("META", [metaRow()]),
    TIKTOK: {
      platform: "TIKTOK",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async () => {
        throw new Error("TikTok exploded");
      },
    },
  });

  const result = await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01" });

  assert.equal(result.platforms.TIKTOK.status, "FAILED");
  assert.equal(result.platforms.META.status, "SUCCESS");
  assert.equal(prisma.__state.snapshots.length, 1);
  assert.equal(prisma.__state.snapshots[0].platform, "META");
});

test("rotated provider tokens are persisted encrypted on the connection", async () => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = require("crypto")
    .randomBytes(32)
    .toString("hex");

  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: "conn-tt",
    platform: "TIKTOK",
    accountId: "adv-1",
    accessToken: require("../utils/credential-encryption").encryptCredential("old-access"),
    refreshToken: null,
    status: "ACTIVE",
    lastSyncedAt: null,
    lastSyncError: null,
  });

  const expiresAt = new Date(Date.now() + 86400 * 1000);
  const service = buildService(prisma, {
    TIKTOK: {
      platform: "TIKTOK",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async ({ onTokensRefreshed }) => {
        await onTokensRefreshed({
          accessToken: "plain-new-access",
          refreshToken: "plain-new-refresh",
          accessTokenExpiresAt: expiresAt,
        });
        return [tiktokRow()];
      },
    },
  });

  await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["TIKTOK"] });

  const connection = prisma.__state.connections[0];
  // Stored encrypted, never plaintext.
  assert.ok(connection.accessToken.startsWith("v1:"));
  assert.ok(!connection.accessToken.includes("plain-new-access"));
  assert.ok(connection.refreshToken.startsWith("v1:"));
  assert.equal(connection.accessTokenExpiresAt, expiresAt);
  assert.ok(connection.lastSyncedAt instanceof Date);
});

test("malformed normalized rows are rejected without corrupting the run", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, {
    META: connectorStub("META", [
      metaRow(),
      metaRow({ campaignExternalId: "", date: "not-a-date" }),
    ]),
  });

  const result = await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });

  assert.equal(result.platforms.META.status, "PARTIAL");
  assert.equal(result.platforms.META.inserted, 1);
  assert.equal(result.platforms.META.failed, 1);
});

test("database connections get lastSyncedAt and error status updates", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: "conn-1",
    platform: "META",
    accountId: "acct",
    status: "ACTIVE",
    lastSyncedAt: null,
    lastSyncError: null,
  });

  const okService = buildService(prisma, {
    META: {
      platform: "META",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async ({ connection }) => {
        assert.equal(connection.id, "conn-1");
        return [metaRow()];
      },
    },
  });
  await okService.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });
  assert.ok(prisma.__state.connections[0].lastSyncedAt instanceof Date);

  const authError = new Error("token expired access_token=secret123");
  authError.kind = "auth";
  const failingService = buildService(prisma, {
    META: {
      platform: "META",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async () => {
        throw authError;
      },
    },
  });
  await failingService.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });

  assert.equal(prisma.__state.connections[0].status, "ERROR");
  assert.equal(prisma.__state.connections[0].requiresReauthorization, true);
  assert.ok(!prisma.__state.connections[0].lastSyncError.includes("secret123"));
});

test("inactive database connections prevent environment fallback", async () => {
  const prisma = createFakePrisma();
  prisma.__state.connections.push({
    id: "conn-disabled",
    platform: "META",
    accountId: "act_meta_123",
    status: "DISABLED",
    lastSyncedAt: null,
    lastSyncError: null,
  });

  let fetched = false;
  const service = buildService(prisma, {
    META: {
      platform: "META",
      validateConfiguration: () => ({ ok: true }),
      fetchDailyCampaignInsights: async () => {
        fetched = true;
        return [metaRow()];
      },
    },
  });

  const result = await service.syncMarketingInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    platforms: ["META"],
  });

  assert.equal(result.platforms.META.status, "SKIPPED_NO_CREDENTIALS");
  assert.equal(fetched, false);
  assert.equal(prisma.__state.snapshots.length, 0);
});
test("overlapping runs are skipped via the lock", async () => {
  const prisma = createFakePrisma();
  const lock = createSyncLock({ prisma });
  const holder = await lock.acquire();
  assert.ok(holder);

  const service = createAggregationService({
    prisma,
    connectors: { META: connectorStub("META", [metaRow()]) },
    syncLock: lock,
    log: silentLog,
  });

  const result = await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "sync_already_running");
});

test("the lock is released after a run so the next run proceeds", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, { META: connectorStub("META", [metaRow()]) });

  const first = await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });
  const second = await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });

  assert.ok(!first.skipped);
  assert.ok(!second.skipped);
});

test("invalid date ranges are rejected", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, { META: connectorStub("META", []) });

  await assert.rejects(
    service.syncMarketingInsights({ since: "2026-07-05", until: "2026-07-01" }),
    /since must not be after until/,
  );
  await assert.rejects(
    service.syncMarketingInsights({ since: "bad", until: "2026-07-01" }),
    /YYYY-MM-DD/,
  );
});

test("reconcileSnapshotFunnel recomputes funnel metrics on an existing snapshot", async () => {
  const prisma = createFakePrisma();
  const service = buildService(prisma, { META: connectorStub("META", [metaRow()]) });

  await service.syncMarketingInsights({ since: "2026-07-01", until: "2026-07-01", platforms: ["META"] });
  assert.equal(prisma.__state.snapshots[0].payments, 0);

  // A delayed payment lands after the sync.
  prisma.__state.funnelEvents.push({
    stage: "PAYMENT",
    source: "meta",
    campaignExternalId: "meta-camp-1",
    occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    value: 75,
  });

  await service.reconcileSnapshotFunnel({
    platform: "META",
    campaignExternalId: "meta-camp-1",
    date: "2026-07-01",
  });

  const snapshot = prisma.__state.snapshots[0];
  assert.equal(snapshot.payments, 1);
  assert.equal(snapshot.revenue, 75);
  assert.equal(snapshot.conversionRate, 0.5); // 1 / 200 clicks * 100
});

test("source aliases map consistently to platforms", () => {
  assert.equal(resolvePlatformFromSource("meta"), "META");
  assert.equal(resolvePlatformFromSource("Facebook"), "META");
  assert.equal(resolvePlatformFromSource("instagram"), "META");
  assert.equal(resolvePlatformFromSource("TikTok"), "TIKTOK");
  assert.equal(resolvePlatformFromSource("twitter_ads"), "X");
  assert.equal(resolvePlatformFromSource("linked_in"), "LINKEDIN");
  assert.equal(resolvePlatformFromSource("google"), "GOOGLE_ADS");
  assert.equal(resolvePlatformFromSource(null), null);
});
