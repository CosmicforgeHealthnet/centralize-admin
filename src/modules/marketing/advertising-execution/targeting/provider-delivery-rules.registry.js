const { PROVIDER_DEFINITIONS } = require("../adapters/provider-definitions");
const { executionError } = require("../execution.errors");

function buildObjectiveRule(definition, objective) {
  const compatibility = definition.biddingCompatibility?.[objective];
  const formats = definition.details?.creativeFormats || definition.details?.supportedFormats || ["RESPONSIVE_SEARCH_AD", "IMAGE", "VIDEO"];
  return Object.freeze({
    formats, placements: definition.placements,
    bidding: Object.freeze({
      strategies: compatibility ? ["LOWEST_COST", "COST_CAP", "TARGET"] : ["MANUAL_CPC", "MAXIMIZE_CONVERSIONS", "TARGET_CPA"],
      optimizationGoals: compatibility?.optimizationGoals || ["CLICKS", "CONVERSIONS"],
      billingEvents: compatibility?.billingEvents || ["CLICKS", "IMPRESSIONS"],
      targetValueRequired: false, conversionActionRequired: ["CONVERSIONS", "OFFSITE_CONVERSIONS", "VALUE"].some((goal) => compatibility?.optimizationGoals?.includes(goal)),
    }),
    budgetLevels: definition.details?.budgetLevels || ["CAMPAIGN"],
  });
}

function providerDeliveryRules({ provider, apiVersion }) {
  if (!String(apiVersion || "").trim()) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, reasonCode: "PROVIDER_API_VERSION_REQUIRED" });
  const definition = PROVIDER_DEFINITIONS[provider];
  if (!definition || !definition.versionPattern.test(apiVersion)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, apiVersion, reasonCode: "DELIVERY_RULE_VERSION_UNSUPPORTED" });
  return Object.freeze({ provider, apiVersion, objectives: Object.freeze(Object.fromEntries(definition.objectives.map((objective) => [objective, buildObjectiveRule(definition, objective)]))) });
}
module.exports = { providerDeliveryRules };
