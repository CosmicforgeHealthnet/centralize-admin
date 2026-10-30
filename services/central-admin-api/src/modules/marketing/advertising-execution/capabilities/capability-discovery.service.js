const { z } = require("zod");
const { prisma } = require("../../../../shared/config/database");
const { PROVIDERS } = require("../execution.constants");
const { executionError } = require("../execution.errors");
const { readExecutionConfig } = require("../execution.config");
const { createExecutionAdapterRegistry } = require("../adapters/execution-adapter.registry");

const capabilityQuerySchema = z.object({
  provider: z.preprocess((value) => String(value || "").trim().toUpperCase(), z.enum(PROVIDERS)),
  connectionId: z.string().uuid(),
  accountExternalId: z.string().trim().min(1).max(255),
  objective: z.string().trim().min(1).max(100).optional(),
  campaignType: z.string().trim().min(1).max(100).optional(),
  operationType: z.enum(["CREATE", "UPDATE", "PAUSE", "RESUME", "ARCHIVE", "REMOVE_LINK"]).optional(),
  resourceType: z.enum(["BUDGET", "CAMPAIGN", "GROUP", "TARGETING", "CREATIVE", "AD", "ASSET_LINK"]).optional(),
  creativeFormat: z.string().trim().min(1).max(100).optional(),
}).strict();

function validateCapabilityQuery(value) {
  const parsed = capabilityQuerySchema.safeParse(value);
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "capabilityQuery", reasonCode: "INVALID_CAPABILITY_QUERY", issues: parsed.error.issues });
  return parsed.data;
}

function createCapabilityDiscoveryService({ client = prisma, env = process.env, registry } = {}) {
  const adapters = registry || createExecutionAdapterRegistry({ env });

  async function resolve(query) {
    const input = validateCapabilityQuery(query);
    const connection = await client.marketing_ad_platform_connections.findFirst({
      where: { id: input.connectionId, platform: input.provider },
      select: {
        id: true,
        platform: true,
        accountId: true,
        currency: true,
        status: true,
        requiresReauthorization: true,
        validationStatus: true,
        connectionMetadata: true,
      },
    });
    const config = readExecutionConfig(env);
    let unavailableReason = "ADAPTER_NOT_IMPLEMENTED";
    if (!connection) unavailableReason = "CONNECTION_NOT_FOUND";
    else if (connection.accountId !== input.accountExternalId) unavailableReason = "ACCOUNT_CONTEXT_MISMATCH";
    else if (connection.status !== "ACTIVE" || connection.requiresReauthorization) unavailableReason = "CONNECTION_PERMISSION_UNAVAILABLE";
    else if (!config.enabled) unavailableReason = "GLOBAL_EXECUTION_DISABLED";
    else if (!config.providers[input.provider]) unavailableReason = "PROVIDER_EXECUTION_DISABLED";
    else if (!config.connectionWriteEnabled) unavailableReason = "CONNECTION_WRITE_DISABLED";

    const permissionState = !connection ? "UNKNOWN"
      : connection.accountId !== input.accountExternalId || connection.status !== "ACTIVE" || connection.requiresReauthorization ? "MISSING"
        : "AVAILABLE";

    return adapters.get(input.provider).getCapabilities({
      connection,
      accountExternalId: input.accountExternalId,
      objective: input.objective,
      accountState: connection ? {
        status: connection.status,
        validationStatus: connection.validationStatus,
        accountRole: connection.connectionMetadata?.accountRole,
        oauthScopes: Array.isArray(connection.connectionMetadata?.oauthScopes) ? connection.connectionMetadata.oauthScopes : [],
        accessTier: connection.connectionMetadata?.accessTier,
        editReady: connection.connectionMetadata?.editReady === true,
        pageIdentityReady: connection.connectionMetadata?.pageIdentityReady === true,
        instagramIdentityReady: connection.connectionMetadata?.instagramIdentityReady === true,
        sparkAuthorized: connection.connectionMetadata?.sparkAuthorized === true,
        placementAllowlisted: connection.connectionMetadata?.placementAllowlisted === true,
        fundingInstrumentReady: connection.connectionMetadata?.fundingInstrumentReady === true,
        providerLimits: connection.connectionMetadata?.providerLimits && typeof connection.connectionMetadata.providerLimits === "object" ? connection.connectionMetadata.providerLimits : {},
        placementAllowlist: Array.isArray(connection.connectionMetadata?.placementAllowlist) ? connection.connectionMetadata.placementAllowlist : [],
      } : null,
      unavailableReason,
      permissionState,
      campaignType: input.campaignType,
      operationType: input.operationType,
      resourceType: input.resourceType,
      creativeFormat: input.creativeFormat,
    });
  }

  return { resolve };
}

module.exports = { capabilityQuerySchema, validateCapabilityQuery, createCapabilityDiscoveryService };
