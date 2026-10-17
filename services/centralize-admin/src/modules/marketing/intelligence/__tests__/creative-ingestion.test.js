const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeCreativeAsset,
  normalizeCreativeInsight,
  sanitizeObject,
} = require("../creative/creative.connector.interface");
const { createCreativeRegistry } = require("../creative/creative.registry");
const { createCreativeSyncService, CREATIVE_SYNC_LOCK_KEY } = require("../creative/creative-sync.service");
const { createCreativeRepository } = require("../creative/creative.repository");

const platforms = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];

function asset(overrides = {}) {
  return {
    platform: "META",
    connectionId: "11111111-1111-4111-8111-111111111111",
    accountExternalId: "act_1",
    campaignExternalId: "campaign-1",
    adGroupExternalId: "group-1",
    adExternalId: "ad-1",
    creativeExternalId: "creative-1",
    type: "IMAGE",
    firstSeenAt: "2026-07-01T00:00:00Z",
    lastSeenAt: "2026-07-02T00:00:00Z",
    ...overrides,
  };
}

test("creative normalization is deterministic, sanitized, nullable, and never guesses human presence", () => {
  const first = normalizeCreativeAsset(asset({
    headline: "Headline\u0000 bearer abcdefghijklmnopqrstuvwxyz",
    sourceUrl: "https://cdn.example/a.jpg?access_token=secret&width=10",
    nativeIdentifiers: { adId: "ad-1", authorization: "Bearer secret" },
  }));
  const second = normalizeCreativeAsset(asset());
  assert.equal(first.sourceKey, second.sourceKey);
  assert.equal(first.hasHumanPresence, null);
  assert.equal(new URL(first.sourceUrl).searchParams.has("access_token"), false);
  assert.deepEqual(first.nativeIdentifiers, { adId: "ad-1" });
  assert.doesNotMatch(first.headline, /secret|bearer/i);

  const fallbackA = normalizeCreativeAsset(asset({ creativeExternalId: null, nativeIdentifiers: { adId: "42" } }));
  const fallbackB = normalizeCreativeAsset(asset({ creativeExternalId: null, nativeIdentifiers: { adId: "42" } }));
  assert.equal(fallbackA.creativeExternalId, fallbackB.creativeExternalId);
  assert.match(fallbackA.creativeExternalId, /^fingerprint:/);
});

test("fallback identity ignores mutable names and metric segmentation is key-order stable", () => {
  const first = normalizeCreativeAsset({
    ...asset(),
    creativeExternalId: undefined,
    adExternalId: "stable-ad",
    name: "Original name",
  });
  const renamed = normalizeCreativeAsset({
    ...asset(),
    creativeExternalId: undefined,
    adExternalId: "stable-ad",
    name: "Renamed later",
  });
  assert.equal(first.sourceKey, renamed.sourceKey);
  assert.equal(first.creativeExternalId, renamed.creativeExternalId);

  const left = normalizeCreativeInsight({
    ...asset(),
    date: "2026-07-03",
    segmentation: { placement: "feed", device: "mobile" },
  });
  const right = normalizeCreativeInsight({
    ...asset(),
    date: "2026-07-03",
    segmentation: { device: "mobile", placement: "feed" },
  });
  assert.equal(left.sourceMetricKey, right.sourceMetricKey);
});

test("creative insight normalization uses UTC/exact decimals and separates provider conversions", () => {
  const row = normalizeCreativeInsight({
    ...asset(),
    date: "2026-07-03T22:01:00-07:00",
    currencyCode: "usd",
    spend: "10.123456",
    impressions: "90071992547409930",
    clicks: null,
    providerConversions: "1.5",
    attributedPayments: 99,
    rawProviderRecord: { access_token: "secret", ok: true },
  });
  assert.equal(row.date, "2026-07-03");
  assert.equal(row.spend.toString(), "10.123456");
  assert.equal(row.impressions, 90071992547409930n);
  assert.equal(row.clicks, null);
  assert.equal(row.providerConversions.toString(), "1.5");
  assert.equal(row.attributedPayments, null);
  assert.equal(row.metadata.providerConversionsInformational, true);
  assert.deepEqual(row.rawProviderRecord, { ok: true });
  assert.throws(() => normalizeCreativeInsight({ ...asset(), date: "2026-07-03", spend: "1" }), /currencyCode is required/);
});

