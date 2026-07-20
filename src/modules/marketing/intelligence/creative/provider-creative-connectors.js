const axios = require("axios");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const { Prisma } = require("../../../../generated/admin-client");
const { resolveStoredCredentials } = require("../utils/credential-envelope");
const { ProviderError, providerTimeoutMs, requestWithRetry, sanitizeProviderText } = require("../connectors/provider-http");
const tiktokLifecycle = require("../connectors/tiktok.connector");
const linkedinLifecycle = require("../connectors/linkedin.connector");
const googleLifecycle = require("../connectors/googleads.connector");

const credentialState = new WeakMap();

function credentials(connection) {
  return {
    ...resolveStoredCredentials(connection),
    accountId: connection.accountId,
    currency: connection.currency || connection.connectionMetadata?.currency || null,
    accessTokenExpiresAt: connection.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt || null,
    ...(connection.connectionMetadata || {}),
  };
}

function stateFor(connection, factory) {
  if (!connection || typeof connection !== "object") return factory();
  if (!credentialState.has(connection)) credentialState.set(connection, factory());
  return credentialState.get(connection);
}

function microsToMajor(value) {
  if (value === undefined || value === null || value === "") return null;
  return new Prisma.Decimal(String(value)).div(1000000).toString();
}

function sumProviderActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  return actions.reduce(
    (sum, action) => sum.plus(String(action?.value || 0)),
    new Prisma.Decimal(0),
  ).toString();
}

function providerError(platform, error) {
  if (error instanceof ProviderError) return error;
  const status = error.response?.status;
  const category = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status >= 500 ? "provider" : "provider";
  return new ProviderError(platform, category, sanitizeProviderText(`${platform} creative request failed${status ? ` (HTTP ${status})` : ""}`), { retryable: status === 429 || status >= 500, statusCode: status || null });
}

async function get(platform, url, config) {
  try {
    return await requestWithRetry(platform, () => axios.get(url, { timeout: providerTimeoutMs(), ...config }));
  } catch (error) {
    throw providerError(platform, error);
  }
}

async function post(platform, url, data, config) {
  try {
    return await requestWithRetry(platform, () => axios.post(url, data, { timeout: providerTimeoutMs(), ...config }));
  } catch (error) {
    throw providerError(platform, error);
  }
}

function requestId(response) {
  return response?.headers?.["x-request-id"] || response?.headers?.["x-fb-trace-id"] || response?.data?.request_id || null;
}

