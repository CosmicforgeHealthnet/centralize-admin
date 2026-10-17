const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { PlanRepository } = require("../plans/plan.repository");

function createRecommendationExecutionBridge({ client, planRepository = new PlanRepository({ client }), capabilityResolver, liveStateResolver, audit, events } = {}) {
  if (!client) throw new TypeError("A database client is required");

  async function createDraft({ recommendationId, actor }) {
    if (!actor?.id) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "AUTHENTICATED_AUTHOR_REQUIRED" });
    const activeStatuses = ["DRAFT", "VALIDATING", "VALIDATED", "PENDING_APPROVAL", "APPROVED", "QUEUED", "EXECUTING"];
    const existing = await client.marketingExecutionPlan.findFirst({ where: { sourceRecommendationId: recommendationId, status: { in: activeStatuses } }, orderBy: { createdAt: "desc" } });
    if (existing) return { plan: existing, created: false };
    const recommendation = await client.marketing_recommendations.findUnique({ where: { id: recommendationId }, include: { connection: true } });
    if (!recommendation || recommendation.status !== "ACCEPTED") throw executionError("INVALID_EXECUTION_PLAN", { field: "recommendationId", reasonCode: "ACCEPTED_RECOMMENDATION_REQUIRED" });
    if (!recommendation.connection || recommendation.connection.status !== "ACTIVE" || recommendation.connection.requiresReauthorization) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: recommendation.platform, reasonCode: "RECOMMENDATION_CONNECTION_UNAVAILABLE" });
    const capability = await capabilityResolver({ provider: recommendation.platform, connectionId: recommendation.connectionId, accountExternalId: recommendation.connection.accountId });
    if (!capability?.operationSupported) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: recommendation.platform, reasonCode: "RECOMMENDATION_ACTION_UNSUPPORTED" });
    const liveState = sanitizeExecutionJson(await liveStateResolver({ recommendation, connection: recommendation.connection }), "beforeState");
    const recommendationContext = {
      nonAuthoritative: true,
      evidence: recommendation.evidence,
      suggestedAction: recommendation.suggestedAction,
      reasoning: recommendation.reasoning,
      confidence: String(recommendation.confidence),
    };
    if (recommendation.materialEvidenceFingerprint) recommendationContext.materialEvidenceFingerprint = recommendation.materialEvidenceFingerprint;
    const desiredState = sanitizeExecutionJson({
      provider: recommendation.platform,
      connectionId: recommendation.connectionId,
      accountId: recommendation.connection.accountId,
      currencyCode: recommendation.connection.currency || recommendation.currencyCode,
      name: `Draft from recommendation ${recommendation.id}`,
      authorReviewRequired: true,
      recommendationContext,
      liveProviderState: liveState,
      normalizedPlanFieldsRequired: true,
    }, "desiredState");
    let plan;
    let created = true;
    try {
      plan = await planRepository.create({ sourceType: "RECOMMENDATION", sourceRecommendationId: recommendation.id, platform: recommendation.platform, connectionId: recommendation.connectionId, accountExternalId: recommendation.connection.accountId, currencyCode: desiredState.currencyCode, name: desiredState.name, description: "Recommendation context is non-authoritative and requires author review.", desiredState, createdByAdminUserId: actor.id, updatedByAdminUserId: actor.id, items: [] });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      plan = await client.marketingExecutionPlan.findFirst({ where: { sourceRecommendationId: recommendationId, status: { in: activeStatuses } }, orderBy: { createdAt: "desc" } });
      created = false;
    }
    if (created && audit?.event) await audit.event({ action: "MARKETING_RECOMMENDATION_EXECUTION_DRAFT_CREATED", actorId: actor.id, targetId: plan.id, targetType: "marketing_execution_plan", metadata: { recommendationId, planId: plan.id, sourceType: "RECOMMENDATION", confidenceDoesNotAffectApproval: true } });
    if (created && events) await events.emit("RECOMMENDATION_CONVERTED", { recommendationId, planId: plan.id, actorId: actor.id });
    return { plan, created };
  }

  return Object.freeze({ createDraft });
}

module.exports = { createRecommendationExecutionBridge };
