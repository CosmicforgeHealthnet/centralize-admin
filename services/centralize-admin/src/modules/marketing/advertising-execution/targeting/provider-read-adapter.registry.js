const axios = require("axios");
const { resolveStoredCredentials } = require("../../intelligence/utils/credential-envelope");
const { executionError } = require("../execution.errors");
const { createNetworkGuard } = require("../adapters/provider-network.policy");
const { normalizeProviderError } = require("../adapters/provider-error-normalizer");

function normalizedResult(item, fallback) {
  const nativeIdentifier = String(item?.id || item?.resourceName || item?.urn || item?.key || "").trim();
  if (!nativeIdentifier) return null;
  return { nativeIdentifier, normalizedIdentifier: String(item.normalizedId || nativeIdentifier).trim().toLowerCase(), displayName: String(item.name || item.displayName || item.label || fallback).slice(0, 512), parentIdentifier: item.parentId || null, metadata: { type: item.type || null, status: item.status || null } };
}

function safeProviderState(value) {
  if (!value || typeof value !== "object") return {};
  const allowed = new Set(["id", "resourceName", "name", "status", "effective_status", "configured_status", "daily_budget", "lifetime_budget", "budget", "bid", "start_time", "stop_time", "targeting", "placements", "creative", "review_status", "approval_status", "disapproval_reasons", "externalActor", "updated_at"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, Array.isArray(item) ? item.slice(0, 100) : item && typeof item === "object" ? safeProviderState(item) : item]));
}

