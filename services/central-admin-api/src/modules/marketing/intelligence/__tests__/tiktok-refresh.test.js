const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const tiktokConnector = require("../connectors/tiktok.connector");
const { ProviderError } = require("../connectors/provider-http");
const { encryptCredential } = require("../utils/credential-encryption");

// TikTok token refresh lifecycle tests  all provider traffic is mocked.

const KEY = crypto.randomBytes(32).toString("hex");

const REPORT_ROW = {
  dimensions: { campaign_id: "camp-1", stat_time_day: "2026-07-01 00:00:00" },
  metrics: { campaign_name: "C1", spend: "10", impressions: "100", clicks: "5" },
};

const REPORT_OK = {
  data: { code: 0, data: { list: [REPORT_ROW], page_info: { total_page: 1 } } },
};
const REPORT_EXPIRED = { data: { code: 40105, message: "Access token expired" } };
const REFRESH_OK = {
  data: {
    code: 0,
    data: {
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      access_token_expire_in: 86400,
      refresh_token_expire_in: 31536000,
    },
  },
};
const REFRESH_REJECTED = { data: { code: 40110, message: "Refresh token invalid" } };

beforeEach(() => {
  process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY = KEY;
  process.env.TIKTOK_APP_ID = "app-id";
  process.env.TIKTOK_APP_SECRET = "app-secret";
  process.env.MARKETING_PROVIDER_MAX_RETRIES = "0";
  delete process.env.TIKTOK_ACCESS_TOKEN;
  delete process.env.TIKTOK_ADVERTISER_ID;
  delete process.env.TIKTOK_REFRESH_TOKEN;
});

function dbConnection(overrides = {}) {
  return {
    id: "conn-tt-1",
    platform: "TIKTOK",
    accountId: "adv-123",
    accessToken: encryptCredential("old-access-token"),
    refreshToken: encryptCredential("old-refresh-token"),
    accessTokenExpiresAt: null,
    ...overrides,
  };
}

test("expired-token response triggers one refresh and retries the request once", async () => {
  const getCalls = [];
  const postCalls = [];
  const httpClient = {
    async get(url, config) {
      getCalls.push(config.headers["Access-Token"]);
      return getCalls.length === 1 ? REPORT_EXPIRED : REPORT_OK;
    },
    async post(url, body) {
      postCalls.push({ url, body });
      return REFRESH_OK;
    },
  };

  const refreshed = [];
  const rows = await tiktokConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    connection: dbConnection(),
    httpClient,
    onTokensRefreshed: (tokens) => refreshed.push(tokens),
  });

  assert.equal(rows.length, 1);
  assert.deepEqual(getCalls, ["old-access-token", "new-access-token"]);
  assert.equal(postCalls.length, 1);
  assert.ok(postCalls[0].url.includes("/oauth2/refresh_token/"));
  assert.equal(postCalls[0].body.refresh_token, "old-refresh-token");
  // Rotated tokens surfaced to the persistence callback.
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].accessToken, "new-access-token");
  assert.equal(refreshed[0].refreshToken, "rotated-refresh-token");
  assert.ok(refreshed[0].accessTokenExpiresAt instanceof Date);
});

test("refresh happens proactively when the stored expiry is near", async () => {
  const order = [];
  const httpClient = {
    async get() {
      order.push("report");
      return REPORT_OK;
    },
    async post() {
      order.push("refresh");
      return REFRESH_OK;
    },
  };

  await tiktokConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    connection: dbConnection({ accessTokenExpiresAt: new Date(Date.now() - 1000) }),
    httpClient,
  });

  assert.deepEqual(order, ["refresh", "report"]);
});

test("a permanent refresh failure surfaces as an auth error after ONE attempt", async () => {
  let refreshAttempts = 0;
  const httpClient = {
    async get() {
      return REPORT_EXPIRED;
    },
    async post() {
      refreshAttempts += 1;
      return REFRESH_REJECTED;
    },
  };

  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      connection: dbConnection(),
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "auth",
  );
  assert.equal(refreshAttempts, 1);
});

test("a still-expired token after refresh fails without a second refresh", async () => {
  let reportCalls = 0;
  let refreshCalls = 0;
  const httpClient = {
    async get() {
      reportCalls += 1;
      return REPORT_EXPIRED;
    },
    async post() {
      refreshCalls += 1;
      return REFRESH_OK;
    },
  };

  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      connection: dbConnection(),
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "auth",
  );
  assert.equal(refreshCalls, 1);
  assert.equal(reportCalls, 2);
});

test("expired token WITHOUT refresh credentials fails with a clear auth error", async () => {
  delete process.env.TIKTOK_APP_ID;
  delete process.env.TIKTOK_APP_SECRET;
  let refreshCalls = 0;
  const httpClient = {
    async get() {
      return REPORT_EXPIRED;
    },
    async post() {
      refreshCalls += 1;
      return REFRESH_OK;
    },
  };

  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      connection: dbConnection(),
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "auth",
  );
  assert.equal(refreshCalls, 0);
});

test("refresh errors never contain token values", async () => {
  const httpClient = {
    async get() {
      return REPORT_EXPIRED;
    },
    async post() {
      return REFRESH_REJECTED;
    },
  };

  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      connection: dbConnection(),
      httpClient,
    }),
    (error) => {
      assert.ok(!error.message.includes("old-access-token"));
      assert.ok(!error.message.includes("old-refresh-token"));
      assert.ok(!error.message.includes("app-secret"));
      return true;
    },
  );
});

test("refreshAccessToken parses expiry metadata into dates", async () => {
  const httpClient = { async post() { return REFRESH_OK; } };
  const tokens = await tiktokConnector.refreshAccessToken({
    credentials: { refreshToken: "rt" },
    httpClient,
  });

  assert.equal(tokens.accessToken, "new-access-token");
  assert.ok(tokens.accessTokenExpiresAt > new Date());
  assert.ok(tokens.refreshTokenExpiresAt > tokens.accessTokenExpiresAt);
});
