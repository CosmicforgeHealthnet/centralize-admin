const { CONNECTORS } = require("../connectors");
const { capability, normalizeCreativeAsset, normalizeCreativeInsight } = require("./creative.connector.interface");

const DEFINITIONS = Object.freeze({
  META: {
    supportedCreativeGrain: "AD_WITH_CREATIVE_METADATA",
    providerApiVersion: () => process.env.META_GRAPH_API_VERSION || "v25.0",
    limitations: ["Action metrics are provider-defined and remain informational"],
  },
  TIKTOK: {
    supportedCreativeGrain: "AD_WITH_OPTIONAL_NATIVE_CREATIVE_ID",
    providerApiVersion: () => process.env.TIKTOK_API_VERSION || "v1.3",
    limitations: ["Smart+ hierarchy varies by account", "Ad ID is fingerprint input when creative ID is absent"],
  },
  X: {
    supportedCreativeGrain: "PROMOTED_ENTITY",
    providerApiVersion: () => process.env.X_ADS_API_VERSION || "12",
    limitations: ["Creative access requires X Ads API approval", "OAuth 1.0a is required"],
  },
  LINKEDIN: {
    supportedCreativeGrain: "CREATIVE_URN",
    providerApiVersion: () => process.env.LINKEDIN_API_VERSION || null,
    limitations: ["Creative Ad Analytics depends on account permissions"],
  },
  GOOGLE_ADS: {
    supportedCreativeGrain: "AD",
    providerApiVersion: () => process.env.GOOGLE_ADS_API_VERSION || null,
    limitations: ["Shared asset metrics are not duplicated across child assets", "Manager accounts may require login customer ID"],
  },
});

const METRICS = ["spend", "revenue", "impressions", "reach", "clicks", "providerConversions"];

function explicitCapability(platform, provider, connection) {
  const definition = DEFINITIONS[platform];
  const declared = provider?.creativeCapability || {};
  const supportsCreativeCatalog = typeof provider?.fetchCreativeCatalog === "function";
  const supportsCreativeInsights = typeof provider?.fetchCreativeInsights === "function";
  const permissionBlocked = platform === "X" && connection?.connectionMetadata?.creativeApiApproved === false;
  const available = !permissionBlocked && (supportsCreativeCatalog || supportsCreativeInsights);
  return capability(platform, {
    status: available ? "AVAILABLE" : permissionBlocked ? "APPROVAL_BLOCKED" : "UNAVAILABLE",
    supportsCreativeCatalog: !permissionBlocked && supportsCreativeCatalog,
    supportsCreativeInsights: !permissionBlocked && supportsCreativeInsights,
    supportedCreativeGrain: definition.supportedCreativeGrain,
    supportedMetrics: declared.supportedMetrics || METRICS,
    attributionMetadata: declared.attributionMetadata || "PROVIDER_DEFINED_INFORMATIONAL",
    providerApiVersion: declared.providerApiVersion || definition.providerApiVersion(),
    limitations: [...definition.limitations, ...(declared.limitations || [])],
  });
}

function createCreativeRegistry({ providers = CONNECTORS } = {}) {
  return Object.fromEntries(
    Object.keys(DEFINITIONS).map((platform) => {
      const provider = providers[platform] || {};
      return [platform, {
        platform,
        getCapability(connection) {
          return explicitCapability(platform, provider, connection);
        },
        async fetchCreativeCatalog(args) {
          const current = explicitCapability(platform, provider, args.connection);
          if (!current.supportsCreativeCatalog) {
            return { status: "UNSUPPORTED", items: [], nextCursor: null, providerRequestId: null, capability: current };
          }
          const page = await provider.fetchCreativeCatalog(args);
          return {
            items: (page.items || []).map((item) => normalizeCreativeAsset(item, {
              platform,
              connectionId: args.connection.id,
              accountExternalId: args.connection.accountId,
            })),
            nextCursor: page.nextCursor || null,
            providerRequestId: page.providerRequestId || null,
            capability: page.capability || current,
            rawResponse: page.rawResponse || page.items || [],
          };
        },
        async fetchCreativeInsights(args) {
          const current = explicitCapability(platform, provider, args.connection);
          if (!current.supportsCreativeInsights) {
            return { status: "UNSUPPORTED", rows: [], nextCursor: null, providerRequestId: null, capability: current };
          }
          const page = await provider.fetchCreativeInsights(args);
          return {
            rows: (page.rows || []).map((row) => normalizeCreativeInsight(row, {
              platform,
              connectionId: args.connection.id,
              accountExternalId: args.connection.accountId,
            })),
            nextCursor: page.nextCursor || null,
            providerRequestId: page.providerRequestId || null,
            capability: page.capability || current,
            rawResponse: page.rawResponse || page.rows || [],
          };
        },
      }];
    }),
  );
}

const CREATIVE_REGISTRY = createCreativeRegistry();

module.exports = { DEFINITIONS, createCreativeRegistry, CREATIVE_REGISTRY };
