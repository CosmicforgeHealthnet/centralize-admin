const axios = require("axios");
const crypto = require("crypto");
const zlib = require("zlib");
const OAuth = require("oauth-1.0a");
const {
  safeCount,
  safeSpend,
  toUtcDateString,
} = require("./connector.interface");
const {
  ProviderError,
  providerTimeoutMs,
  requestWithRetry,
  sanitizeProviderText,
} = require("./provider-http");
const {
  resolveStoredCredentials,
} = require("../utils/credential-envelope");
const logger = require("../../../../shared/utils/logger");
const { EVENTS, logEvent } = require("../observability");

const PLATFORM = "X";
const DEFAULT_API_HOST = "https://ads-api.x.com";
const DEFAULT_API_VERSION = "12";
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const ENTITY_BATCH_SIZE = 20;
const SYNC_MAX_DAYS = 7;
const ASYNC_POLL_INTERVAL_MS = 1000;
const ASYNC_MAX_POLLS = 20;

function apiBaseUrl() {
  const base = (process.env.X_ADS_API_BASE_URL || DEFAULT_API_HOST).replace(/\/$/, "");
  const version = process.env.X_ADS_API_VERSION || DEFAULT_API_VERSION;
  return /\/\d+$/.test(base) ? base : `${base}/${version}`;
}

function resolveCredentials(connection) {
  if (connection?.encryptedCredentials) {
    const stored = resolveStoredCredentials(connection);
    return {
      consumerKey: stored.consumerKey,
      consumerSecret: stored.consumerSecret,
      accessToken: stored.accessToken,
      accessTokenSecret: stored.accessTokenSecret,
      accountId: connection.connectionMetadata?.accountId || connection.accountId,
      currency: connection.currency || connection.connectionMetadata?.currency || "UNSPECIFIED",
    };
  }

  const credentials = {
    consumerKey: process.env.X_ADS_CONSUMER_KEY,
    consumerSecret: process.env.X_ADS_CONSUMER_SECRET,
    accessToken: process.env.X_ADS_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ADS_ACCESS_TOKEN_SECRET,
    accountId: process.env.X_ADS_ACCOUNT_ID,
    currency: process.env.X_ADS_CURRENCY || process.env.X_ADS_ACCOUNT_CURRENCY || "UNSPECIFIED",
  };

  return Object.values(credentials).slice(0, 5).every(Boolean) ? credentials : null;
}

