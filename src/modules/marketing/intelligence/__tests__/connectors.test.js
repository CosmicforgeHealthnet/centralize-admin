const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const metaConnector = require("../connectors/meta.connector");
const tiktokConnector = require("../connectors/tiktok.connector");
const { ProviderError, sanitizeProviderText } = require("../connectors/provider-http");
const { validateNormalizedRow } = require("../connectors/connector.interface");

beforeEach(() => {
  process.env.META_ACCESS_TOKEN = "test-meta-token";
  process.env.META_AD_ACCOUNT_ID = "1234567890";
  process.env.TIKTOK_ACCESS_TOKEN = "test-tiktok-token";
  process.env.TIKTOK_ADVERTISER_ID = "9876543210";
  process.env.MARKETING_PROVIDER_MAX_RETRIES = "0";
});

//  Meta

const META_ROW = {
  campaign_id: "120210000000001",
  campaign_name: "Doctor Acquisition June",
  spend: "70.5",
  impressions: "620000",
  clicks: "17000",
  date_start: "2026-07-01",
  date_stop: "2026-07-01",
  extra_provider_field: "must be preserved",
};

test("meta: normalizes a provider row into the shared shape", () => {
  const row = metaConnector.normalizeRow(META_ROW);
  assert.deepEqual(
    { ...row, raw: undefined },
    {
      platform: "META",
      campaignExternalId: "120210000000001",
      campaignName: "Doctor Acquisition June",
      date: "2026-07-01",
      spend: "70.50",
      currency: "UNSPECIFIED",
      impressions: 620000,
      clicks: 17000,
      raw: undefined,
    },
  );
  assert.equal(row.raw.extra_provider_field, "must be preserved");
  assert.equal(validateNormalizedRow(row).ok, true);
});

test("meta: missing metric fields never produce NaN", () => {
  const row = metaConnector.normalizeRow({
    campaign_id: "1",
    campaign_name: "Sparse",
    date_start: "2026-07-01",
  });
  assert.equal(row.spend, "0.00");
  assert.equal(row.impressions, 0);
  assert.equal(row.clicks, 0);
});

test("meta: follows pagination until all pages are fetched", async () => {
  const calls = [];
  const httpClient = {
    async get(url, config) {
      calls.push({ url, config });
      if (calls.length === 1) {
        return {
          data: {
            data: [META_ROW],
            paging: { next: "https://graph.facebook.com/next-page?after=cursor" },
          },
        };
      }
      return { data: { data: [{ ...META_ROW, campaign_id: "2" }] } };
    },
  };

  const rows = await metaConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.equal(rows.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.params.fields.includes("date_start"), true);
  assert.equal(calls[0].config.params.fields.includes("date_stop"), true);
  assert.equal(calls[1].url, "https://graph.facebook.com/next-page?after=cursor");
  assert.equal(calls[1].config.params, undefined);
});

test("meta: malformed response raises a sanitized provider error", async () => {
  const httpClient = { async get() { return { data: { nope: true } }; } };

  await assert.rejects(
    metaConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "malformed",
  );
});

test("meta: retries a 429 and then succeeds", async () => {
  process.env.MARKETING_PROVIDER_MAX_RETRIES = "1";
  let attempts = 0;
  const httpClient = {
    async get() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("rate limited");
        error.response = { status: 429 };
        throw error;
      }
      return { data: { data: [META_ROW] } };
    },
  };

  const rows = await metaConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.equal(attempts, 2);
  assert.equal(rows.length, 1);
});

test("meta: timeout surfaces as a timeout provider error", async () => {
  const httpClient = {
    async get() {
      const error = new Error("timeout of 30000ms exceeded");
      error.code = "ECONNABORTED";
      throw error;
    },
  };

  await assert.rejects(
    metaConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "timeout",
  );
});

