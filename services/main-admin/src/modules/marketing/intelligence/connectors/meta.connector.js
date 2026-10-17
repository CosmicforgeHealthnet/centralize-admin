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
} = require("./provider-http");
const { decryptCredential } = require("../utils/credential-encryption");
const logger = require("../../../../shared/utils/logger");
const { EVENTS, logEvent } = require("../observability");

// Meta Marketing Insights connector (campaign level, daily increment).
// Docs: https://developers.facebook.com/docs/marketing-api/insights

const PLATFORM = "META";
const DEFAULT_GRAPH_API_VERSION = "v25.0";
const INSIGHT_FIELDS =
  "campaign_id,campaign_name,spend,impressions,clicks,date_start,date_stop";
const PAGE_LIMIT = 500;
const MAX_PAGES = 200;

function graphApiVersion() {
  return process.env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_API_VERSION;
}

// Resolve credentials: active AdPlatformConnection record first, environment
// variables (META_ACCESS_TOKEN / META_AD_ACCOUNT_ID) as bootstrap fallback.
function resolveCredentials(connection) {
  if (connection && connection.accessToken) {
    return {
      accessToken: decryptCredential(connection.accessToken),
      accountId: connection.accountId,
      currency: connection.currency || connection.connectionMetadata?.currency || "UNSPECIFIED",
    };
  }

  const accessToken = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;

  if (!accessToken || !accountId) return null;

    return {
      accessToken,
      accountId,
      currency: process.env.META_CURRENCY || process.env.META_ACCOUNT_CURRENCY || "UNSPECIFIED",
    };
}

function normalizeAccountPath(accountId) {
  const normalized = String(accountId || "").trim();
  return normalized.startsWith("act_") ? normalized : `act_${normalized}`;
}

function validateConfiguration({ connection } = {}) {
  try {
    const credentials = resolveCredentials(connection);
    if (!credentials) {
      return {
        ok: false,
        reason:
          "No Meta credentials available (no active connection and META_ACCESS_TOKEN / META_AD_ACCOUNT_ID are unset)",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function normalizeRow(row, currency = "UNSPECIFIED") {
  const date = toUtcDateString(row.date_start);

  return {
    platform: PLATFORM,
    campaignExternalId: String(row.campaign_id || ""),
    campaignName: String(row.campaign_name || ""),
    date,
    spend: safeSpend(row.spend),
    currency,
    impressions: safeCount(row.impressions),
    clicks: safeCount(row.clicks),
    raw: row,
  };
}

// Fetch daily campaign insights for the inclusive [since, until] UTC range.
// Handles Graph API cursor pagination until all pages are retrieved.
async function fetchDailyCampaignInsights({ since, until, connection, httpClient } = {}) {
  const credentials = resolveCredentials(connection);
  if (!credentials) {
    throw new ProviderError(PLATFORM, "config", "Meta credentials are not configured");
  }

  const client = httpClient || axios;
  const accountPath = normalizeAccountPath(credentials.accountId);

  let url = `https://graph.facebook.com/${graphApiVersion()}/${accountPath}/insights`;
  let params = {
    level: "campaign",
    time_increment: 1,
    fields: INSIGHT_FIELDS,
    time_range: JSON.stringify({ since, until }),
    limit: PAGE_LIMIT,
    access_token: credentials.accessToken,
  };

  const rows = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const requestUrl = url;
    const requestParams = params;

    const response = await requestWithRetry(PLATFORM, () =>
      client.get(requestUrl, {
        params: requestParams,
        timeout: providerTimeoutMs(),
      }),
    );

    const body = response?.data;
    if (!body || !Array.isArray(body.data)) {
      throw new ProviderError(
        PLATFORM,
        "malformed",
        "Meta insights response did not contain a data array",
      );
    }

    for (const row of body.data) {
      rows.push(normalizeRow(row, credentials.currency));
    }

    const nextUrl = body.paging?.next;
    if (!nextUrl) break;

    // paging.next is a fully qualified URL that already carries the access
    // token and cursor  never log it.
    url = nextUrl;
    params = undefined;
  }

  logEvent(EVENTS.PROVIDER_FETCH_COMPLETED, { platform: PLATFORM, connectionId: connection?.id || null, operation: "CAMPAIGN_INSIGHTS", windowStart: since, windowEnd: until, rowsProcessed: rows.length, status: "SUCCEEDED" }, { log: logger });

  return rows;
}

module.exports = {
  platform: PLATFORM,
  validateConfiguration,
  fetchDailyCampaignInsights,
  normalizeRow,
  normalizeAccountPath,
};