function metaConnector() {
  const version = () => process.env.META_GRAPH_API_VERSION || "v25.0";
  async function fetchCreativeCatalog({ connection, cursor, limit = 200 }) {
    const c = credentials(connection);
    if (!c.accessToken) throw new ProviderError("META", "config", "Meta credentials are unavailable");
    const account = String(c.accountId).startsWith("act_") ? c.accountId : `act_${c.accountId}`;
    const response = await get("META", `https://graph.facebook.com/${version()}/${account}/ads`, {
      params: { fields: "id,name,status,campaign_id,adset_id,creative{id,name,title,body,call_to_action_type,object_type,thumbnail_url,image_url,video_id}", limit, ...(cursor ? { after: cursor } : {}), access_token: c.accessToken },
    });
    const rows = response.data?.data || [];
    return {
      items: rows.map((ad) => ({
        platform: "META", campaignExternalId: ad.campaign_id, adGroupExternalId: ad.adset_id, adExternalId: ad.id,
        creativeExternalId: ad.creative?.id || `ad:${ad.id}`, name: ad.creative?.name || ad.name,
        type: /video/i.test(ad.creative?.object_type || "") || ad.creative?.video_id ? "VIDEO" : ad.creative?.image_url ? "IMAGE" : "UNKNOWN",
        nativeType: ad.creative?.object_type, status: ad.status, ctaType: ad.creative?.call_to_action_type,
        headline: ad.creative?.title, bodyText: ad.creative?.body, sourceUrl: ad.creative?.image_url,
        thumbnailUrl: ad.creative?.thumbnail_url, nativeIdentifiers: { campaignId: ad.campaign_id, adSetId: ad.adset_id, adId: ad.id, creativeId: ad.creative?.id }, metadata: { provider: "META", scoredUnit: "ad", nativeCreativeIdPresent: Boolean(ad.creative?.id) },
      })),
      nextCursor: response.data?.paging?.next ? response.data?.paging?.cursors?.after || null : null,
      providerRequestId: requestId(response), rawResponse: response.data,
    };
  }
  async function fetchCreativeInsights({ connection, since, until, cursor, limit = 200 }) {
    const c = credentials(connection); if (!c.accessToken) throw new ProviderError("META", "config", "Meta credentials are unavailable");
    const account = String(c.accountId).startsWith("act_") ? c.accountId : `act_${c.accountId}`;
    const response = await get("META", `https://graph.facebook.com/${version()}/${account}/insights`, {
      params: { level: "ad", time_increment: 1, fields: "campaign_id,adset_id,ad_id,ad_name,spend,impressions,reach,clicks,actions,date_start", time_range: JSON.stringify({ since, until }), limit, ...(cursor ? { after: cursor } : {}), access_token: c.accessToken },
    });
    const rows = response.data?.data || [];
    return { rows: rows.map((row) => ({ platform: "META", campaignExternalId: row.campaign_id, adGroupExternalId: row.adset_id, adExternalId: row.ad_id, creativeExternalId: `ad:${row.ad_id}`, date: row.date_start, currencyCode: c.currency, spend: row.spend, impressions: row.impressions, reach: row.reach, clicks: row.clicks, providerConversions: sumProviderActions(row.actions), metadata: { actions: row.actions || [], providerConversionDefinition: "SUM_OF_REPORTED_ACTION_COUNTS_INFORMATIONAL", attributionWindow: "provider-defined", scoredUnit: "ad" }, rawProviderRecord: row })), nextCursor: response.data?.paging?.next ? response.data?.paging?.cursors?.after || null : null, providerRequestId: requestId(response), rawResponse: response.data };
  }
  return { creativeCapability: { supportedMetrics: ["spend", "impressions", "reach", "clicks", "providerConversions"], providerApiVersion: version() }, fetchCreativeCatalog, fetchCreativeInsights };
}

