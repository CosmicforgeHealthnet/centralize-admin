const { executionError } = require("../execution.errors");

const PROVIDER_ORDER = Object.freeze({
  GOOGLE_ADS: ["BUDGET", "CAMPAIGN", "CAMPAIGN_CRITERION", "GROUP", "GROUP_CRITERION", "ASSET", "AD", "ASSET_LINK", "STATUS"],
  META: ["CAMPAIGN", "GROUP", "CREATIVE", "AD", "STATUS"],
  TIKTOK: ["CAMPAIGN", "GROUP", "CREATIVE", "AD", "STATUS"],
  LINKEDIN: ["CAMPAIGN_GROUP", "CAMPAIGN", "CREATIVE", "STATUS"],
  X: ["FUNDING_INSTRUMENT", "CAMPAIGN", "GROUP", "TARGETING", "ASSET_LINK", "STATUS"],
});

function validateHierarchy(items, { provider, connectionId, accountExternalId } = {}) {
  const byRef = new Map();
  for (const item of items || []) {
    if (!item.clientReference || byRef.has(item.clientReference)) throw executionError("INVALID_EXECUTION_PLAN", { field: "clientReference", reasonCode: "DUPLICATE_OR_MISSING_REFERENCE" });
    if (item.provider && item.provider !== provider) throw executionError("INVALID_EXECUTION_PLAN", { field: "provider", reasonCode: "CROSS_PROVIDER_PARENT" });
    if (item.connectionId && item.connectionId !== connectionId) throw executionError("INVALID_EXECUTION_PLAN", { field: "connectionId", reasonCode: "CROSS_CONNECTION_PARENT" });
    if (item.accountExternalId && item.accountExternalId !== accountExternalId) throw executionError("INVALID_EXECUTION_PLAN", { field: "accountExternalId", reasonCode: "CROSS_ACCOUNT_PARENT" });
    byRef.set(item.clientReference, item);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(reference) {
    if (visiting.has(reference)) throw executionError("INVALID_EXECUTION_PLAN", { field: "dependsOn", reasonCode: "DEPENDENCY_CYCLE" });
    if (visited.has(reference)) return;
    const item = byRef.get(reference);
    if (!item) throw executionError("INVALID_EXECUTION_PLAN", { field: "dependsOn", reasonCode: "UNRESOLVED_CLIENT_REFERENCE", reference });
    visiting.add(reference);
    for (const dependency of item.dependsOn || []) visit(dependency);
    visiting.delete(reference);
    visited.add(reference);
  }
  for (const reference of byRef.keys()) visit(reference);
  const order = PROVIDER_ORDER[provider] || [];
  function rank(item) {
    if (["PAUSE", "RESUME"].includes(item.operationType)) return 100;
    if (provider === "GOOGLE_ADS" && item.resourceType === "TARGETING") {
      const scope = String(item.intent?.scope || "CAMPAIGN").toUpperCase();
      const kind = String(item.intent?.criterionKind || "LOCATION").toUpperCase();
      if (scope === "CAMPAIGN") return { LANGUAGE: 2, LOCATION: 3, NEGATIVE: 4 }[kind] ?? 4;
      return 6;
    }
    if (provider === "GOOGLE_ADS") return { BUDGET: 0, CAMPAIGN: 1, GROUP: 5, CREATIVE: 7, AD: 8, ASSET_LINK: 9 }[item.resourceType] ?? 50;
    const found = order.indexOf(item.resourceType);
    return found < 0 ? 50 : found;
  }
  return [...items].sort((left, right) => {
    const resource = rank(left) - rank(right);
    return resource || Number(left.sequence || 0) - Number(right.sequence || 0) || left.clientReference.localeCompare(right.clientReference);
  });
}

module.exports = { PROVIDER_ORDER, validateHierarchy };