test("all five platforms expose explicit creative capability metadata", async () => {
  const providers = Object.fromEntries(platforms.map((platform) => [platform, {
    creativeCapability: { providerApiVersion: "test", supportedMetrics: ["clicks"] },
    async fetchCreativeCatalog() { return { items: [{ ...asset(), platform }], nextCursor: null }; },
    async fetchCreativeInsights() { return { rows: [], nextCursor: null }; },
  }]));
  const registry = createCreativeRegistry({ providers });
  for (const platform of platforms) {
    const connection = { id: asset().connectionId, accountId: "account", platform, connectionMetadata: { creativeApiApproved: true } };
    const current = registry[platform].getCapability(connection);
    assert.equal(current.status, "AVAILABLE");
    assert.equal(current.supportsCreativeCatalog, true);
    assert.equal(current.supportsCreativeInsights, true);
    assert.ok(current.supportedCreativeGrain);
    assert.deepEqual(current.supportedMetrics, ["clicks"]);
    const page = await registry[platform].fetchCreativeCatalog({ connection, since: "2026-07-01", until: "2026-07-02" });
    assert.equal(page.items[0].platform, platform);
  }

  const unsupported = createCreativeRegistry({ providers: { META: {} } }).META.getCapability({ platform: "META" });
  assert.equal(unsupported.status, "UNAVAILABLE");
  assert.equal(unsupported.supportsCreativeCatalog, false);
  const unsupportedPage = await createCreativeRegistry({ providers: { META: {} } }).META.fetchCreativeCatalog({
    connection: { id: asset().connectionId, accountId: "account", platform: "META" },
  });
  assert.equal(unsupportedPage.status, "UNSUPPORTED");
});

test("pagination persists pages, detects repeated cursors, and returns partial completion", async () => {
  const persisted = [];
  let calls = 0;
  const connector = {
    getCapability: () => ({ status: "AVAILABLE", supportsCreativeCatalog: true }),
    async fetchCreativeCatalog() {
      calls += 1;
      return { items: [asset({ creativeExternalId: `c-${calls}` })], nextCursor: "same", capability: this.getCapability() };
    },
  };
  const service = createCreativeSyncService({
    prisma: {}, registry: {},
    repository: {},
    syncLock: {}, runLedger: {},
  });
  const result = await service.fetchPages({
    kind: "catalog", connector,
    connection: { id: asset().connectionId, accountId: "act_1", platform: "META" },
    since: "2026-07-01", until: "2026-07-02",
    persist: async (_context, rows) => persisted.push(...rows),
  });
  assert.equal(calls, 2);
  assert.equal(persisted.length, 2);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.partial, true);
  assert.equal(result.nextCursor, "same");
});

test("creative synchronization isolates connection failures and records partial success", async () => {
  const runUpdates = [];
  const good = {
    getCapability: () => ({ status: "AVAILABLE", supportsCreativeCatalog: true, supportsCreativeInsights: true }),
    async fetchCreativeCatalog() { return { items: [], nextCursor: null, capability: this.getCapability() }; },
    async fetchCreativeInsights() { return { rows: [], nextCursor: null, capability: this.getCapability() }; },
  };
  const bad = {
    getCapability: good.getCapability,
    async fetchCreativeCatalog() { const error = new Error("Bearer top-secret-token permission denied"); error.category = "auth"; throw error; },
    async fetchCreativeInsights() { return { rows: [], nextCursor: null, capability: this.getCapability() }; },
  };
  const lock = {
    acquire: async (key) => { assert.equal(key, CREATIVE_SYNC_LOCK_KEY); return "owner-token"; },
    startHeartbeat: () => ({ failed: () => false, lastError: () => null, stop() {} }),
    release: async () => true,
  };
  const service = createCreativeSyncService({
    prisma: { marketing_ad_platform_connections: { findMany: async () => [
      { id: "11111111-1111-4111-8111-111111111111", platform: "META", accountId: "a", status: "ACTIVE" },
      { id: "22222222-2222-4222-8222-222222222222", platform: "TIKTOK", accountId: "b", status: "ACTIVE" },
    ] } },
    registry: { META: good, TIKTOK: bad },
    repository: { persistCatalogPage: async () => ({}), persistInsightPage: async () => ({}) },
    syncLock: lock,
    runLedger: { startRun: async () => ({ id: "run-1" }), finishRun: async (_id, data) => runUpdates.push(data) },
    settingsService: { resolveSettings: async () => ({ values: { creativeSyncEnabled: true } }) },
  });
  const result = await service.syncCreatives({ since: "2026-07-01", until: "2026-07-02", platforms: ["META", "TIKTOK"] });
  assert.equal(result.status, "PARTIAL_SUCCESS");
  assert.equal(result.results[0].status, "SUCCEEDED");
  assert.equal(result.results[1].status, "FAILED");
  assert.equal(result.results[1].errorCode, "auth");
  assert.doesNotMatch(result.results[1].sanitizedMessage, /top-secret-token/);
  assert.equal(runUpdates.at(-1).status, "PARTIAL_SUCCESS");
});