function tiktokConnector() {
  const base = () => tiktokLifecycle.apiBaseUrl();
  async function prepare(connection, onTokensRefreshed) {
    const c = stateFor(connection, () => tiktokLifecycle.resolveCredentials(connection) || credentials(connection));
    if (!c?.accessToken) throw new ProviderError("TIKTOK", "config", "TikTok credentials are unavailable");
    if (!c.__creativeRefreshed && tiktokLifecycle.accessTokenNeedsRefresh(c) && tiktokLifecycle.canRefresh(c)) {
      const tokens = await tiktokLifecycle.refreshAccessToken({ credentials: c, httpClient: axios });
      await tiktokLifecycle.applyRefreshedTokens(c, tokens, onTokensRefreshed);
      c.__creativeRefreshed = true;
    }
    return c;
  }
  async function request(connection, onTokensRefreshed, path, configFactory) {
    const c = await prepare(connection, onTokensRefreshed);
    const execute = () => get("TIKTOK", `${base()}${path}`, configFactory(c));
    let response = await execute();
    const code = Number(response.data?.code || 0);
    if (code && tiktokLifecycle.AUTH_ERROR_CODES.has(code) && !c.__creativeRefreshed && tiktokLifecycle.canRefresh(c)) {
      const tokens = await tiktokLifecycle.refreshAccessToken({ credentials: c, httpClient: axios });
      await tiktokLifecycle.applyRefreshedTokens(c, tokens, onTokensRefreshed);
      c.__creativeRefreshed = true;
      response = await execute();
    }
    const finalCode = Number(response.data?.code || 0);
    if (finalCode) {
      const kind = tiktokLifecycle.AUTH_ERROR_CODES.has(finalCode)
        ? "auth"
        : tiktokLifecycle.RATE_LIMIT_ERROR_CODES.has(finalCode) ? "rate_limit" : "provider";
      throw new ProviderError("TIKTOK", kind, "TikTok creative request was rejected", {
        retryable: kind === "rate_limit",
      });
    }
    return { response, credentials: c };
  }
  async function fetchCreativeCatalog({ connection, cursor, limit = 100, onTokensRefreshed }) {
    const page = Number(cursor || 1);
    const { response } = await request(connection, onTokensRefreshed, "/ad/get/", (c) => ({ headers: { "Access-Token": c.accessToken }, params: { advertiser_id: c.advertiserId || c.accountId, page, page_size: limit } }));
    const rows = response.data?.data?.list || [];
    const totalPage = Number(response.data?.data?.page_info?.total_page || page);
    return { items: rows.map((ad) => ({ platform: "TIKTOK", campaignExternalId: ad.campaign_id, adGroupExternalId: ad.adgroup_id, adExternalId: ad.ad_id, creativeExternalId: ad.creative_id || ad.ad_id, name: ad.ad_name, type: /video/i.test(ad.creative_type || ad.ad_format || "") ? "VIDEO" : /image/i.test(ad.creative_type || ad.ad_format || "") ? "IMAGE" : "UNKNOWN", nativeType: ad.creative_type || ad.ad_format, status: ad.operation_status || ad.secondary_status, durationSeconds: ad.video_duration, ctaType: ad.call_to_action, thumbnailUrl: ad.image_url || ad.video_cover_url, nativeIdentifiers: { campaignId: ad.campaign_id, adGroupId: ad.adgroup_id, adId: ad.ad_id, creativeId: ad.creative_id, identityId: ad.identity_id }, metadata: { smartPlus: ad.smart_plus_ad || null, scoredUnit: "ad", nativeCreativeIdPresent: Boolean(ad.creative_id) } })), nextCursor: page < totalPage ? String(page + 1) : null, providerRequestId: response.data?.request_id || null, rawResponse: response.data };
  }
  async function fetchCreativeInsights({ connection, since, until, cursor, limit = 100, onTokensRefreshed }) {
    const page = Number(cursor || 1);
    const { response, credentials: c } = await request(connection, onTokensRefreshed, "/report/integrated/get/", (current) => ({ headers: { "Access-Token": current.accessToken }, params: { advertiser_id: current.advertiserId || current.accountId, report_type: "BASIC", data_level: "AUCTION_AD", dimensions: JSON.stringify(["ad_id", "stat_time_day"]), metrics: JSON.stringify(["campaign_id", "adgroup_id", "spend", "impressions", "reach", "clicks", "conversion"]), start_date: since, end_date: until, page, page_size: limit } }));
    const rows = response.data?.data?.list || []; const totalPage = Number(response.data?.data?.page_info?.total_page || page);
    return { rows: rows.map((entry) => { const d = entry.dimensions || {}; const m = entry.metrics || {}; return { platform: "TIKTOK", campaignExternalId: m.campaign_id, adGroupExternalId: m.adgroup_id, adExternalId: d.ad_id, creativeExternalId: d.creative_id || d.ad_id, date: d.stat_time_day, currencyCode: c.currency, spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, providerConversions: m.conversion, metadata: { scoredUnit: d.creative_id ? "creative" : "ad", attributionWindow: "provider-defined" }, rawProviderRecord: entry }; }), nextCursor: page < totalPage ? String(page + 1) : null, providerRequestId: response.data?.request_id || null, rawResponse: response.data };
  }
  return { creativeCapability: { supportedMetrics: ["spend", "impressions", "reach", "clicks", "providerConversions"] }, fetchCreativeCatalog, fetchCreativeInsights };
}

