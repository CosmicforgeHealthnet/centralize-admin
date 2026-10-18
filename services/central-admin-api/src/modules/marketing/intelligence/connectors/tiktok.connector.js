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
const { decryptCredential } = require("../utils/credential-encryption");
const { resolveStoredCredentials } = require("../utils/credential-envelope");
const logger = require("../../../../shared/utils/logger");
const { EVENTS, logEvent } = require("../observability");

// TikTok Marketing API connector  campaign-level daily basic report.
// Docs: https://business-api.tiktok.com/portal/docs?id=1740302848100353
//
// Token lifecycle: TikTok access tokens are NOT treated as permanently valid.
// When a refresh token plus app credentials (TIKTOK_APP_ID/TIKTOK_APP_SECRET)
// are available the connector:
//   - refreshes proactively before fetching when the stored
//     accessTokenExpiresAt is past or within the expiry margin, and
//   - on an expired/invalid-token response performs ONE controlled refresh
//     and retries the failed request once.
// Rotated tokens are handed to the caller through `onTokensRefreshed`
// (the aggregation service persists them encrypted on the connection).
// A permanent refresh failure surfaces as an "auth" ProviderError, which the
// aggregation service maps to connection status ERROR. Tokens are never
// logged.

const PLATFORM = "TIKTOK";
const DEFAULT_API_BASE = "https://business-api.tiktok.com/open_api";
const DEFAULT_API_VERSION = "v1.3";
const PAGE_SIZE = 200;
const MAX_PAGES = 200;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// TikTok business error codes that mean the token is expired/invalid.
const AUTH_ERROR_CODES = new Set([40100, 40101, 40102, 40104, 40105]);
const RATE_LIMIT_ERROR_CODES = new Set([40016, 40100016, 50002]);

function apiBaseUrl() {
  const base = process.env.TIKTOK_API_BASE_URL || DEFAULT_API_BASE;
  const version = process.env.TIKTOK_API_VERSION || DEFAULT_API_VERSION;
  return `${base.replace(/\/$/, "")}/${version}`;
}

function appCredentials(credentials = {}) {
  const appId = credentials.appId || process.env.TIKTOK_APP_ID;
  const appSecret = credentials.appSecret || process.env.TIKTOK_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : null;
}

// Resolve credentials: active AdPlatformConnection record first, environment
// variables (TIKTOK_ACCESS_TOKEN / TIKTOK_ADVERTISER_ID) as bootstrap fallback.
function resolveCredentials(connection) {
  if (connection && connection.accessToken) {
    const stored = connection.encryptedCredentials ? resolveStoredCredentials(connection) : {};
    return {
      accessToken: stored.accessToken || decryptCredential(connection.accessToken),
      refreshToken: stored.refreshToken || (connection.refreshToken
        ? decryptCredential(connection.refreshToken)
        : null),
      appId: stored.appId,
      appSecret: stored.appSecret,
      advertiserId: connection.accountId,
      accessTokenExpiresAt: connection.accessTokenExpiresAt || null,
      currency: connection.currency || connection.connectionMetadata?.currency || "UNSPECIFIED",
    };
  }

  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID;

  if (!accessToken || !advertiserId) return null;

  return {
    accessToken,
    refreshToken: process.env.TIKTOK_REFRESH_TOKEN || null,
    appId: process.env.TIKTOK_APP_ID || null,
    appSecret: process.env.TIKTOK_APP_SECRET || null,
    advertiserId,
    accessTokenExpiresAt: null,
    currency: process.env.TIKTOK_CURRENCY || process.env.TIKTOK_ACCOUNT_CURRENCY || "UNSPECIFIED",
  };
}

function canRefresh(credentials) {
  return Boolean(credentials?.refreshToken && appCredentials(credentials));
}