test("mid-catalog pagination failure retains committed pages and reports catalog partial success", async () => {
  let calls = 0;
  const connector = {
    getCapability: () => ({ status: "AVAILABLE", supportsCreativeCatalog: true, supportsCreativeInsights: true }),
    async fetchCreativeCatalog() {
      calls += 1;
      if (calls === 2) throw new Error("catalog page failed");
      return { items: [asset()], nextCursor: "page-2", capability: this.getCapability() };
    },
    async fetchCreativeInsights() { return { rows: [], nextCursor: null, capability: this.getCapability() }; },
  };
  let persisted = 0;
  const service = createCreativeSyncService({
    prisma: {},
    registry: { META: connector },
    repository: {
      persistCatalogPage: async (_context, rows) => { persisted += rows.length; },
      persistInsightPage: async () => ({}),
    },
    syncLock: {},
    runLedger: {},
  });
  const result = await service.processConnection({ id: asset().connectionId, accountId: "act_1", platform: "META", __since: "2026-07-01", __until: "2026-07-02" });
  assert.equal(persisted, 1);
  assert.equal(result.status, "PARTIAL_SUCCESS");
  assert.equal(result.catalogProcessedCount, 1);
  assert.equal(result.insightProcessedCount, 0);
  assert.equal(result.partialPersistence, true);
});

test("creative repository uses idempotent keys, preserves firstSeenAt, and keeps campaign-only attribution null", async () => {
  const assetWrites = [];
  const snapshotWrites = [];
  const db = {
    $transaction: async (work) => work(db),
    marketing_ad_insights_raw: { upsert: async ({ create }) => ({ id: "raw-1", ...create }) },
    marketing_creative_assets: {
      upsert: async (operation) => { assetWrites.push(operation); return { id: "asset-1", ...operation.create }; },
      findFirst: async () => ({ id: "asset-1" }),
    },
    marketing_creative_performance_snapshots: {
      upsert: async (operation) => { snapshotWrites.push(operation); return operation.create; },
    },
  };
  const repository = createCreativeRepository({ prisma: db });
  const normalizedAsset = normalizeCreativeAsset(asset());
  const context = {
    connection: { id: normalizedAsset.connectionId, accountId: "act_1", platform: "META" },
    since: "2026-07-01", until: "2026-07-03", cursor: null, page: 1,
    providerRequestId: "request-1", capability: { status: "AVAILABLE" }, rawResponse: [{ access_token: "hidden", ok: true }],
  };
  await repository.persistCatalogPage(context, [normalizedAsset]);
  assert.deepEqual(assetWrites[0].where, { connectionId_sourceKey: { connectionId: normalizedAsset.connectionId, sourceKey: normalizedAsset.sourceKey } });
  assert.equal(Object.hasOwn(assetWrites[0].update, "firstSeenAt"), false);
  assert.ok(assetWrites[0].update.lastSeenAt);

  const insight = normalizeCreativeInsight({ ...asset(), date: "2026-07-03", currencyCode: "USD", spend: "3.50", impressions: 100, clicks: 5, providerConversions: 2, attributedSignups: 8 });
  await repository.persistInsightPage({ ...context, page: 2 }, [insight]);
  assert.deepEqual(snapshotWrites[0].where, {
    connectionId_sourceMetricKey_date: {
      connectionId: insight.connectionId,
      sourceMetricKey: insight.sourceMetricKey,
      date: new Date("2026-07-03T00:00:00.000Z"),
    },
  });
  assert.equal(snapshotWrites[0].create.attributedSignups, null);
  assert.equal(snapshotWrites[0].create.providerConversions.toString(), "2");
});

test("lock unavailability is recorded without invoking providers", async () => {
  let providerCalls = 0;
  const runs = [];
  const finishes = [];
  const service = createCreativeSyncService({
    prisma: {}, registry: { META: { fetchCreativeCatalog: async () => { providerCalls += 1; } } },
    repository: {},
    syncLock: { acquire: async () => null },
    runLedger: { startRun: async (data) => runs.push(data), finishRun: async (_id, data) => finishes.push(data) },
  });
  const result = await service.syncCreatives({ platforms: ["META"] });
  assert.deepEqual(result, { skipped: true, reason: "creative_sync_already_running" });
  assert.equal(providerCalls, 0);
  assert.equal(runs[0].status, "STARTED");
  assert.equal(finishes[0].status, "SKIPPED_LOCKED");
});

test("raw sanitization drops nested credentials and creative routes use VIEW/EDIT", () => {
  assert.deepEqual(sanitizeObject({ headers: { Authorization: "Bearer x", ok: "yes" }, refreshToken: "x" }), { headers: { ok: "yes" } });
  const routes = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  assert.match(routes, /"\/creatives"[\s\S]*?"VIEW"/);
  assert.match(routes, /"\/creatives\/:id"[\s\S]*?"VIEW"/);
  assert.match(routes, /"\/creatives\/sync"[\s\S]*?"EDIT"/);
});
