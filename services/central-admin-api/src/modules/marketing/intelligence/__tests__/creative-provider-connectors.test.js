const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { CREATIVE_PROVIDER_CONNECTORS, microsToMajor } = require("../creative/provider-creative-connectors");
const { encryptCredentialEnvelope, encryptedEnvelopeMarker } = require("../utils/credential-envelope");

process.env.MARKETING_CREDENTIALS_ENCRYPTION_KEY ||= "7".repeat(64);
process.env.MARKETING_PROVIDER_MAX_RETRIES = "0";
process.env.LINKEDIN_API_VERSION = "202607";

function connection(platform, credentials, metadata = {}) {
  return {
    id: `${platform}-connection`,
    platform,
    accountId: metadata.accountId || "12345",
    currency: "USD",
    accessToken: encryptedEnvelopeMarker(),
    encryptedCredentials: encryptCredentialEnvelope(credentials),
    connectionMetadata: metadata,
  };
}

test("Meta creative adapter preserves ad hierarchy and action metadata", async (t) => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  let call = 0;
  axios.get = async () => {
    call += 1;
    if (call === 1) return { data: { data: [{ id: "ad-1", campaign_id: "campaign-1", adset_id: "set-1", creative: { id: "creative-1", title: "Title", body: "Body", object_type: "VIDEO", call_to_action_type: "SHOP_NOW" } }], paging: {} }, headers: { "x-fb-trace-id": "meta-request" } };
    return { data: { data: [{ campaign_id: "campaign-1", adset_id: "set-1", ad_id: "ad-1", date_start: "2026-07-01", spend: "10", impressions: "100", reach: "80", clicks: "5", actions: [{ action_type: "purchase", value: "2" }] }], paging: {} } };
  };
  const c = connection("META", { accessToken: "meta-token" });
  const catalog = await CREATIVE_PROVIDER_CONNECTORS.META.fetchCreativeCatalog({ connection: c, limit: 10 });
  const insights = await CREATIVE_PROVIDER_CONNECTORS.META.fetchCreativeInsights({ connection: c, since: "2026-07-01", until: "2026-07-01", limit: 10 });
  assert.equal(catalog.items[0].creativeExternalId, "creative-1");
  assert.equal(catalog.items[0].nativeIdentifiers.adSetId, "set-1");
  assert.equal(insights.rows[0].providerConversions, "2");
  assert.equal(insights.rows[0].metadata.providerConversionDefinition, "SUM_OF_REPORTED_ACTION_COUNTS_INFORMATIONAL");
  assert.deepEqual(insights.rows[0].metadata.actions, [{ action_type: "purchase", value: "2" }]);
});

test("TikTok creative adapter handles page cursors and stable ad fallback", async (t) => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  let call = 0;
  axios.get = async () => {
    call += 1;
    if (call === 1) return { data: { code: 0, request_id: "tt-catalog", data: { list: [{ campaign_id: "c", adgroup_id: "g", ad_id: "a", ad_name: "Ad", creative_type: "VIDEO", call_to_action: "BUY" }], page_info: { total_page: 2 } } } };
    return { data: { code: 0, request_id: "tt-insight", data: { list: [{ dimensions: { ad_id: "a", stat_time_day: "2026-07-01" }, metrics: { campaign_id: "c", adgroup_id: "g", spend: "2", impressions: "20", clicks: "3", conversion: "1" } }], page_info: { total_page: 1 } } } };
  };
  const c = connection("TIKTOK", { accessToken: "tiktok-token" });
  const catalog = await CREATIVE_PROVIDER_CONNECTORS.TIKTOK.fetchCreativeCatalog({ connection: c, limit: 10 });
  const insights = await CREATIVE_PROVIDER_CONNECTORS.TIKTOK.fetchCreativeInsights({ connection: c, since: "2026-07-01", until: "2026-07-01", limit: 10 });
  assert.equal(catalog.items[0].creativeExternalId, "a");
  assert.equal(catalog.nextCursor, "2");
  assert.equal(insights.rows[0].creativeExternalId, "a");
  assert.equal(insights.rows[0].metadata.scoredUnit, "ad");
});

