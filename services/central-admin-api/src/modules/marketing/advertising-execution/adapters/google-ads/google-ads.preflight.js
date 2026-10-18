const { sanitizeExecutionJson, hashExecutionJson } = require("../../execution-json.validator");

const GAQL_PREFLIGHT_FIELDS = Object.freeze([
  "customer.id", "customer.currency_code", "customer.time_zone", "campaign.id", "campaign.name", "campaign.status",
  "campaign.advertising_channel_type", "campaign.advertising_channel_sub_type", "campaign.campaign_budget",
  "campaign.start_date", "campaign.end_date", "campaign_budget.id", "campaign_budget.amount_micros", "campaign_budget.explicitly_shared",
]);

function buildGaqlPreflightQuery(resourceName) {
  const id = String(resourceName || "").split("/").pop();
  if (!/^\d+$/.test(id)) throw new TypeError("A numeric Google Ads resource identifier is required");
  return `SELECT ${GAQL_PREFLIGHT_FIELDS.join(", ")} FROM campaign WHERE campaign.id = ${id} LIMIT 1`;
}

function normalizeGaqlPreflightRow(row = {}, capturedAt = new Date()) {
  const campaign = row.campaign || {};
  const budget = row.campaignBudget || row.campaign_budget || {};
  const customer = row.customer || {};
  const snapshot = sanitizeExecutionJson({
    accountExternalId: String(customer.id || ""), currency: customer.currencyCode || customer.currency_code || null,
    accountTimezone: customer.timeZone || customer.time_zone || null,
    campaign: { id: String(campaign.id || ""), name: campaign.name || null, status: campaign.status || null, channelType: campaign.advertisingChannelType || campaign.advertising_channel_type || null, channelSubtype: campaign.advertisingChannelSubtype || campaign.advertising_channel_sub_type || null, budgetResourceName: campaign.campaignBudget || campaign.campaign_budget || null, startDate: campaign.startDate || campaign.start_date || null, endDate: campaign.endDate || campaign.end_date || null },
    budget: { id: String(budget.id || ""), amountMicros: String(budget.amountMicros || budget.amount_micros || "0"), explicitlyShared: Boolean(budget.explicitlyShared ?? budget.explicitly_shared) },
    capturedAt: capturedAt.toISOString(),
  }, "beforeState");
  return { ...snapshot, hash: hashExecutionJson(snapshot, "beforeState").hash };
}

async function runGaqlPreflight({ client, resourceName, capturedAt }) {
  const rows = await client.search({ query: buildGaqlPreflightQuery(resourceName) });
  return normalizeGaqlPreflightRow(rows?.[0] || {}, capturedAt);
}

module.exports = { GAQL_PREFLIGHT_FIELDS, buildGaqlPreflightQuery, normalizeGaqlPreflightRow, runGaqlPreflight };
