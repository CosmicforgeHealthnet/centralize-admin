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
const { EVENTS, logEvent } = require("../observability");

const PLATFORM = "LINKEDIN";
const API_BASE = "https://api.linkedin.com/rest";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const DEFAULT_LINKEDIN_VERSION = "202606";
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_PAGES = 200;
const PAGE_SIZE = 100;

function linkedInVersion(connection) {
  const value =
    connection?.connectionMetadata?.apiVersion ||
    process.env.LINKEDIN_API_VERSION ||
    DEFAULT_LINKEDIN_VERSION;
  if (!/^\d{6}$/.test(String(value))) {
    throw new ProviderError(PLATFORM, "config", "LINKEDIN_API_VERSION must use YYYYMM format");
  }
  return String(value);
}

function resolveCredentials(connection) {
  if (connection?.encryptedCredentials) {
    const stored = resolveStoredCredentials(connection);
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      accountUrn: connection.connectionMetadata?.accountUrn || connection.accountId,
      accessTokenExpiresAt: connection.accessTokenExpiresAt || null,
      currency: connection.currency || connection.connectionMetadata?.currency || "UNSPECIFIED",
    };
  }

  const credentials = {
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    accessToken: process.env.LINKEDIN_ACCESS_TOKEN,
    refreshToken: process.env.LINKEDIN_REFRESH_TOKEN,
    accountUrn: process.env.LINKEDIN_AD_ACCOUNT_URN,
    accessTokenExpiresAt: null,
    currency: process.env.LINKEDIN_CURRENCY || process.env.LINKEDIN_ACCOUNT_CURRENCY || "UNSPECIFIED",
  };
  return credentials.accessToken && credentials.accountUrn ? credentials : null;
}

function validateConfiguration({ connection } = {}) {
  try {
    linkedInVersion(connection);
    const credentials = resolveCredentials(connection);
    if (!credentials) return { ok: false, reason: "No LinkedIn Ads credentials available" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function headers(credentials, connection) {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    "LinkedIn-Version": linkedInVersion(connection),
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

function classifyLinkedInError(error) {
  const status = error.response?.status;
  const message = sanitizeProviderText(error.response?.data?.message || error.message || "LinkedIn request failed");
  if (status === 401 || status === 403) {
    return new ProviderError(PLATFORM, "auth", "LinkedIn rejected credentials or permissions", { statusCode: status });
  }
  if (status === 429) {
    return new ProviderError(PLATFORM, "rate_limit", "LinkedIn rate limit reached", {
      retryable: true,
      statusCode: status,
    });
  }
  if (status >= 500) {
    return new ProviderError(PLATFORM, "provider", `LinkedIn returned HTTP ${status}`, {
      retryable: true,
      statusCode: status,
    });
  }
  return new ProviderError(PLATFORM, "provider", `LinkedIn request failed: ${message}`, { statusCode: status || null });
}

function tokenNeedsRefresh(credentials) {
  if (!credentials.accessTokenExpiresAt) return false;
  const expiresAt = new Date(credentials.accessTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt - Date.now() < EXPIRY_MARGIN_MS;
}

function expirySecondsToDate(seconds) {
  const parsed = Number(seconds);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(Date.now() + parsed * 1000) : null;
}

async function refreshAccessToken({ credentials, httpClient, onTokensRefreshed } = {}) {
  if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) {
    throw new ProviderError(PLATFORM, "auth", "LinkedIn access token requires reauthorization");
  }
  const client = httpClient || axios;
  const response = await requestWithRetry(PLATFORM, () =>
    client.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }).toString(),
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        timeout: providerTimeoutMs(),
      },
    ).catch((error) => {
      throw classifyLinkedInError(error);
    }),
  );
  const body = response.data || {};
  if (!body.access_token) throw new ProviderError(PLATFORM, "auth", "LinkedIn token refresh did not return an access token");
  const tokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    accessTokenExpiresAt: expirySecondsToDate(body.expires_in),
    refreshTokenExpiresAt: expirySecondsToDate(body.refresh_token_expires_in),
  };
  credentials.accessToken = tokens.accessToken;
  if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
  credentials.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
  if (typeof onTokensRefreshed === "function") await onTokensRefreshed(tokens);
  return tokens;
}

async function linkedinGet(client, credentials, connection, path, params) {
  try {
    return await requestWithRetry(PLATFORM, () =>
      client.get(`${API_BASE}${path}`, {
        params,
        headers: headers(credentials, connection),
        timeout: providerTimeoutMs(),
      }).catch((error) => {
        throw classifyLinkedInError(error);
      }),
    );
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw classifyLinkedInError(error);
  }
}