test("meta: missing credentials fail with a config error", async () => {
  delete process.env.META_ACCESS_TOKEN;
  await assert.rejects(
    metaConnector.fetchDailyCampaignInsights({ since: "2026-07-01", until: "2026-07-01" }),
    (error) => error instanceof ProviderError && error.kind === "config",
  );
  assert.equal(metaConnector.validateConfiguration({}).ok, false);
});

test("provider errors never leak access tokens", async () => {
  const httpClient = {
    async get() {
      const error = new Error(
        "Request failed: https://graph.facebook.com/insights?access_token=EAAsupersecrettokenvalue123456",
      );
      error.response = {
        status: 400,
        data: {
          error: {
            message:
              "Invalid parameter access_token=EAAsupersecrettokenvalue123456 rejected",
          },
        },
      };
      throw error;
    },
  };

  await assert.rejects(
    metaConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      httpClient,
    }),
    (error) => {
      assert.ok(!error.message.includes("EAAsupersecrettokenvalue123456"));
      assert.ok(error.message.includes("***REDACTED***"));
      return true;
    },
  );
});

test("sanitizeProviderText scrubs bearer headers and token params", () => {
  const dirty =
    'Authorization: Bearer abc.def-ghi failed, retry with access_token=xyz987 or "refresh_token":"rt-secret" and app_secret=app-secret-value';
  const clean = sanitizeProviderText(dirty);
  assert.ok(!clean.includes("abc.def-ghi"));
  assert.ok(!clean.includes("xyz987"));
  assert.ok(!clean.includes("rt-secret"));
  assert.ok(!clean.includes("app-secret-value"));
});

//  TikTok

const TIKTOK_ROW = {
  dimensions: { campaign_id: "1789000000000001", stat_time_day: "2026-07-01 00:00:00" },
  metrics: {
    campaign_name: "NG Patient Growth",
    spend: "80.25",
    impressions: "630000",
    clicks: "15000",
    provider_specific: "kept",
  },
};

test("tiktok: normalizes a provider row into the shared shape", () => {
  const row = tiktokConnector.normalizeRow(TIKTOK_ROW);
  assert.equal(row.platform, "TIKTOK");
  assert.equal(row.campaignExternalId, "1789000000000001");
  assert.equal(row.campaignName, "NG Patient Growth");
  assert.equal(row.date, "2026-07-01");
  assert.equal(row.spend, "80.25");
  assert.equal(row.currency, "UNSPECIFIED");
  assert.equal(row.impressions, 630000);
  assert.equal(row.clicks, 15000);
  assert.equal(row.raw.metrics.provider_specific, "kept");
  assert.equal(validateNormalizedRow(row).ok, true);
});

test("tiktok: missing fields never produce NaN", () => {
  const row = tiktokConnector.normalizeRow({ dimensions: { campaign_id: "1" }, metrics: {} });
  assert.equal(row.spend, "0.00");
  assert.equal(row.impressions, 0);
  assert.equal(row.clicks, 0);
});

test("tiktok: paginates through total_page", async () => {
  const calls = [];
  const httpClient = {
    async get(url, config) {
      calls.push(config.params.page);
      return {
        data: {
          code: 0,
          data: {
            list: [TIKTOK_ROW],
            page_info: { page: config.params.page, total_page: 3 },
          },
        },
      };
    },
  };

  const rows = await tiktokConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(rows.length, 3);
});

test("tiktok: auth error codes surface as auth provider errors", async () => {
  const httpClient = {
    async get() {
      return { data: { code: 40100, message: "Access token expired" } };
    },
  };

  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "auth",
  );
});

test("meta: account id without act_ prefix is normalized into the URL", async () => {
  process.env.META_AD_ACCOUNT_ID = "555000111";
  let requestedUrl;
  const httpClient = {
    async get(url) {
      requestedUrl = url;
      return { data: { data: [META_ROW] } };
    },
  };

  await metaConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.ok(requestedUrl.includes("/act_555000111/insights"));
  assert.ok(!requestedUrl.includes("act_act_"));
});