function linkedinConnector() {
  const apiVersion = (connection) => linkedinLifecycle.linkedInVersion(connection);
  async function request(connection, onTokensRefreshed, path, params) {
    const c = stateFor(connection, () => linkedinLifecycle.resolveCredentials(connection) || credentials(connection));
    if (!c?.accessToken) throw new ProviderError("LINKEDIN", "config", "LinkedIn credentials are unavailable");
    if (!c.__creativeRefreshed && linkedinLifecycle.tokenNeedsRefresh(c)) {
      await linkedinLifecycle.refreshAccessToken({ credentials: c, httpClient: axios, onTokensRefreshed });
      c.__creativeRefreshed = true;
    }
    const execute = () => get("LINKEDIN", `https://api.linkedin.com/rest${path}`, { headers: linkedinLifecycle.headers(c, connection), params });
    try {
      return { response: await execute(), credentials: c };
    } catch (error) {
      if (error.kind !== "auth" || c.__creativeRefreshed || !c.refreshToken) throw error;
      await linkedinLifecycle.refreshAccessToken({ credentials: c, httpClient: axios, onTokensRefreshed });
      c.__creativeRefreshed = true;
      return { response: await execute(), credentials: c };
    }
  }
  async function fetchCreativeCatalog({ connection, cursor, limit = 100, onTokensRefreshed }) {
    const start = Number(cursor || 0);
    const initial = linkedinLifecycle.resolveCredentials(connection) || credentials(connection);
    const accountId = initial.accountUrn || initial.accountId;
    const account = accountId.startsWith("urn:") ? accountId : `urn:li:sponsoredAccount:${accountId}`;
    const { response } = await request(connection, onTokensRefreshed, "/adCreatives", { q: "search", "search.account.values[0]": account, start, count: limit });
    const rows = response.data?.elements || [];
    return { items: rows.map((creative) => ({ platform: "LINKEDIN", campaignExternalId: creative.campaign || creative.campaignUrn, creativeExternalId: creative.id || creative.urn, name: creative.name, type: /video/i.test(creative.type || creative.format || "") ? "VIDEO" : /carousel/i.test(creative.type || creative.format || "") ? "CAROUSEL" : /image/i.test(creative.type || creative.format || "") ? "IMAGE" : "UNKNOWN", nativeType: creative.type || creative.format, status: creative.status, ctaType: creative.callToAction, headline: creative.headline, bodyText: creative.description, sourceUrl: creative.landingPageUrl, nativeIdentifiers: { accountUrn: account, campaignUrn: creative.campaign || creative.campaignUrn, creativeUrn: creative.id || creative.urn }, metadata: { fullNativeUrns: true, scoredUnit: "creative" } })), nextCursor: response.data?.paging && start + rows.length < response.data.paging.total ? String(start + rows.length) : null, providerRequestId: requestId(response), rawResponse: response.data };
  }
  async function fetchCreativeInsights({ connection, since, until, cursor, limit = 100, onTokensRefreshed }) {
    const start = Number(cursor || 0);
    const initial = linkedinLifecycle.resolveCredentials(connection) || credentials(connection);
    const accountId = initial.accountUrn || initial.accountId;
    const account = accountId.startsWith("urn:") ? accountId : `urn:li:sponsoredAccount:${accountId}`;
    const { response, credentials: c } = await request(connection, onTokensRefreshed, "/adAnalytics", { q: "analytics", pivot: "CREATIVE", timeGranularity: "DAILY", accounts: `List(${account})`, dateRange: `(start:(year:${since.slice(0,4)},month:${Number(since.slice(5,7))},day:${Number(since.slice(8,10))}),end:(year:${until.slice(0,4)},month:${Number(until.slice(5,7))},day:${Number(until.slice(8,10))}))`, fields: "dateRange,pivotValues,costInLocalCurrency,impressions,clicks,externalWebsiteConversions", start, count: limit });
    const rows = response.data?.elements || [];
    return { rows: rows.map((row) => ({ platform: "LINKEDIN", campaignExternalId: row.campaign || row.metadata?.campaign || "UNKNOWN", creativeExternalId: row.pivotValues?.[0], date: row.dateRange?.start ? `${row.dateRange.start.year}-${String(row.dateRange.start.month).padStart(2,"0")}-${String(row.dateRange.start.day).padStart(2,"0")}` : since, currencyCode: c.currency, spend: row.costInLocalCurrency, impressions: row.impressions, clicks: row.clicks, providerConversions: row.externalWebsiteConversions, metadata: { pivot: "CREATIVE", creativeUrn: row.pivotValues?.[0], attributionWindow: "provider-defined" }, rawProviderRecord: row })), nextCursor: response.data?.paging && start + rows.length < response.data.paging.total ? String(start + rows.length) : null, providerRequestId: requestId(response), rawResponse: response.data };
  }
  return { creativeCapability: { supportedMetrics: ["spend", "impressions", "clicks", "providerConversions"], providerApiVersion: apiVersion() }, fetchCreativeCatalog, fetchCreativeInsights };
}