function validateConfiguration({ connection } = {}) {
  try {
    const credentials = resolveCredentials(connection);
    if (!credentials) {
      return {
        ok: false,
        reason: "No X Ads credentials available",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function oauthClient(credentials) {
  return OAuth({
    consumer: {
      key: credentials.consumerKey,
      secret: credentials.consumerSecret,
    },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

function authorizationHeader({ method, url, params, credentials }) {
  const oauth = oauthClient(credentials);
  const token = {
    key: credentials.accessToken,
    secret: credentials.accessTokenSecret,
  };
  return oauth.toHeader(oauth.authorize({ method, url, data: params }, token));
}

function classifyXError(error) {
  const status = error.response?.status;
  const message = sanitizeProviderText(
    error.response?.data?.errors?.[0]?.message ||
      error.response?.data?.message ||
      error.message ||
      "X Ads request failed",
  );

  if (status === 401 || status === 403) {
    return new ProviderError(PLATFORM, "auth", "X Ads rejected OAuth credentials or account permissions", {
      statusCode: status,
    });
  }
  if (status === 429) {
    return new ProviderError(PLATFORM, "rate_limit", "X Ads rate limit reached", {
      retryable: true,
      statusCode: status,
    });
  }
  if (status >= 500) {
    return new ProviderError(PLATFORM, "provider", `X Ads returned HTTP ${status}`, {
      retryable: true,
      statusCode: status,
    });
  }
  return new ProviderError(PLATFORM, "provider", `X Ads request failed: ${message}`, {
    statusCode: status || null,
  });
}

async function signedRequest(client, credentials, method, path, { params, data, responseType } = {}) {
  const url = `${apiBaseUrl()}${path}`;
  const headers = authorizationHeader({ method, url, params, credentials });
  try {
    return await requestWithRetry(PLATFORM, () =>
      client.request({
        method,
        url,
        params,
        data,
        responseType,
        headers,
        timeout: providerTimeoutMs(),
      }).catch((error) => {
        throw classifyXError(error);
      }),
    );
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw classifyXError(error);
  }
}

async function fetchCampaigns({ client, credentials }) {
  const campaigns = new Map();
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { count: PAGE_SIZE };
    if (cursor) params.cursor = cursor;
    const response = await signedRequest(
      client,
      credentials,
      "GET",
      `/accounts/${encodeURIComponent(credentials.accountId)}/campaigns`,
      { params },
    );
    const body = response?.data || {};
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const campaign of rows) {
      const id = String(campaign.id || "");
      if (id) campaigns.set(id, campaign.name || `X Campaign ${id}`);
    }
    cursor = body.next_cursor || body.nextCursor || null;
    if (!cursor || cursor === "0") break;
  }

  return campaigns;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daySpan(since, until) {
  const start = new Date(`${since}T00:00:00.000Z`).getTime();
  const end = new Date(`${until}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function microToSpend(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "0.00";
  return safeSpend(parsed / 1_000_000);
}

function normalizeAnalyticsRows(body, campaignNames, currency) {
  const sourceRows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const rows = [];

  for (const item of sourceRows) {
    const campaignId = String(item.id || item.entity_id || item.campaign_id || "");
    const idData = item.id_data || item.idData || [];
    const segments = Array.isArray(idData) ? idData : [item];
    for (const segment of segments) {
      const metrics = segment.metrics || segment;
      const dates = metrics.date || metrics.segment || metrics.start_time || item.date;
      const date = toUtcDateString(Array.isArray(dates) ? dates[0] : dates);
      if (!campaignId || !date) continue;
      rows.push({
        platform: PLATFORM,
        campaignExternalId: campaignId,
        campaignName: campaignNames.get(campaignId) || `X Campaign ${campaignId}`,
        date,
        currency,
        spend: microToSpend(
          metrics.billed_charge_local_micro ||
            metrics.spend_micro ||
            metrics.spend_micros ||
            metrics.spend,
        ),
        impressions: safeCount(metrics.impressions),
        clicks: safeCount(metrics.clicks || metrics.url_clicks),
        raw: item,
      });
    }
  }

  return rows;
}

async function fetchSynchronousAnalytics({ client, credentials, campaignIds, since, until, campaignNames }) {
  const rows = [];
  for (let i = 0; i < campaignIds.length; i += ENTITY_BATCH_SIZE) {
    const batch = campaignIds.slice(i, i + ENTITY_BATCH_SIZE);
    const response = await signedRequest(
      client,
      credentials,
      "GET",
      `/stats/accounts/${encodeURIComponent(credentials.accountId)}`,
      {
        params: {
          entity: "CAMPAIGN",
          entity_ids: batch.join(","),
          start_time: `${since}T00:00:00Z`,
          end_time: `${addDays(until, 1)}T00:00:00Z`,
          granularity: "DAY",
          metric_groups: "ENGAGEMENT,BILLING",
        },
      },
    );
    rows.push(...normalizeAnalyticsRows(response.data, campaignNames, credentials.currency));
  }
  return rows;
}

function parseDownloadedAnalytics(response) {
  let payload = response.data;
  if (Buffer.isBuffer(payload)) {
    try {
      payload = zlib.gunzipSync(payload).toString("utf8");
    } catch {
      payload = payload.toString("utf8");
    }
  }
  if (typeof payload === "string") return JSON.parse(payload);
  return payload;
}

async function fetchAsynchronousAnalytics({ client, credentials, campaignIds, since, until, campaignNames }) {
  const create = await signedRequest(
    client,
    credentials,
    "POST",
    `/stats/jobs/accounts/${encodeURIComponent(credentials.accountId)}`,
    {
      data: {
        entity: "CAMPAIGN",
        entity_ids: campaignIds,
        start_time: `${since}T00:00:00Z`,
        end_time: `${addDays(until, 1)}T00:00:00Z`,
        granularity: "DAY",
        metric_groups: ["ENGAGEMENT", "BILLING"],
      },
    },
  );
  const jobId = create.data?.data?.id || create.data?.id;
  if (!jobId) throw new ProviderError(PLATFORM, "malformed", "X async job response did not include a job id");

  let job;
  for (let poll = 0; poll < ASYNC_MAX_POLLS; poll += 1) {
    const response = await signedRequest(
      client,
      credentials,
      "GET",
      `/stats/jobs/accounts/${encodeURIComponent(credentials.accountId)}/${encodeURIComponent(jobId)}`,
    );
    job = response.data?.data || response.data;
    const status = String(job.status || "").toUpperCase();
    if (["SUCCESS", "COMPLETED"].includes(status)) break;
    if (["FAILED", "ERROR", "CANCELLED"].includes(status)) {
      throw new ProviderError(PLATFORM, "provider", "X async analytics job failed");
    }
    await new Promise((resolve) => setTimeout(resolve, ASYNC_POLL_INTERVAL_MS));
  }

  const status = String(job?.status || "").toUpperCase();
  if (!["SUCCESS", "COMPLETED"].includes(status)) {
    throw new ProviderError(PLATFORM, "timeout", "X async analytics job polling timed out", {
      retryable: true,
    });
  }

  const downloadUrl = job.url || job.download_url || job.result_url;
  if (!downloadUrl) throw new ProviderError(PLATFORM, "malformed", "X async job completed without a download URL");

  const download = await signedRequest(client, credentials, "GET", downloadUrl.replace(apiBaseUrl(), ""), {
    responseType: "arraybuffer",
  });
  const parsed = parseDownloadedAnalytics(download);
  return normalizeAnalyticsRows(parsed, campaignNames, credentials.currency);
}

async function fetchDailyCampaignInsights({ since, until, connection, httpClient } = {}) {
  const credentials = resolveCredentials(connection);
  if (!credentials) throw new ProviderError(PLATFORM, "config", "X Ads credentials are not configured");
  const client = httpClient || axios;
  const campaignNames = await fetchCampaigns({ client, credentials });
  const campaignIds = Array.from(campaignNames.keys());
  if (campaignIds.length === 0) return [];

  const rows =
    daySpan(since, until) <= SYNC_MAX_DAYS
      ? await fetchSynchronousAnalytics({ client, credentials, campaignIds, since, until, campaignNames })
      : await fetchAsynchronousAnalytics({ client, credentials, campaignIds, since, until, campaignNames });

  logEvent(EVENTS.PROVIDER_FETCH_COMPLETED, { platform: PLATFORM, connectionId: connection?.id || null, operation: "CAMPAIGN_INSIGHTS", windowStart: since, windowEnd: until, rowsProcessed: rows.length, status: "SUCCEEDED" }, { log: logger });
  return rows;
}

module.exports = {
  platform: PLATFORM,
  validateConfiguration,
  fetchDailyCampaignInsights,
  resolveCredentials,
  authorizationHeader,
  normalizeAnalyticsRows,
  microToSpend,
};
