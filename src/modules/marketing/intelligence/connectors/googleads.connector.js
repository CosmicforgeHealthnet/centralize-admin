const axios = require("axios");
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

const PLATFORM = "GOOGLE_ADS";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_API_VERSION = "v24";
const MAX_PAGES = 200;

function apiVersion(connection) {
  return connection?.connectionMetadata?.apiVersion || process.env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
}

function normalizeCustomerId(value) {
  const normalized = String(value || "").replace(/-/g, "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ProviderError(PLATFORM, "config", "Google Ads customer IDs must be numeric after dash removal");
  }
  return normalized;
}

function resolveCredentials(connection) {
  if (connection?.encryptedCredentials) {
    const stored = resolveStoredCredentials(connection);
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      refreshToken: stored.refreshToken,
      developerToken: stored.developerToken,
      customerId: normalizeCustomerId(connection.connectionMetadata?.customerId || connection.accountId),
      loginCustomerId: connection.connectionMetadata?.loginCustomerId
        ? normalizeCustomerId(connection.connectionMetadata.loginCustomerId)
        : null,
      currency: connection.currency || connection.connectionMetadata?.currency || "UNSPECIFIED",
    };
  }

  if (
    !process.env.GOOGLE_ADS_CLIENT_ID ||
    !process.env.GOOGLE_ADS_CLIENT_SECRET ||
    !process.env.GOOGLE_ADS_REFRESH_TOKEN ||
    !process.env.GOOGLE_ADS_DEVELOPER_TOKEN ||
    !process.env.GOOGLE_ADS_CUSTOMER_ID
  ) {
    return null;
  }
  return {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    customerId: normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID),
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
      ? normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
      : null,
    currency: process.env.GOOGLE_ADS_CURRENCY || process.env.GOOGLE_ADS_ACCOUNT_CURRENCY || "UNSPECIFIED",
  };
}

function validateConfiguration({ connection } = {}) {
  try {
    const credentials = resolveCredentials(connection);
    if (!credentials) return { ok: false, reason: "No Google Ads credentials available" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function classifyGoogleAdsError(error) {
  const status = error.response?.status;
  const message = sanitizeProviderText(error.response?.data?.error?.message || error.message || "Google Ads request failed");
  if (status === 400 && /developer token|customer|login-customer|invalid/i.test(message)) {
    return new ProviderError(PLATFORM, "auth", `Google Ads configuration rejected: ${message}`, { statusCode: status });
  }
  if (status === 401 || status === 403) {
    return new ProviderError(PLATFORM, "auth", "Google Ads rejected OAuth, developer token, or customer access", {
      statusCode: status,
    });
  }
  if (status === 429) {
    return new ProviderError(PLATFORM, "rate_limit", "Google Ads rate limit reached", {
      retryable: true,
      statusCode: status,
    });
  }
  if (status >= 500) {
    return new ProviderError(PLATFORM, "provider", `Google Ads returned HTTP ${status}`, {
      retryable: true,
      statusCode: status,
    });
  }
  return new ProviderError(PLATFORM, "provider", `Google Ads request failed: ${message}`, { statusCode: status || null });
}

async function refreshAccessToken({ credentials, httpClient } = {}) {
  const client = httpClient || axios;
  const response = await requestWithRetry(PLATFORM, () =>
    client.post(
      TOKEN_URL,
      new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        timeout: providerTimeoutMs(),
      },
    ).catch((error) => {
      throw classifyGoogleAdsError(error);
    }),
  );
  if (!response.data?.access_token) {
    throw new ProviderError(PLATFORM, "auth", "Google OAuth refresh did not return an access token");
  }
  return response.data.access_token;
}

function gaql(since, until) {
  return `
SELECT
  campaign.id,
  campaign.name,
  segments.date,
  metrics.cost_micros,
  metrics.impressions,
  metrics.clicks
FROM campaign
WHERE segments.date BETWEEN '${since}' AND '${until}'
`.trim();
}

function normalizeRow(row, currency) {
  const campaign = row.campaign || {};
  const metrics = row.metrics || {};
  const segments = row.segments || {};
  return {
    platform: PLATFORM,
    campaignExternalId: String(campaign.id || row.campaign_id || ""),
    campaignName: String(campaign.name || row.campaign_name || ""),
    date: toUtcDateString(segments.date || row.date),
    currency,
    spend: safeSpend(Number(metrics.costMicros ?? metrics.cost_micros ?? 0) / 1_000_000),
    impressions: safeCount(metrics.impressions),
    clicks: safeCount(metrics.clicks),
    raw: row,
  };
}

async function fetchDailyCampaignInsights({ since, until, connection, httpClient } = {}) {
  const credentials = resolveCredentials(connection);
  if (!credentials) throw new ProviderError(PLATFORM, "config", "Google Ads credentials are not configured");
  const client = httpClient || axios;
  const accessToken = await refreshAccessToken({ credentials, httpClient: client });
  const rows = [];
  let pageToken = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await requestWithRetry(PLATFORM, () =>
      client.post(
        `https://googleads.googleapis.com/${apiVersion(connection)}/customers/${credentials.customerId}/googleAds:search`,
        { query: gaql(since, until), pageToken },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "developer-token": credentials.developerToken,
            ...(credentials.loginCustomerId && { "login-customer-id": credentials.loginCustomerId }),
          },
          timeout: providerTimeoutMs(),
        },
      ).catch((error) => {
        throw classifyGoogleAdsError(error);
      }),
    );
    for (const result of response.data?.results || []) {
      const normalized = normalizeRow(result, credentials.currency);
      if (normalized.campaignExternalId && normalized.date) rows.push(normalized);
    }
    pageToken = response.data?.nextPageToken || null;
    if (!pageToken) break;
  }

  logger.info(`[MarketingIntelligence] GOOGLE_ADS fetched ${rows.length} campaign/day rows for ${since}..${until}`);
  return rows;
}

module.exports = {
  platform: PLATFORM,
  validateConfiguration,
  fetchDailyCampaignInsights,
  refreshAccessToken,
  normalizeCustomerId,
  normalizeRow,
  gaql,
  resolveCredentials,
};
