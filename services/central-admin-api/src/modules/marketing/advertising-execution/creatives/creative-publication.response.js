function mapCreativePublication(publication) {
  if (!publication) return null;
  return Object.freeze({
    id: publication.id, creativeAssetId: publication.creativeAssetId, revision: publication.revision,
    platform: publication.platform, connectionId: publication.connectionId, accountExternalId: publication.accountExternalId,
    apiVersion: publication.apiVersion, creativeFormat: publication.creativeFormat,
    reviewStatus: publication.reviewStatus, reviewCode: publication.reviewCode || null,
    reviewMessage: publication.reviewMessage || null, reviewCheckedAt: publication.reviewCheckedAt || null,
    contentHash: publication.contentHash, reuseClassification: publication.reuseClassification,
    accessibility: publication.contentProjection?.accessibility || null,
    createdAt: publication.createdAt, updatedAt: publication.updatedAt,
    reusedRevision: publication.reusedRevision === true,
  });
}
module.exports = { mapCreativePublication };