function googleConnector() {
  const version = (connection) => googleLifecycle.apiVersion(connection);
  async function search(connection, query, cursor, limit) {
    const c = stateFor(connection, () => ({ ...credentials(connection), ...(googleLifecycle.resolveCredentials(connection) || {}) }));
    if (!c.__creativeRefreshed && c.clientId && c.clientSecret && c.refreshToken) {
      c.accessToken = await googleLifecycle.refreshAccessToken({ credentials: c, httpClient: axios });
      c.__creativeRefreshed = true;
    }
    if (!c.accessToken || !c.developerToken) throw new ProviderError("GOOGLE_ADS", "config", "Google Ads access token and developer token are required");
    const customerId = String(c.customerId || c.accountId).replace(/-/g, "");
    return post("GOOGLE_ADS", `https://googleads.googleapis.com/${version(connection)}/customers/${customerId}/googleAds:search`, { query, page_size: limit, ...(cursor ? { page_token: cursor } : {}) }, { headers: { Authorization: `Bearer ${c.accessToken}`, "developer-token": c.developerToken, ...(c.loginCustomerId ? { "login-customer-id": String(c.loginCustomerId).replace(/-/g, "") } : {}) } });
  }
  async function fetchCreativeCatalog({ connection, cursor, limit = 1000 }) {
    const response = await search(connection, "SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad.resource_name, ad_group_ad.ad.final_urls FROM ad_group_ad", cursor, limit);
    const rows = response.data?.results || [];
    return { items: rows.map((row) => ({ platform: "GOOGLE_ADS", campaignExternalId: String(row.campaign?.id), adGroupExternalId: String(row.adGroup?.id), adExternalId: String(row.adGroupAd?.ad?.id), creativeExternalId: row.adGroupAd?.ad?.resourceName || String(row.adGroupAd?.ad?.id), name: row.adGroupAd?.ad?.name, type: /video/i.test(row.adGroupAd?.ad?.type || "") ? "VIDEO" : /image/i.test(row.adGroupAd?.ad?.type || "") ? "IMAGE" : /responsive/i.test(row.adGroupAd?.ad?.type || "") ? "RESPONSIVE" : "UNKNOWN", nativeType: row.adGroupAd?.ad?.type, status: row.adGroupAd?.status, sourceUrl: row.adGroupAd?.ad?.finalUrls?.[0], nativeIdentifiers: { campaignResourceName: row.campaign?.resourceName, adGroupResourceName: row.adGroup?.resourceName, adResourceName: row.adGroupAd?.ad?.resourceName }, metadata: { scoredUnit: "ad", sharedAssetsNotDuplicated: true } })), nextCursor: response.data?.nextPageToken || null, providerRequestId: requestId(response), rawResponse: response.data };
  }
  async function fetchCreativeInsights({ connection, since, until, cursor, limit = 1000 }) {
    const c = credentials(connection); const query = `SELECT segments.date, campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.resource_name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM ad_group_ad WHERE segments.date BETWEEN '${since}' AND '${until}'`;
    const response = await search(connection, query, cursor, limit); const rows = response.data?.results || [];
    return { rows: rows.map((row) => ({ platform: "GOOGLE_ADS", campaignExternalId: String(row.campaign?.id), adGroupExternalId: String(row.adGroup?.id), adExternalId: String(row.adGroupAd?.ad?.id), creativeExternalId: row.adGroupAd?.ad?.resourceName || String(row.adGroupAd?.ad?.id), date: row.segments?.date, currencyCode: c.currency, spend: microsToMajor(row.metrics?.costMicros), impressions: row.metrics?.impressions, clicks: row.metrics?.clicks, providerConversions: row.metrics?.conversions, metadata: { scoredUnit: "ad", costSource: "micros", sharedAssetsNotDuplicated: true }, rawProviderRecord: row })), nextCursor: response.data?.nextPageToken || null, providerRequestId: requestId(response), rawResponse: response.data };
  }
  return { creativeCapability: { supportedMetrics: ["spend", "impressions", "clicks", "providerConversions"], providerApiVersion: version() }, fetchCreativeCatalog, fetchCreativeInsights };
}

