const { prisma } = require("../../../../shared/config/database");
const { hashExecutionJson, sanitizeExecutionJson } = require("../execution-json.validator");

class TargetingDiscoveryRepository {
  constructor({ client = prisma, now = () => new Date() } = {}) { this.client = client; this.now = now; }
  async findCurrent(scope) { return this.client.marketingTargetingDiscovery.findUnique({ where: { platform_apiVersion_connectionId_accountExternalId_targetingType_normalizedIdentifier: scope } }); }
  async findFresh(scope) {
    return this.findCurrent(scope).then((row) => row && row.availability === "AVAILABLE" && row.expiresAt > this.now() ? row : null);
  }
  async upsert(input) {
    const resolvedAt = this.now();
    const expiresAt = new Date(resolvedAt.getTime() + Math.min(Math.max(input.ttlMs || 3600000, 60000), 86400000));
    const normalizedIdentifier = String(input.normalizedIdentifier).normalize("NFC").trim().toLowerCase();
    const metadata = sanitizeExecutionJson(input.metadata || {}, "summary");
    const contentHash = hashExecutionJson({ nativeIdentifier: input.nativeIdentifier, displayName: input.displayName, parentIdentifier: input.parentIdentifier || null, metadata }, "summary").hash;
    const where = { platform_apiVersion_connectionId_accountExternalId_targetingType_normalizedIdentifier: { platform: input.platform, apiVersion: input.apiVersion, connectionId: input.connectionId, accountExternalId: input.accountExternalId, targetingType: input.targetingType, normalizedIdentifier } };
    const data = { nativeIdentifier: String(input.nativeIdentifier), displayName: String(input.displayName).slice(0, 512), parentIdentifier: input.parentIdentifier || null, metadata, availability: input.availability || "AVAILABLE", contentHash, resolvedAt, expiresAt, lastValidatedAt: resolvedAt };
    return this.client.marketingTargetingDiscovery.upsert({ where, create: { ...where.platform_apiVersion_connectionId_accountExternalId_targetingType_normalizedIdentifier, ...data }, update: data });
  }
}
module.exports = { TargetingDiscoveryRepository };
