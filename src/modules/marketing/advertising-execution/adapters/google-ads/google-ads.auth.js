const { executionError } = require("../../execution.errors");

function normalizeGoogleCustomerId(value, field = "customerId") {
  const normalized = String(value || "").replace(/-/g, "").trim();
  if (!/^\d{10}$/.test(normalized)) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_GOOGLE_ADS_CUSTOMER_ID" });
  return normalized;
}

function createLazyGoogleAdsClientFactory({ credentialResolver, transportFactory, timeoutMs = 30000 } = {}) {
  if (typeof credentialResolver !== "function" || typeof transportFactory !== "function") throw new TypeError("Google Ads credential and transport factories are required");
  return async function forExecution({ connection, customerId, loginCustomerId, apiVersion }) {
    const accountExternalId = normalizeGoogleCustomerId(customerId);
    const managerCustomerId = loginCustomerId ? normalizeGoogleCustomerId(loginCustomerId, "loginCustomerId") : null;
    const credentials = await credentialResolver(connection);
    if (!credentials?.refreshToken || !credentials?.developerToken || !credentials?.clientId || !credentials?.clientSecret) throw executionError("EXECUTION_PROVIDER_PERMISSION_ERROR", { provider: "GOOGLE_ADS", reasonCode: "GOOGLE_ADS_CREDENTIALS_INCOMPLETE" });
    return transportFactory({ apiVersion, timeoutMs, customerId: accountExternalId, loginCustomerId: managerCustomerId, credentials });
  };
}

module.exports = { normalizeGoogleCustomerId, createLazyGoogleAdsClientFactory };
