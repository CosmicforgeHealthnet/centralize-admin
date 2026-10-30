const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { providerCreativeRules, supportedCreativeFormats } = require("./provider-creative-rules.registry");
const { validateCreativePublication } = require("./creative-publication.validator");
const { assertDestinationNetworkSafe } = require("./destination-url.policy");
const { validateMedia } = require("./media.validator");
const { hashCreative } = require("./creative-hash.service");
const { createValidatedPublicationDto } = require("./validated-publication.dto");
const { CreativePublicationRepository } = require("./creative-publication.repository");
const { mapCreativePublication } = require("./creative-publication.response");

function deriveReuseClassification({ provider, identityReference, campaignExternalId, groupExternalId, reviewStatus, mediaExpired = false, identityChanged = false }) {
  if (reviewStatus === "REJECTED" || reviewStatus === "LIMITED" || reviewStatus === "UNKNOWN") return "BLOCKED_REVIEW";
  if (mediaExpired) return "BLOCKED_EXPIRED";
  if (identityChanged) return "BLOCKED_IDENTITY_CHANGED";
  if (provider === "GOOGLE_ADS") return "ACCOUNT_REUSABLE";
  if (["META", "TIKTOK"].includes(provider) && identityReference) return "IDENTITY_SCOPED";
  if (groupExternalId) return "GROUP_SCOPED";
  if (campaignExternalId) return "CAMPAIGN_SCOPED";
  return "MUST_RECREATE";
}

function assertCreativeActor(actor) {
  if (!actor?.id || actor.status && actor.status !== "ACTIVE") throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "AUTHENTICATED_ACTIVE_ACTOR_REQUIRED" });
  return actor;
}

