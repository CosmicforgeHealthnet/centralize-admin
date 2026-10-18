const { executionError } = require("../execution.errors");

const IMMUTABLE_FIELDS = Object.freeze({
  GOOGLE_ADS: ["platform", "accountExternalId", "currencyCode", "campaignType", "channelType", "channelSubtype"],
  META: ["platform", "accountExternalId", "currencyCode", "campaignType", "buyingType", "objective"],
  TIKTOK: ["platform", "accountExternalId", "currencyCode", "campaignType", "objective"],
  LINKEDIN: ["platform", "accountExternalId", "currencyCode", "campaignType", "objective", "creativeFormat"],
  X: ["platform", "accountExternalId", "currencyCode", "campaignType", "fundingInstrumentId"],
});

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function assertImmutableFields({ provider, current, requested }) {
  for (const fieldPath of IMMUTABLE_FIELDS[provider] || []) {
    const before = readPath(current, fieldPath);
    const after = readPath(requested, fieldPath);
    if (after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
      throw executionError("IMMUTABLE_FIELD_CHANGE", {
        provider, fieldPath, currentValue: before ?? null, requestedValue: after ?? null,
        requiredAction: "CREATE_REPLACEMENT_PLAN_AND_EXPLICITLY_RETIRE_OLD_RESOURCE",
      });
    }
  }
  return true;
}

module.exports = { IMMUTABLE_FIELDS, assertImmutableFields };
