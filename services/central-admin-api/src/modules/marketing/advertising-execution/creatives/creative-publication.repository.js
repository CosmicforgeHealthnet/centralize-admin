const { Prisma } = require("../../../../generated/admin-client");
const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { safeIdentifier } = require("../operations/operation.repository");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { assertValidatedPublicationDto } = require("./validated-publication.dto");

const PROVIDER_REVIEW_STATES = new Set(["PENDING_REVIEW", "APPROVED", "REJECTED", "LIMITED", "UNKNOWN"]);

class CreativePublicationRepository {
  constructor({ client = prisma, now = () => new Date(), concurrencyRetries = 3 } = {}) { this.client = client; this.now = now; this.concurrencyRetries = concurrencyRetries; }

  async createRevision(validatedDto) {
    const dto = assertValidatedPublicationDto(validatedDto);
    const scopeKey = [dto.creativeAssetId, dto.platform, dto.connectionId, dto.accountExternalId].join(":");
    for (let attempt = 1; attempt <= this.concurrencyRetries; attempt += 1) {
      try {
        return await this.client.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`);
          const source = await tx.marketing_creative_assets.findFirst({ where: { id: dto.creativeAssetId, platform: dto.platform, connectionId: dto.connectionId, accountExternalId: dto.accountExternalId }, select: { id: true } });
          if (!source) throw executionError("INVALID_EXECUTION_PLAN", { field: "creativeAssetId", reasonCode: "SOURCE_CREATIVE_NOT_FOUND_OR_SCOPE_MISMATCH" });
          const reusable = await tx.marketingCreativePublication.findFirst({
            where: { creativeAssetId: dto.creativeAssetId, platform: dto.platform, connectionId: dto.connectionId, accountExternalId: dto.accountExternalId, contentHash: dto.contentHash, reuseClassification: { in: ["ACCOUNT_REUSABLE", "IDENTITY_SCOPED", "CAMPAIGN_SCOPED", "GROUP_SCOPED"] }, reviewStatus: { notIn: ["REJECTED", "FAILED"] } },
            orderBy: { revision: "desc" },
          });
          if (reusable) return { ...reusable, reusedRevision: true };
          const latest = await tx.marketingCreativePublication.findFirst({ where: { creativeAssetId: dto.creativeAssetId, platform: dto.platform, connectionId: dto.connectionId }, orderBy: { revision: "desc" }, select: { revision: true } });
          const publication = await tx.marketingCreativePublication.create({ data: {
            creativeAssetId: dto.creativeAssetId, revision: (latest?.revision || 0) + 1, platform: dto.platform,
            connectionId: dto.connectionId, accountExternalId: dto.accountExternalId, apiVersion: dto.apiVersion,
            creativeFormat: dto.creativeFormat, identityReference: dto.identityReference, instagramIdentityReference: dto.instagramIdentityReference,
            campaignExternalId: dto.campaignExternalId, groupExternalId: dto.groupExternalId, reviewStatus: "DRAFT",
            contentHash: dto.contentHash, contentProjection: dto.contentProjection, reuseClassification: dto.reuseClassification,
            sourceMediaChecksum: dto.sourceMediaChecksum, malwareStatus: dto.malwareStatus,
            publicationMetadata: dto.publicationMetadata, createdByAdminUserId: dto.createdByAdminUserId,
          } });
          await tx.marketingCreativeMediaValidationEvidence.create({ data: {
            creativeAssetId: dto.creativeAssetId, publicationId: publication.id, checksumSha256: dto.mediaEvidence.checksum,
            detectedMime: dto.mediaEvidence.mimeType, byteSize: dto.mediaEvidence.byteLength, width: dto.mediaEvidence.width,
            height: dto.mediaEvidence.height, durationMs: dto.mediaEvidence.durationMs, frameCount: dto.mediaEvidence.frameCount,
            codec: dto.mediaEvidence.codec, container: dto.mediaEvidence.container, hasAudio: dto.mediaEvidence.hasAudio,
            hasTransparency: dto.mediaEvidence.hasTransparency, malwareStatus: dto.malwareStatus,
            scannerEvidence: sanitizeExecutionJson(dto.mediaEvidence.scannerEvidence, "summary"), validatedAt: this.now(),
          } });
          return { ...publication, reusedRevision: false };
        });
      } catch (error) {
        if (error?.code !== "P2002" || attempt === this.concurrencyRetries) throw error;
      }
    }
    throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "CREATIVE_REVISION_ALLOCATION_EXHAUSTED" });
  }

  async findById(id) { return this.client.marketingCreativePublication.findUnique({ where: { id }, include: { mediaEvidence: true, reviewEvents: { orderBy: { checkedAt: "desc" }, take: 20 } } }); }

  async list({ where = {}, skip = 0, take = 25, sortDirection = "desc" } = {}) {
    const direction = sortDirection === "asc" ? "asc" : "desc";
    const [rows, total] = await Promise.all([
      this.client.marketingCreativePublication.findMany({ where, skip, take, orderBy: [{ createdAt: direction }, { id: direction }], include: { reviewEvents: { orderBy: { checkedAt: "desc" }, take: 5 } } }),
      this.client.marketingCreativePublication.count({ where }),
    ]);
    return { rows, total };
  }

  async recordReviewState({ id, reviewStatus, providerCode, providerMessage, providerVersion, checkedAt = this.now(), providerMediaId, providerCreativeId, providerAdId }) {
    if (!PROVIDER_REVIEW_STATES.has(reviewStatus)) throw executionError("INVALID_OPERATION_TRANSITION", { entity: "CREATIVE_PUBLICATION", reviewStatus });
    return this.client.$transaction(async (tx) => {
      const current = await tx.marketingCreativePublication.findUnique({ where: { id } });
      if (!current) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "CREATIVE_PUBLICATION_NOT_FOUND" });
      if (current.reviewStatus === "REJECTED") throw executionError("INVALID_OPERATION_TRANSITION", { entity: "CREATIVE_PUBLICATION", reasonCode: "REJECTED_CREATIVE_REQUIRES_NEW_REVISION" });
      const code = safeIdentifier(providerCode, 100);
      const message = providerMessage == null ? null : String(providerMessage).replace(/[\r\n\t]+/g, " ").slice(0, 1000);
      const publication = await tx.marketingCreativePublication.update({ where: { id }, data: {
        reviewStatus, reviewCode: code, reviewMessage: message, reviewCheckedAt: checkedAt,
        reviewProviderVersion: String(providerVersion).slice(0, 64), providerMediaId: safeIdentifier(providerMediaId),
        providerCreativeId: safeIdentifier(providerCreativeId), providerAdId: safeIdentifier(providerAdId),
      } });
      if (current.reviewStatus !== reviewStatus) await tx.marketingCreativePublicationReviewEvent.create({ data: {
        publicationId: id, previousStatus: current.reviewStatus, status: reviewStatus, providerCode: code,
        providerMessage: message, providerVersion: String(providerVersion).slice(0, 64), checkedAt,
      } });
      return publication;
    });
  }
}

module.exports = { PROVIDER_REVIEW_STATES, CreativePublicationRepository };