function xConnector() {
  function auth(c, method, url, params) { const oauth = OAuth({ consumer: { key: c.consumerKey, secret: c.consumerSecret }, signature_method: "HMAC-SHA1", hash_function: (base, key) => crypto.createHmac("sha1", key).update(base).digest("base64") }); return oauth.toHeader(oauth.authorize({ method, url, data: params }, { key: c.accessToken, secret: c.accessTokenSecret })); }
  const base = () => `${(process.env.X_ADS_API_BASE_URL || "https://ads-api.x.com").replace(/\/$/, "")}/${process.env.X_ADS_API_VERSION || "12"}`;
  async function xget(connection, path, params) { const c = credentials(connection); if (![c.consumerKey,c.consumerSecret,c.accessToken,c.accessTokenSecret].every(Boolean)) throw new ProviderError("X", "config", "X OAuth 1.0a credentials are required"); const url = `${base()}${path}`; return get("X", url, { params, headers: auth(c, "GET", url, params) }); }
  async function fetchCreativeCatalog({ connection, cursor, limit = 100 }) { const params = { count: limit, ...(cursor ? { cursor } : {}) }; const response = await xget(connection, `/accounts/${encodeURIComponent(connection.accountId)}/promoted_tweets`, params); const rows = response.data?.data || []; return { items: rows.map((row) => ({ platform: "X", campaignExternalId: row.campaign_id || row.line_item_id || "UNKNOWN", adGroupExternalId: row.line_item_id, adExternalId: row.id, creativeExternalId: row.tweet_id || row.id, name: row.name, type: row.media_ids?.length ? "IMAGE" : "TEXT", status: row.approval_status || row.entity_status, nativeIdentifiers: { lineItemId: row.line_item_id, promotedTweetId: row.id, tweetId: row.tweet_id, mediaIds: row.media_ids }, metadata: { scoredUnit: "promoted_entity" } })), nextCursor: response.data?.next_cursor && response.data.next_cursor !== "0" ? response.data.next_cursor : null, providerRequestId: requestId(response), rawResponse: response.data }; }
  async function fetchCreativeInsights({ connection, since, until, cursor, limit = 100 }) { const c = credentials(connection); const params = { entity: "PROMOTED_TWEET", start_time: `${since}T00:00:00Z`, end_time: `${until}T23:59:59Z`, granularity: "DAY", metric_groups: "ENGAGEMENT,BILLING", count: limit, ...(cursor ? { cursor } : {}) }; const response = await xget(connection, `/stats/accounts/${encodeURIComponent(connection.accountId)}`, params); const rows = response.data?.data || []; return { rows: rows.flatMap((entry) => (entry.id_data || []).map((segment) => ({ platform: "X", campaignExternalId: entry.campaign_id || entry.line_item_id || "UNKNOWN", adGroupExternalId: entry.line_item_id, adExternalId: entry.id, creativeExternalId: entry.tweet_id || entry.id, date: segment.segment?.start_time || segment.date || since, currencyCode: c.currency, spend: microsToMajor(segment.metrics?.billed_charge_local_micro), impressions: segment.metrics?.impressions, clicks: segment.metrics?.clicks || segment.metrics?.url_clicks, providerConversions: segment.metrics?.conversions, metadata: { scoredUnit: "promoted_entity", costSource: "micros" }, rawProviderRecord: entry }))), nextCursor: response.data?.next_cursor && response.data.next_cursor !== "0" ? response.data.next_cursor : null, providerRequestId: requestId(response), rawResponse: response.data }; }
  return { creativeCapability: { supportedMetrics: ["spend", "impressions", "clicks"], providerApiVersion: process.env.X_ADS_API_VERSION || "12" }, fetchCreativeCatalog, fetchCreativeInsights };
}

const CREATIVE_PROVIDER_CONNECTORS = Object.freeze({ META: metaConnector(), TIKTOK: tiktokConnector(), X: xConnector(), LINKEDIN: linkedinConnector(), GOOGLE_ADS: googleConnector() });
module.exports = { CREATIVE_PROVIDER_CONNECTORS, microsToMajor, sumProviderActions };