function dateParts(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return { year, month, day };
}

async function fetchAllPages(client, credentials, connection, path, params) {
  const elements = [];
  const seen = new Set();
  for (let start = 0, page = 0; page < MAX_PAGES; page += 1, start += PAGE_SIZE) {
    const key = `${path}:${start}`;
    if (seen.has(key)) break;
    seen.add(key);
    const response = await linkedinGet(client, credentials, connection, path, {
      ...params,
      start,
      count: PAGE_SIZE,
    });
    const pageElements = response.data?.elements || [];
    elements.push(...pageElements);
    const paging = response.data?.paging || {};
    if (pageElements.length === 0 || paging.total <= start + pageElements.length) break;
  }
  return elements;
}

async function fetchCampaignNames(client, credentials, connection, campaignUrns) {
  const names = new Map();
  for (const urn of campaignUrns) {
    try {
      const response = await linkedinGet(
        client,
        credentials,
        connection,
        `/adCampaigns/${encodeURIComponent(urn)}`,
        {},
      );
      names.set(urn, response.data?.name || `LinkedIn Campaign ${urn.split(":").pop()}`);
    } catch (error) {
      names.set(urn, `LinkedIn Campaign ${urn.split(":").pop()}`);
    }
  }
  return names;
}

function normalizeAnalyticsRow(row, names, currency) {
  const pivot = row.pivotValues?.[0] || row.campaign || row.campaignUrn;
  const campaignExternalId = String(pivot || "").split(":").pop();
  const date = toUtcDateString(
    row.dateRange?.start
      ? `${row.dateRange.start.year}-${String(row.dateRange.start.month).padStart(2, "0")}-${String(row.dateRange.start.day).padStart(2, "0")}`
      : row.date,
  );
  return {
    platform: PLATFORM,
    campaignExternalId,
    campaignName: names.get(pivot) || `LinkedIn Campaign ${campaignExternalId}`,
    date,
    currency,
    spend: safeSpend(row.costInLocalCurrency),
    impressions: safeCount(row.impressions),
    clicks: safeCount(row.clicks),
    raw: row,
  };
}

async function fetchDailyCampaignInsights({
  since,
  until,
  connection,
  httpClient,
  onTokensRefreshed,
} = {}) {
  const credentials = resolveCredentials(connection);
  if (!credentials) throw new ProviderError(PLATFORM, "config", "LinkedIn Ads credentials are not configured");
  const client = httpClient || axios;
  if (tokenNeedsRefresh(credentials)) {
    await refreshAccessToken({ credentials, httpClient: client, onTokensRefreshed });
  }

  const params = {
    q: "analytics",
    pivot: "CAMPAIGN",
    timeGranularity: "DAILY",
    accounts: `List(${credentials.accountUrn})`,
    dateRange: `(start:(year:${dateParts(since).year},month:${dateParts(since).month},day:${dateParts(since).day}),end:(year:${dateParts(until).year},month:${dateParts(until).month},day:${dateParts(until).day}))`,
    fields: "dateRange,pivotValues,impressions,clicks,costInLocalCurrency",
  };

  let elements;
  try {
    elements = await fetchAllPages(client, credentials, connection, "/adAnalytics", params);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "auth" && credentials.refreshToken) {
      await refreshAccessToken({ credentials, httpClient: client, onTokensRefreshed });
      elements = await fetchAllPages(client, credentials, connection, "/adAnalytics", params);
    } else {
      throw error;
    }
  }

  const campaignUrns = [...new Set(elements.map((row) => row.pivotValues?.[0]).filter(Boolean))];
  const names = await fetchCampaignNames(client, credentials, connection, campaignUrns);
  const rows = elements.map((row) => normalizeAnalyticsRow(row, names, credentials.currency)).filter((row) => row.campaignExternalId && row.date);
  logEvent(EVENTS.PROVIDER_FETCH_COMPLETED, { platform: PLATFORM, connectionId: connection?.id || null, operation: "CAMPAIGN_INSIGHTS", windowStart: since, windowEnd: until, rowsProcessed: rows.length, status: "SUCCEEDED" }, { log: logger });
  return rows;
}

module.exports = {
  platform: PLATFORM,
  validateConfiguration,
  fetchDailyCampaignInsights,
  refreshAccessToken,
  resolveCredentials,
  tokenNeedsRefresh,
  linkedInVersion,
  headers,
  normalizeAnalyticsRow,
};