function createProviderReadAdapter({ provider, apiVersion, httpClient = axios, timeoutMs = 5000, connectionLoader } = {}) {
  const networkGuard = createNetworkGuard({ provider, timeoutMs, maximumResponseBytes: 256 * 1024 });
  async function providerRequest(request, operationId = null) {
    try { return await networkGuard.request(httpClient, { ...request, timeout: timeoutMs, maxContentLength: 256 * 1024 }); }
    catch (error) { throw normalizeProviderError(error, { provider, operationId }); }
  }
  function assertVersion() { if (!apiVersion) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, reasonCode: "PROVIDER_API_VERSION_REQUIRED" }); }
  async function requestDiscovery({ connection, accountExternalId, targetingType, query }) {
    assertVersion();
    const credentials = resolveStoredCredentials(connection);
    const encoded = encodeURIComponent(query);
    let request;
    if (provider === "META") request = { method: "get", url: `https://graph.facebook.com/${apiVersion}/search`, params: { type: targetingType === "LOCATION" ? "adgeolocation" : "adinterest", q: query, access_token: credentials.accessToken, limit: 25 } };
    else if (provider === "TIKTOK") request = { method: "get", url: `https://business-api.tiktok.com/open_api/${apiVersion}/tool/targeting/search/`, params: { advertiser_id: accountExternalId, keyword: query, targeting_type: targetingType }, headers: { "Access-Token": credentials.accessToken } };
    else if (provider === "LINKEDIN") request = { method: "get", url: `https://api.linkedin.com/rest/adTargetingEntities?q=typeahead&query=${encoded}&type=${targetingType}`, headers: { Authorization: `Bearer ${credentials.accessToken}`, "LinkedIn-Version": apiVersion, "X-Restli-Protocol-Version": "2.0.0" } };
    else if (provider === "X") request = { method: "get", url: `https://ads-api.x.com/${apiVersion}/accounts/${encodeURIComponent(accountExternalId)}/targeting_criteria`, params: { q: query, targeting_type: targetingType }, headers: { Authorization: `Bearer ${credentials.accessToken}` } };
    else if (provider === "GOOGLE_ADS") request = { method: "post", url: `https://googleads.googleapis.com/${apiVersion}/customers/${encodeURIComponent(accountExternalId)}/googleAds:search`, data: { query: `SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.name LIKE '${String(query).replace(/['\\]/g, "") }%' LIMIT 25` }, headers: { Authorization: `Bearer ${credentials.accessToken}`, "developer-token": credentials.developerToken, "login-customer-id": credentials.loginCustomerId } };
    else throw executionError("UNSUPPORTED_PROVIDER", { provider });
    const response = await providerRequest(request);
    const body = response?.data || {};
    const rows = body.data || body.elements || body.results || body.list || [];
    return rows.map((row) => normalizedResult(row.geoTargetConstant || row, query)).filter(Boolean);
  }
  async function scopedConnection(input) {
    const connection = input.connection || input.plan?.connection || input.recommendation?.connection || (connectionLoader && await connectionLoader(input.plan?.connectionId || input.recommendation?.connectionId));
    if (!connection) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, reasonCode: "PROVIDER_CONNECTION_REQUIRED" });
    return connection;
  }
  async function readResource(input = {}) {
    assertVersion(); const connection = await scopedConnection(input); const credentials = resolveStoredCredentials(connection);
    const account = input.plan?.accountExternalId || input.recommendation?.connection?.accountId || connection.accountId;
    const resourceId = input.providerIdentity?.nativeResourceId || input.operation?.nativeResourceId || input.operation?.item?.providerResourceId || input.recommendation?.targetCampaignExternalId;
    if (!resourceId && input.operation?.item?.operationType === "CREATE") return { exists: false };
    if (!resourceId) return { accountExternalId: account, status: connection.status, currency: connection.currency };
    let request;
    if (provider === "META") request = { method: "get", url: `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(resourceId)}`, params: { fields: "id,name,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time", access_token: credentials.accessToken } };
    else if (provider === "TIKTOK") request = { method: "get", url: `https://business-api.tiktok.com/open_api/${apiVersion}/campaign/get/`, params: { advertiser_id: account, campaign_ids: JSON.stringify([resourceId]) }, headers: { "Access-Token": credentials.accessToken } };
    else if (provider === "LINKEDIN") request = { method: "get", url: `https://api.linkedin.com/rest/adCampaigns/${encodeURIComponent(resourceId)}`, headers: { Authorization: `Bearer ${credentials.accessToken}`, "LinkedIn-Version": apiVersion, "X-Restli-Protocol-Version": "2.0.0" } };
    else if (provider === "X") request = { method: "get", url: `https://ads-api.x.com/${apiVersion}/accounts/${encodeURIComponent(account)}/campaigns/${encodeURIComponent(resourceId)}`, headers: { Authorization: `Bearer ${credentials.accessToken}` } };
    else request = { method: "post", url: `https://googleads.googleapis.com/${apiVersion}/customers/${encodeURIComponent(account)}/googleAds:search`, data: { query: `SELECT campaign.resource_name, campaign.name, campaign.status, campaign.start_date, campaign.end_date FROM campaign WHERE campaign.resource_name = '${String(resourceId).replace(/['\\]/g, "")}' LIMIT 1` }, headers: { Authorization: `Bearer ${credentials.accessToken}`, "developer-token": credentials.developerToken, "login-customer-id": credentials.loginCustomerId } };
    const response = await providerRequest(request, input.operation?.id);
    const body = response?.data?.data?.list?.[0] || response?.data?.data?.[0] || response?.data?.results?.[0]?.campaign || response?.data?.data || response?.data;
    return safeProviderState(body);
  }
  return Object.freeze({ provider, apiVersion, networkPolicyApplied: true, discover: requestDiscovery,
    async readCreativeReview({ publication }) {
      if (!publication.providerCreativeId && !publication.providerAdId) return { status: "UNKNOWN", code: "PROVIDER_RESOURCE_ID_MISSING", providerVersion: apiVersion };
      const state = await readResource({ plan: { connectionId: publication.connectionId, accountExternalId: publication.accountExternalId }, providerIdentity: { nativeResourceId: publication.providerAdId || publication.providerCreativeId } });
      const native = String(state.review_status || state.approval_status || state.effective_status || state.status || "UNKNOWN").toUpperCase();
      const mapped = /APPROVED|ACTIVE|ELIGIBLE/.test(native) ? "APPROVED" : /REJECT|DISAPPROVED/.test(native) ? "REJECTED" : /LIMIT/.test(native) ? "LIMITED" : /PENDING|IN_REVIEW/.test(native) ? "PENDING_REVIEW" : "UNKNOWN";
      return { status: mapped, code: native.slice(0, 100), message: Array.isArray(state.disapproval_reasons) ? state.disapproval_reasons.join(", ").slice(0, 1000) : null, providerVersion: apiVersion, providerCreativeId: publication.providerCreativeId, providerAdId: publication.providerAdId };
    },
    readResource,
  });
}

function createProviderReadRegistry({ env = process.env, clients = {}, connectionLoader } = {}) {
  const adapters = new Map();
  const envNames = { GOOGLE_ADS: "GOOGLE_ADS", META: "META", TIKTOK: "TIKTOK", LINKEDIN: "LINKEDIN", X: "X" };
  for (const provider of Object.keys(envNames)) {
    const apiVersion = env[`MARKETING_AD_EXECUTION_${envNames[provider]}_API_VERSION`];
    adapters.set(provider, clients[provider] || createProviderReadAdapter({ provider, apiVersion, httpClient: clients.httpClient, connectionLoader }));
  }
  return Object.freeze({ resolve(provider) { const adapter = adapters.get(String(provider).toUpperCase()); if (!adapter) throw executionError("UNSUPPORTED_PROVIDER", { provider }); return adapter; } });
}

module.exports = { normalizedResult, safeProviderState, createProviderReadAdapter, createProviderReadRegistry };