function createCreativePublicationService({
  client = prisma, repository = new CreativePublicationRepository({ client }), malwareScanner = null,
  destinationDnsResolver, authorize = null, audit, events, metrics, scanFailurePolicy = "BLOCK",
} = {}) {
  async function authorizeCreative({ actor, permission, ...context }) {
    if (authorize) return authorize({ actor, permission, scope: "CREATIVE", ...context });
    if (actor?.tier === "SUPER") return true;
    const grants = await client.adminSectionGrant.findMany({
      where: {
        adminUserId: actor.id,
        module: "marketing",
        section: { in: ["advertising-execution", "*"] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { mode: true },
    });
    return grants.some((grant) => grant.mode === "EDIT" || permission === "VIEW" && grant.mode === "VIEW");
  }

  async function createRevision({ actor, input, media }) {
    assertCreativeActor(actor);
    if (!await authorizeCreative({ actor, permission: "EDIT", creativeAssetId: input?.creativeAssetId })) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CREATIVE_EDIT_PERMISSION_REQUIRED" });
    const [asset, connection] = await Promise.all([
      client.marketing_creative_assets.findUnique({ where: { id: input.creativeAssetId } }),
      client.marketing_ad_platform_connections.findUnique({ where: { id: input.connectionId } }),
    ]);
    if (!asset || asset.connectionId !== input.connectionId || asset.platform !== input.platform) throw executionError("INVALID_EXECUTION_PLAN", { field: "creativeAssetId", reasonCode: "SOURCE_CREATIVE_NOT_FOUND_OR_SCOPE_MISMATCH" });
    if (!connection || connection.status !== "ACTIVE" || connection.accountId !== input.accountExternalId || connection.platform !== input.platform) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "ACTIVE_PROVIDER_ACCOUNT_REQUIRED" });
    if (asset.accountExternalId !== input.accountExternalId) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CREATIVE_ACCOUNT_SCOPE_MISMATCH" });
    const rules = providerCreativeRules({ provider: input.platform, apiVersion: input.apiVersion, format: input.providerFormat });
    const normalized = validateCreativePublication(input, {
      providerFormats: supportedCreativeFormats(input.platform), formatLimits: rules,
      destinationPolicy: { allowedDomains: connection.connectionMetadata?.advertisingDestinationDomains || [], allowSubdomains: true, requireUtm: true, allowedCustomParameters: connection.connectionMetadata?.advertisingTrackingParameters || [] },
    });
    await assertDestinationNetworkSafe(normalized.destinationUrl, { resolver: destinationDnsResolver });
    let mediaEvidence;
    try {
      mediaEvidence = await validateMedia({ bytes: media?.buffer || media?.bytes, mimeType: media?.mimetype || media?.mimeType }, {
        limits: rules, malwareScanner, scanFailurePolicy,
        checksumLookup: async (checksum) => client.marketingCreativePublication.findFirst({ where: { sourceMediaChecksum: checksum, platform: input.platform, connectionId: input.connectionId, accountExternalId: input.accountExternalId }, select: { id: true } }),
      });
    } catch (error) {
      metrics?.increment("mediaValidationFailures");
      if (String(error?.errors?.[0]?.reasonCode || "").startsWith("MEDIA_MALWARE_")) metrics?.increment("malwareOutcomes");
      throw error;
    }
    metrics?.increment("malwareOutcomes");
    const material = { ...normalized, media: mediaEvidence };
    const { projection, contentHash } = hashCreative(material);
    const reuseClassification = deriveReuseClassification({ provider: input.platform, identityReference: input.identityReference, campaignExternalId: input.campaignExternalId, groupExternalId: input.groupExternalId });
    const publicationMetadata = sanitizeExecutionJson({ sourceMediaIds: normalized.sourceMediaIds, accessibilitySource: { kind: "HUMAN", actorId: actor.id }, warnings: [], materialTrackingKeys: normalized.materialTrackingKeys }, "publicationMetadata");
    const created = await repository.createRevision(createValidatedPublicationDto({
      creativeAssetId: asset.id, platform: normalized.platform, connectionId: normalized.connectionId,
      accountExternalId: normalized.accountExternalId, apiVersion: normalized.apiVersion, creativeFormat: normalized.providerFormat,
      identityReference: normalized.pageReference || normalized.identityReference,
      instagramIdentityReference: normalized.instagramIdentityReference, campaignExternalId: normalized.campaignExternalId,
      groupExternalId: normalized.groupExternalId, contentHash, contentProjection: projection,
      reuseClassification, sourceMediaChecksum: mediaEvidence.checksum, malwareStatus: mediaEvidence.malwareScanStatus,
      publicationMetadata, mediaEvidence, createdByAdminUserId: actor.id,
    }));
    if (audit) await audit.event({ actorId: actor.id, action: created.reusedRevision ? "MARKETING_CREATIVE_REVISION_REUSED" : "MARKETING_CREATIVE_REVISION_CREATED", targetId: created.id, targetType: "marketing_creative_publication", metadata: { revision: created.revision, platform: created.platform, connectionId: created.connectionId, contentHash: created.contentHash, malwareStatus: created.malwareStatus } });
    if (events) await events.emit("CREATIVE_REVISION_CREATED", { id: created.id, platform: created.platform, reviewStatus: created.reviewStatus });
    return mapCreativePublication(created);
  }

  async function getById({ actor, id }) {
    assertCreativeActor(actor);
    if (!await authorizeCreative({ actor, permission: "VIEW" })) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CREATIVE_VIEW_PERMISSION_REQUIRED" });
    const publication = await repository.findById(id);
    if (!publication) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "CREATIVE_PUBLICATION_NOT_FOUND" });
    return mapCreativePublication(publication);
  }

  async function list({ actor, creativeAssetId, where, skip, take, sortDirection }) {
    assertCreativeActor(actor);
    if (!await authorizeCreative({ actor, permission: "VIEW", creativeAssetId })) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CREATIVE_VIEW_PERMISSION_REQUIRED" });
    const result = await repository.list({ where: { creativeAssetId, ...where }, skip, take, sortDirection });
    return { rows: result.rows.map(mapCreativePublication), total: result.total };
  }

  return Object.freeze({ createRevision, getById, list });
}

module.exports = { deriveReuseClassification, assertCreativeActor, createCreativePublicationService };