test("meta: account id already containing act_ is not doubled", async () => {
  process.env.META_AD_ACCOUNT_ID = "act_555000111";
  let requestedUrl;
  const httpClient = {
    async get(url) {
      requestedUrl = url;
      return { data: { data: [META_ROW] } };
    },
  };

  await metaConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.ok(requestedUrl.includes("/act_555000111/insights"));
  assert.ok(!requestedUrl.includes("act_act_"));
});

test("meta: configurable Graph API version appears in the URL", async () => {
  process.env.META_GRAPH_API_VERSION = "v99.9";
  let requestedUrl;
  const httpClient = {
    async get(url) {
      requestedUrl = url;
      return { data: { data: [] } };
    },
  };

  await metaConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.ok(requestedUrl.includes("/v99.9/"));
  delete process.env.META_GRAPH_API_VERSION;
});

test("meta: missing campaign name normalizes to an empty string", () => {
  const row = metaConnector.normalizeRow({
    campaign_id: "1",
    spend: "5",
    date_start: "2026-07-01",
  });
  assert.equal(row.campaignName, "");
});

test("meta: invalid token (401) is an auth error and is NOT retried", async () => {
  process.env.MARKETING_PROVIDER_MAX_RETRIES = "3";
  let attempts = 0;
  const httpClient = {
    async get() {
      attempts += 1;
      const error = new Error("unauthorized");
      error.response = { status: 401 };
      throw error;
    },
  };

  await assert.rejects(
    metaConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      httpClient,
    }),
    (error) => error instanceof ProviderError && error.kind === "auth",
  );
  assert.equal(attempts, 1);
});

test("tiktok: business-code rate limit (HTTP 200) is retried and succeeds", async () => {
  process.env.MARKETING_PROVIDER_MAX_RETRIES = "1";
  let attempts = 0;
  const httpClient = {
    async get() {
      attempts += 1;
      if (attempts === 1) {
        return { data: { code: 40016, message: "Too many requests" } };
      }
      return { data: { code: 0, data: { list: [TIKTOK_ROW], page_info: { total_page: 1 } } } };
    },
  };

  const rows = await tiktokConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.equal(attempts, 2);
  assert.equal(rows.length, 1);
});

test("tiktok: missing credentials fail with a config error", async () => {
  delete process.env.TIKTOK_ACCESS_TOKEN;
  assert.equal(tiktokConnector.validateConfiguration({}).ok, false);
  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({ since: "2026-07-01", until: "2026-07-01" }),
    (error) => error instanceof ProviderError && error.kind === "config",
  );
});


test("tiktok: configurable API base and version appear in the report URL", async () => {
  process.env.TIKTOK_API_BASE_URL = "https://example.tiktok.test/open_api";
  process.env.TIKTOK_API_VERSION = "v9.9";
  let requestedUrl;
  const httpClient = {
    async get(url) {
      requestedUrl = url;
      return { data: { code: 0, data: { list: [], page_info: { total_page: 1 } } } };
    },
  };

  await tiktokConnector.fetchDailyCampaignInsights({
    since: "2026-07-01",
    until: "2026-07-01",
    httpClient,
  });

  assert.equal(requestedUrl, "https://example.tiktok.test/open_api/v9.9/report/integrated/get/");
  delete process.env.TIKTOK_API_BASE_URL;
  delete process.env.TIKTOK_API_VERSION;
});

test("tiktok: provider business errors are sanitized", async () => {
  const httpClient = {
    async get() {
      return { data: { code: 12345, message: "bad app_secret=super-secret and refresh_token=rt-secret" } };
    },
  };

  await assert.rejects(
    tiktokConnector.fetchDailyCampaignInsights({
      since: "2026-07-01",
      until: "2026-07-01",
      httpClient,
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, "provider");
      assert.ok(!error.message.includes("super-secret"));
      assert.ok(!error.message.includes("rt-secret"));
      assert.ok(error.message.includes("***REDACTED***"));
      return true;
    },
  );
});
