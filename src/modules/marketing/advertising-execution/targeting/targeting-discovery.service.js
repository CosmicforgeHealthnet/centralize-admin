const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { TargetingDiscoveryRepository } = require("./targeting-discovery.repository");

function createTargetingDiscoveryService({ client = prisma, repository = new TargetingDiscoveryRepository({ client }), providerReadRegistry, events, ttlMs = 3600000 } = {}) {
  if (!providerReadRegistry) throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "TARGETING_READ_REGISTRY_REQUIRED" });
  async function resolve({ provider, apiVersion, connectionId, accountExternalId, criterion, forceRefresh = false }) {
    const normalizedIdentifier = String(criterion.query || criterion.value || criterion.placement || "").normalize("NFC").trim().toLowerCase();
    const scope = { platform: provider, apiVersion, connectionId, accountExternalId, targetingType: criterion.type, normalizedIdentifier };
    if (!forceRefresh) {
      const cached = await repository.findFresh(scope);
      if (cached) { if (events) await events.emit("TARGETING_RESOLVED", { provider, connectionId, accountExternalId, targetingType: criterion.type, cache: "HIT" }); return { normalizedId: cached.normalizedIdentifier, nativeId: cached.nativeIdentifier, displayName: cached.displayName, cache: "HIT", expiresAt: cached.expiresAt }; }
      const previous = repository.findCurrent ? await repository.findCurrent(scope) : null;
      if (previous && previous.expiresAt <= new Date()) if (events) await events.emit("TARGETING_EXPIRED", { provider, connectionId, accountExternalId, targetingType: criterion.type });
    }
    const connection = await client.marketing_ad_platform_connections.findFirst({ where: { id: connectionId, platform: provider, accountId: accountExternalId, status: "ACTIVE" } });
    if (!connection) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "ACTIVE_PROVIDER_ACCOUNT_REQUIRED" });
    let results;
    try { results = await providerReadRegistry.resolve(provider).discover({ connection, accountExternalId, targetingType: criterion.type, query: normalizedIdentifier }); }
    catch (error) { if (events) await events.emit("TARGETING_DISCOVERY_FAILED", { provider, connectionId, accountExternalId, targetingType: criterion.type, reason: error.code || "PROVIDER_READ_FAILED" }); throw error; }
    const exact = results.find((row) => row.normalizedIdentifier === normalizedIdentifier) || (results.length === 1 ? results[0] : null);
    if (!exact) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "TARGETING_VALUE_UNRESOLVED", targetingType: criterion.type });
    const row = await repository.upsert({ ...scope, ...exact, ttlMs, availability: "AVAILABLE" });
    if (events) await events.emit("TARGETING_RESOLVED", { provider, connectionId, accountExternalId, targetingType: criterion.type, cache: "MISS" });
    return { normalizedId: row.normalizedIdentifier, nativeId: row.nativeIdentifier, displayName: row.displayName, cache: "MISS", expiresAt: row.expiresAt };
  }
  return Object.freeze({ resolve });
}
module.exports = { createTargetingDiscoveryService };