test("X creative adapter uses OAuth 1.0a and promoted-entity grain", async (t) => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  let call = 0;
  axios.get = async (_url, config) => {
    assert.match(config.headers.Authorization, /^OAuth /);
    call += 1;
    if (call === 1) return { data: { data: [{ id: "promoted-1", line_item_id: "line-1", campaign_id: "campaign-1", tweet_id: "tweet-1", media_ids: ["media-1"] }], next_cursor: "next" } };
    return { data: { data: [{ id: "promoted-1", line_item_id: "line-1", campaign_id: "campaign-1", tweet_id: "tweet-1", id_data: [{ segment: { start_time: "2026-07-01" }, metrics: { billed_charge_local_micro: 2500000, impressions: 40, clicks: 4 } }] }], next_cursor: "0" } };
  };
  const c = connection("X", { consumerKey: "consumer", consumerSecret: "consumer-secret", accessToken: "access", accessTokenSecret: "access-secret" });
  const catalog = await CREATIVE_PROVIDER_CONNECTORS.X.fetchCreativeCatalog({ connection: c, limit: 10 });
  const insights = await CREATIVE_PROVIDER_CONNECTORS.X.fetchCreativeInsights({ connection: c, since: "2026-07-01", until: "2026-07-01", limit: 10 });
  assert.equal(catalog.items[0].creativeExternalId, "tweet-1");
  assert.equal(catalog.nextCursor, "next");
  assert.equal(insights.rows[0].spend, "2.5");
});

test("LinkedIn creative adapter keeps full URNs and configured version", async (t) => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  let call = 0;
  axios.get = async (_url, config) => {
    assert.equal(config.headers["LinkedIn-Version"], "202607");
    call += 1;
    if (call === 1) return { data: { elements: [{ id: "urn:li:sponsoredCreative:1", campaign: "urn:li:sponsoredCampaign:2", type: "IMAGE", status: "ACTIVE" }], paging: { total: 1 } } };
    return { data: { elements: [{ pivotValues: ["urn:li:sponsoredCreative:1"], campaign: "urn:li:sponsoredCampaign:2", dateRange: { start: { year: 2026, month: 7, day: 1 } }, costInLocalCurrency: "4", impressions: 50, clicks: 5, externalWebsiteConversions: 1 }], paging: { total: 1 } } };
  };
  const c = connection("LINKEDIN", { accessToken: "linkedin-token" }, { accountId: "urn:li:sponsoredAccount:12345" });
  const catalog = await CREATIVE_PROVIDER_CONNECTORS.LINKEDIN.fetchCreativeCatalog({ connection: c, limit: 10 });
  const insights = await CREATIVE_PROVIDER_CONNECTORS.LINKEDIN.fetchCreativeInsights({ connection: c, since: "2026-07-01", until: "2026-07-01", limit: 10 });
  assert.equal(catalog.items[0].nativeIdentifiers.creativeUrn, "urn:li:sponsoredCreative:1");
  assert.equal(insights.rows[0].creativeExternalId, "urn:li:sponsoredCreative:1");
  assert.equal(insights.rows[0].date, "2026-07-01");
});

test("Google Ads creative adapter uses read-only GAQL, resource names, and micros", async (t) => {
  const original = axios.post;
  t.after(() => { axios.post = original; });
  let call = 0;
  axios.post = async (_url, body, config) => {
    assert.match(body.query, /^SELECT /);
    assert.equal(config.headers["developer-token"], "developer");
    call += 1;
    const common = { campaign: { id: "1", resourceName: "customers/123/campaigns/1" }, adGroup: { id: "2", resourceName: "customers/123/adGroups/2" }, adGroupAd: { status: "ENABLED", ad: { id: "3", resourceName: "customers/123/ads/3", type: "RESPONSIVE_DISPLAY_AD", finalUrls: ["https://example.com"] } } };
    return call === 1
      ? { data: { results: [common], nextPageToken: "next" }, headers: { "x-request-id": "ga-catalog" } }
      : { data: { results: [{ ...common, segments: { date: "2026-07-01" }, metrics: { costMicros: 3500000, impressions: "60", clicks: "6", conversions: "1.5" } }] } };
  };
  const c = connection("GOOGLE_ADS", { accessToken: "google-token", developerToken: "developer", customerId: "123", loginCustomerId: "999" });
  const catalog = await CREATIVE_PROVIDER_CONNECTORS.GOOGLE_ADS.fetchCreativeCatalog({ connection: c, limit: 10 });
  const insights = await CREATIVE_PROVIDER_CONNECTORS.GOOGLE_ADS.fetchCreativeInsights({ connection: c, since: "2026-07-01", until: "2026-07-01", limit: 10 });
  assert.equal(catalog.items[0].creativeExternalId, "customers/123/ads/3");
  assert.equal(catalog.items[0].metadata.sharedAssetsNotDuplicated, true);
  assert.equal(insights.rows[0].spend, "3.5");
  assert.equal(insights.rows[0].providerConversions, "1.5");
});