function validateConfiguration({ connection } = {}) {
  try {
    const credentials = resolveCredentials(connection);
    if (!credentials) {
      return {
        ok: false,
        reason:
          "No TikTok credentials available (no active connection and TIKTOK_ACCESS_TOKEN / TIKTOK_ADVERTISER_ID are unset)",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function expirySecondsToDate(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(Date.now() + parsed * 1000);
}

// Exchange the refresh token for a new access token. Returns the new token
// set; throws an "auth" ProviderError when TikTok permanently refuses.
async function refreshAccessToken({ credentials, httpClient } = {}) {
  const app = appCredentials(credentials);
  if (!app || !credentials?.refreshToken) {
    throw new ProviderError(
      PLATFORM,
      "auth",
      "TikTok token expired and no refresh credentials are configured (TIKTOK_APP_ID / TIKTOK_APP_SECRET / refresh token)",
    );
  }

  const client = httpClient || axios;
  const url = `${apiBaseUrl()}/oauth2/refresh_token/`;

  const response = await requestWithRetry(PLATFORM, () =>
    client.post(
      url,
      {
        app_id: app.appId,
        secret: app.appSecret,
        refresh_token: credentials.refreshToken,
      },
      { timeout: providerTimeoutMs() },
    ),
  );

  const body = response?.data;
  if (!body || typeof body.code !== "number") {
    throw new ProviderError(
      PLATFORM,
      "malformed",
      "TikTok token refresh response was not in the expected envelope",
    );
  }

  if (body.code !== 0 || !body.data?.access_token) {
    throw new ProviderError(
      PLATFORM,
      "auth",
      `TikTok token refresh failed (code ${body.code}): ${sanitizeProviderText(body.message || "refresh rejected")}`,
    );
  }

  const data = body.data;
  const tokens = {
    accessToken: data.access_token,
    // TikTok may rotate the refresh token; keep the old one when it does not.
    refreshToken: data.refresh_token || null,
    accessTokenExpiresAt: expirySecondsToDate(
      data.access_token_expire_in ?? data.expires_in,
    ),
    refreshTokenExpiresAt: expirySecondsToDate(
      data.refresh_token_expire_in ?? data.refresh_expires_in,
    ),
  };

  logEvent(EVENTS.TOKEN_REFRESHED, { platform: PLATFORM, operation: "TOKEN_REFRESH", status: "SUCCEEDED" }, { log: logger });
  return tokens;
}

async function applyRefreshedTokens(credentials, tokens, onTokensRefreshed) {
  credentials.accessToken = tokens.accessToken;
  if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
  credentials.accessTokenExpiresAt = tokens.accessTokenExpiresAt;

  if (typeof onTokensRefreshed === "function") {
    await onTokensRefreshed(tokens);
  }
}

function accessTokenNeedsRefresh(credentials) {
  if (!credentials.accessTokenExpiresAt) return false;
  const expiresAt = new Date(credentials.accessTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt - Date.now() < EXPIRY_MARGIN_MS;
}

function normalizeRow(row, currency = "UNSPECIFIED") {
  const dimensions = row.dimensions || {};
  const metrics = row.metrics || {};
  const date = toUtcDateString(dimensions.stat_time_day);

  return {
    platform: PLATFORM,
    campaignExternalId: String(dimensions.campaign_id || ""),
    campaignName: String(metrics.campaign_name || ""),
    date,
    spend: safeSpend(metrics.spend),
    currency,
    impressions: safeCount(metrics.impressions),
    clicks: safeCount(metrics.clicks),
    raw: row,
  };
}

function classifyTikTokBusinessError(code, message) {
  if (AUTH_ERROR_CODES.has(code)) {
    return new ProviderError(
      PLATFORM,
      "auth",
      "TikTok rejected the access token (expired or invalid)",
    );
  }

  if (RATE_LIMIT_ERROR_CODES.has(code)) {
    return new ProviderError(PLATFORM, "rate_limit", "TikTok rate limit reached", {
      retryable: true,
    });
  }

  return new ProviderError(
    PLATFORM,
    "provider",
    `TikTok reported error code ${code}: ${sanitizeProviderText(message || "unknown error")}`,
  );
}

// Fetch daily campaign metrics for the inclusive [since, until] UTC range.
// Handles page/total_page pagination until all pages are retrieved, plus the
// token refresh lifecycle described in the header comment.
async function fetchDailyCampaignInsights({
  since,
  until,
  connection,
  httpClient,
  onTokensRefreshed,
} = {}) {
  const credentials = resolveCredentials(connection);
  if (!credentials) {
    throw new ProviderError(PLATFORM, "config", "TikTok credentials are not configured");
  }

  const client = httpClient || axios;
  const url = `${apiBaseUrl()}/report/integrated/get/`;
  const rows = [];
  let refreshedThisRun = false;

  // Proactive refresh: expired or expiring within the margin.
  if (accessTokenNeedsRefresh(credentials) && canRefresh(credentials)) {
    refreshedThisRun = true;
    const tokens = await refreshAccessToken({ credentials, httpClient: client });
    await applyRefreshedTokens(credentials, tokens, onTokensRefreshed);
  }

  async function fetchPage(page) {
    const params = {
      advertiser_id: credentials.advertiserId,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks"]),
      start_date: since,
      end_date: until,
      page,
      page_size: PAGE_SIZE,
    };

    // Envelope and business-code checks run INSIDE the retry wrapper so that
    // retryable TikTok business errors (rate limits reported with HTTP 200)
    // get the same bounded-retry treatment as HTTP-level failures.
    return requestWithRetry(PLATFORM, async () => {
      const response = await client.get(url, {
        params,
        headers: { "Access-Token": credentials.accessToken },
        timeout: providerTimeoutMs(),
      });

      const body = response?.data;
      if (!body || typeof body.code !== "number") {
        throw new ProviderError(
          PLATFORM,
          "malformed",
          "TikTok report response was not in the expected envelope",
        );
      }

      // TikTok reports business errors with HTTP 200  inspect the code.
      if (body.code !== 0) {
        throw classifyTikTokBusinessError(body.code, body.message);
      }

      const list = body.data?.list;
      if (!Array.isArray(list)) {
        throw new ProviderError(
          PLATFORM,
          "malformed",
          "TikTok report response did not contain a data list",
        );
      }

      return body;
    });
  }

  // Fetch one page; on an expired-token response perform one controlled
  // refresh and retry the same page exactly once.
  async function fetchPageWithRefresh(page) {
    try {
      return await fetchPage(page);
    } catch (error) {
      const isAuthError = error instanceof ProviderError && error.kind === "auth";
      if (!isAuthError || refreshedThisRun || !canRefresh(credentials)) {
        throw error;
      }

      refreshedThisRun = true;
      const tokens = await refreshAccessToken({ credentials, httpClient: client });
      await applyRefreshedTokens(credentials, tokens, onTokensRefreshed);
      return fetchPage(page);
    }
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await fetchPageWithRefresh(page);

    for (const row of body.data.list) {
      rows.push(normalizeRow(row, credentials.currency));
    }

    const pageInfo = body.data?.page_info || {};
    const totalPages = safeCount(pageInfo.total_page);
    if (!totalPages || page >= totalPages) break;
  }

  logEvent(EVENTS.PROVIDER_FETCH_COMPLETED, { platform: PLATFORM, connectionId: connection?.id || null, operation: "CAMPAIGN_INSIGHTS", windowStart: since, windowEnd: until, rowsProcessed: rows.length, status: "SUCCEEDED" }, { log: logger });

  return rows;
}

module.exports = {
  platform: PLATFORM,
  validateConfiguration,
  fetchDailyCampaignInsights,
  refreshAccessToken,
  resolveCredentials,
  canRefresh,
  accessTokenNeedsRefresh,
  applyRefreshedTokens,
  apiBaseUrl,
  AUTH_ERROR_CODES,
  RATE_LIMIT_ERROR_CODES,
  normalizeRow,
};
