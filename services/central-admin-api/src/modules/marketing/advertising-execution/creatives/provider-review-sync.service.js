const { executionError } = require("../execution.errors");

const BLOCKING_REVIEW_STATES = new Set(["DRAFT", "PENDING_REVIEW", "REJECTED", "LIMITED", "UNKNOWN", "FAILED"]);

function assertCreativeApprovedForActivation(publication, { reviewRequired = true, limitedPolicy = "BLOCK" } = {}) {
  if (!publication) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "CREATIVE_PUBLICATION_NOT_FOUND" });
  if (!reviewRequired) return publication;
  if (publication.reviewStatus === "LIMITED" && limitedPolicy !== "BLOCK") return publication;
  if (publication.reviewStatus !== "APPROVED" || BLOCKING_REVIEW_STATES.has(publication.reviewStatus)) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "CREATIVE_REVIEW_NOT_APPROVED", reviewStatus: publication.reviewStatus });
  }
  return publication;
}

function createProviderReviewSyncService({ repository, providerReadRegistry, audit, events } = {}) {
  if (!repository || !providerReadRegistry) throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "REVIEW_SYNC_DEPENDENCIES_REQUIRED" });
  async function sync(publicationId) {
    const publication = await repository.findById(publicationId);
    if (!publication) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "CREATIVE_PUBLICATION_NOT_FOUND" });
    const reader = providerReadRegistry.resolve(publication.platform);
    if (typeof reader.readCreativeReview !== "function") throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { reasonCode: "CREATIVE_REVIEW_READBACK_UNAVAILABLE" });
    let review;
    try { review = await reader.readCreativeReview({ publication }); }
    catch (_error) { review = { status: "UNKNOWN", code: "REVIEW_READ_FAILED", message: "Provider review state could not be verified", providerVersion: publication.apiVersion }; }
    const normalized = String(review?.status || "UNKNOWN").toUpperCase();
    const status = ["PENDING_REVIEW", "APPROVED", "REJECTED", "LIMITED", "UNKNOWN"].includes(normalized) ? normalized : "UNKNOWN";
    const changed = await repository.recordReviewState({
      id: publication.id, reviewStatus: status, providerCode: review?.code, providerMessage: review?.message,
      providerVersion: review?.providerVersion || publication.apiVersion, checkedAt: new Date(),
      providerMediaId: review?.providerMediaId || publication.providerMediaId,
      providerCreativeId: review?.providerCreativeId || publication.providerCreativeId,
      providerAdId: review?.providerAdId || publication.providerAdId,
    });
    if (audit && publication.reviewStatus !== changed.reviewStatus) await audit.event({ actorId: null, action: "MARKETING_CREATIVE_REVIEW_CHANGED", targetId: publication.id, targetType: "marketing_creative_publication", metadata: { previousStatus: publication.reviewStatus, status: changed.reviewStatus, provider: publication.platform } });
    if (events && publication.reviewStatus !== changed.reviewStatus) await events.emit("CREATIVE_REVIEW_CHANGED", { id: publication.id, previousStatus: publication.reviewStatus, status: changed.reviewStatus });
    return changed;
  }
  return Object.freeze({ sync, assertApprovedForActivation: assertCreativeApprovedForActivation });
}

module.exports = { BLOCKING_REVIEW_STATES, assertCreativeApprovedForActivation, createProviderReviewSyncService };