test("creative adapter errors are sanitized and preserve auth/rate-limit classification", async (t) => {
  const original = axios.get;
  t.after(() => { axios.get = original; });
  const c = connection("META", { accessToken: "EAAabcdefghijklmnopqrstuvwxyz123456" });
  axios.get = async () => { const error = new Error("access_token=EAAabcdefghijklmnopqrstuvwxyz123456"); error.response = { status: 403 }; throw error; };
  await assert.rejects(
    () => CREATIVE_PROVIDER_CONNECTORS.META.fetchCreativeCatalog({ connection: c }),
    (error) => error.kind === "auth" && !/abcdefghijklmnopqrstuvwxyz/.test(error.message),
  );
  axios.get = async () => { const error = new Error("limited"); error.response = { status: 429 }; throw error; };
  await assert.rejects(
    () => CREATIVE_PROVIDER_CONNECTORS.META.fetchCreativeCatalog({ connection: c }),
    (error) => error.kind === "rate_limit" && error.retryable === true,
  );
});

test("micro-unit conversion remains exact beyond JavaScript safe integers", () => {
  assert.equal(microsToMajor("9007199254740993"), "9007199254.740993");
});

test("TikTok creative fetch reuses token refresh and returns rotated tokens", async (t) => {
  const originalGet = axios.get;
  const originalPost = axios.post;
  t.after(() => { axios.get = originalGet; axios.post = originalPost; });
  axios.post = async () => ({ data: { code: 0, data: { access_token: "fresh-token", refresh_token: "fresh-refresh", access_token_expire_in: 3600 } } });
  axios.get = async (_url, config) => {
    assert.equal(config.headers["Access-Token"], "fresh-token");
    return { data: { code: 0, data: { list: [], page_info: { total_page: 1 } } } };
  };
  const c = connection("TIKTOK", { accessToken: "expired-token", refreshToken: "refresh-token", appId: "app-id", appSecret: "app-secret" });
  c.accessTokenExpiresAt = new Date(Date.now() - 1000);
  let rotated = null;
  await CREATIVE_PROVIDER_CONNECTORS.TIKTOK.fetchCreativeCatalog({ connection: c, onTokensRefreshed: async (tokens) => { rotated = tokens; } });
  assert.equal(rotated.accessToken, "fresh-token");
  assert.equal(rotated.refreshToken, "fresh-refresh");
});

test("LinkedIn creative fetch reuses token refresh and configured connection version", async (t) => {
  const originalGet = axios.get;
  const originalPost = axios.post;
  t.after(() => { axios.get = originalGet; axios.post = originalPost; });
  axios.post = async () => ({ data: { access_token: "fresh-linkedin", expires_in: 3600 } });
  axios.get = async (_url, config) => {
    assert.equal(config.headers.Authorization, "Bearer fresh-linkedin");
    assert.equal(config.headers["LinkedIn-Version"], "202608");
    return { data: { elements: [], paging: { total: 0 } } };
  };
  const c = connection("LINKEDIN", { accessToken: "expired-linkedin", refreshToken: "linkedin-refresh", clientId: "linkedin-client", clientSecret: "linkedin-secret" }, { accountId: "urn:li:sponsoredAccount:12345", apiVersion: "202608" });
  c.accessTokenExpiresAt = new Date(Date.now() - 1000);
  let rotated = null;
  await CREATIVE_PROVIDER_CONNECTORS.LINKEDIN.fetchCreativeCatalog({ connection: c, onTokensRefreshed: async (tokens) => { rotated = tokens; } });
  assert.equal(rotated.accessToken, "fresh-linkedin");
});

test("Google creative fetch reuses OAuth refresh and the campaign API version", async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const urls = [];
  axios.post = async (url, body, config) => {
    urls.push(url);
    if (url.includes("oauth2.googleapis.com")) return { data: { access_token: "fresh-google" } };
    assert.equal(config.headers.Authorization, "Bearer fresh-google");
    assert.match(body.query, /^SELECT /);
    return { data: { results: [] } };
  };
  const c = connection("GOOGLE_ADS", { clientId: "google-client", clientSecret: "google-secret", refreshToken: "google-refresh", developerToken: "developer" }, { customerId: "12345", apiVersion: "v24" });
  await CREATIVE_PROVIDER_CONNECTORS.GOOGLE_ADS.fetchCreativeCatalog({ connection: c });
  assert.match(urls[1], /\/v24\/customers\/12345\/googleAds:search$/);
});
