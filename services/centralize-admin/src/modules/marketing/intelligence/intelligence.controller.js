const crypto = require("crypto");
const { z } = require("zod");
const ApiError = require("../../../shared/utils/ApiError");
const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const intelligenceService = require("./intelligence.service");
const funnelIngestionService = require("./funnel-ingestion.service");
const providerConnectionsService = require("./provider-connections.service");
const oauthService = require("./oauth.service");
const aggregationService = require("./aggregation/aggregation.service");
const creativeSyncService = require("./creative/creative-sync.service");
const creativeQueryService = require("./creative/creative-query.service");
const creativeScoringService = require("./creative/creative-scoring.service");
const recommendationEvaluationService = require("./recommendations/recommendation-evaluation.service");
const { createRecommendationQueryService } = require("./recommendations/recommendation-query.service");
const { createRecommendationLifecycleService } = require("./recommendations/recommendation-lifecycle.service");
const { createRecommendationTaskAdapter } = require("./recommendations/recommendation-task.adapter");
const alertEvaluationService = require("./alerts/alert-evaluation.service");
const { createAlertQueryService } = require("./alerts/alert-query.service");
const { createAlertLifecycleService } = require("./alerts/alert-lifecycle.service");
const { createExperimentService } = require("./experiments/experiment.service");
const { createSettingsService } = require("./settings.service");
const { createRunQueryService } = require("./run-query.service");
const { serializeIntelligenceResponse } = require("./response-serializer");
const {
  creativeListQuerySchema,
  creativeSyncSchema,
  creativeScoreSchema,
  scoreListQuerySchema,
} = require("./creative/creative.validator");
const {
  recommendationListSchema,
  recommendationEvaluateSchema,
  recommendationDismissSchema,
  recommendationConvertToTaskSchema,
} = require("./recommendations/recommendation.validator");
const { alertListSchema, alertEvaluateSchema, alertResolveSchema } = require("./alerts/alert.validator");
const { experimentCreateSchema, experimentUpdateSchema, experimentCompleteSchema, experimentCancelSchema, experimentListSchema } = require("./experiments/experiment.validator");
const { settingsQuerySchema, settingsPatchSchema } = require("./settings.validator");
const { runListSchema } = require("./run.validator");
const { uuidSchema } = require("./validation-security");
const { createAuditLog } = require("../../../shared/middlewares/audit.middleware");
const {
  performanceQuerySchema,
  attributionPayloadSchema,
  funnelEventEnvelopeSchema,
  connectionUpsertSchema,
  connectionBootstrapSchema,
  connectionTestQuerySchema,
  providerValidationEvidenceSchema,
  connectionListQuerySchema,
  oauthStartQuerySchema,
  oauthCallbackQuerySchema,
  manualSyncSchema,
} = require("./intelligence.validator");

const recommendationQueryService = createRecommendationQueryService();
const recommendationLifecycleService = createRecommendationLifecycleService();
const recommendationTaskAdapter = createRecommendationTaskAdapter();
const alertQueryService = createAlertQueryService();
const alertLifecycleService = createAlertLifecycleService();
const experimentService = createExperimentService();
const settingsService = createSettingsService();
const runQueryService = createRunQueryService();

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      code: "VALIDATION_ERROR",
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw new ApiError(400, "Validation failed", errors);
  }

  return result.data;
}

const idParamSchema = z.object({ id: uuidSchema }).strict();
const platformParamSchema = z.object({ platform: z.preprocess((value) => String(value || "").toUpperCase(), z.enum(["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"])) }).strict();
const validatedId = (req, field = "id") => validate(idParamSchema, req.params).id || field;
const validatedPlatform = (req) => validate(platformParamSchema, req.params).platform;
const partialMeta = (result, extra = {}) => ({
  ...extra,
  partial: result?.status === "PARTIAL_SUCCESS" || Boolean(result?.partial),
  ...(result?.failures?.length ? { errors: serializeIntelligenceResponse(result.failures) } : {}),
});

function parseOptionalDateTime(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, "Invalid datetime");
  return parsed;
}

function internalKeyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireInternalServiceKey(req, _res, next) {
  const expected = process.env.MARKETING_INTELLIGENCE_INTERNAL_SERVICE_KEY;
  if (!expected) return next(new ApiError(503, "Internal service key is not configured"));

  const provided = req.get("x-internal-service-key");
  if (!internalKeyMatches(provided, expected)) {
    return next(new ApiError(401, "Invalid internal service key"));
  }

  return next();
}

const getPerformance = asyncHandler(async (req, res) => {
  const query = validate(performanceQuerySchema, req.query);
  const data = await intelligenceService.getPerformanceDashboard(query);

  return ApiResponse.success(
    res,
    200,
    "Marketing intelligence performance retrieved",
    data,
  );
});

const captureClickAttribution = asyncHandler(async (req, res) => {
  const payload = validate(attributionPayloadSchema, req.body);
  const result = await funnelIngestionService.captureClick(payload);

  return ApiResponse.success(res, 202, "Marketing attribution captured", {
    id: result.attribution.id,
    anonId: result.attribution.anonId,
    platform: result.attribution.platform,
    campaignExternalId: result.attribution.campaignExternalId,
    duplicate: Boolean(result.funnelEvent?.duplicate),
  });
});

const ingestInternalFunnelEvent = asyncHandler(async (req, res) => {
  const envelope = validate(funnelEventEnvelopeSchema, req.body);
  const result = await funnelIngestionService.ingestEnvelope(envelope);

  return ApiResponse.success(res, 202, "Marketing funnel event accepted", {
    duplicate: Boolean(result?.duplicate || result?.funnelEvent?.duplicate),
    id: result?.id || result?.funnelEvent?.id || null,
  });
});

const listConnections = asyncHandler(async (req, res) => {
  const query = validate(connectionListQuerySchema, req.query);
  const connections = await providerConnectionsService.listConnections(query);
  return ApiResponse.success(res, 200, "Marketing provider connections retrieved", connections);
});

const listProviderValidationStatus = asyncHandler(async (_req, res) => {
  const status = await providerConnectionsService.listValidationStatus();
  return ApiResponse.success(res, 200, "Marketing provider validation status retrieved", status);
});

const getConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.getConnection(validatedId(req, "connectionId"));
  return ApiResponse.success(res, 200, "Marketing provider connection retrieved", connection);
});

const upsertConnection = asyncHandler(async (req, res) => {
  const payload = validate(connectionUpsertSchema, req.body);
  const connection = await providerConnectionsService.upsertConnection({
    ...payload,
    accessTokenExpiresAt: parseOptionalDateTime(payload.accessTokenExpiresAt),
    refreshTokenExpiresAt: parseOptionalDateTime(payload.refreshTokenExpiresAt),
  });

  return ApiResponse.success(res, 200, "Marketing provider connection saved", connection);
});

const updateConnection = asyncHandler(async (req, res) => {
  const payload = validate(connectionUpsertSchema.partial(), req.body);
  const connection = await providerConnectionsService.updateConnection(validatedId(req, "connectionId"), {
    ...payload,
    accessTokenExpiresAt: parseOptionalDateTime(payload.accessTokenExpiresAt),
    refreshTokenExpiresAt: parseOptionalDateTime(payload.refreshTokenExpiresAt),
  });

  return ApiResponse.success(res, 200, "Marketing provider connection updated", connection);
});

const disableConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.disableConnection(validatedId(req, "connectionId"));
  return ApiResponse.success(res, 200, "Marketing provider connection disabled", connection);
});

const enableConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.enableConnection(validatedId(req, "connectionId"));
  return ApiResponse.success(res, 200, "Marketing provider connection enabled", connection);
});

const deleteConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.deleteConnection(validatedId(req, "connectionId"));
  return ApiResponse.success(res, 200, "Marketing provider connection disabled", connection);
});

const bootstrapConnections = asyncHandler(async (req, res) => {
  const payload = validate(connectionBootstrapSchema, req.body || {});
  const result = payload.platform
    ? await providerConnectionsService.bootstrapConnectionFromEnv(payload.platform)
    : await providerConnectionsService.bootstrapAllFromEnv();

  return ApiResponse.success(res, 200, "Marketing provider bootstrap checked", result);
});

const testConnection = asyncHandler(async (req, res) => {
  const query = validate(connectionTestQuerySchema, req.query);
  const result = await providerConnectionsService.testConnection(validatedId(req, "connectionId"), query);
  return ApiResponse.success(res, 200, "Marketing provider connection tested", result);
});

const startOAuth = asyncHandler(async (req, res) => {
  const query = validate(oauthStartQuerySchema, req.query);
  const result = await oauthService.startOAuth(
    validatedPlatform(req),
    query,
    req.adminUser.id,
  );
  return ApiResponse.success(res, 200, "Marketing provider OAuth start created", result);
});

const callbackOAuth = asyncHandler(async (req, res) => {
  const query = validate(oauthCallbackQuerySchema, req.query);
  try {
    const result = await oauthService.callbackOAuth(validatedPlatform(req), query);
    if (result.redirectUrl) {
      return res.redirect(result.redirectUrl);
    }
    return ApiResponse.success(res, 200, "Marketing provider OAuth callback completed", result);
  } catch (error) {
    const failureRedirect = oauthService.fixedRedirectUrl(false);
    if (failureRedirect) return res.redirect(failureRedirect);
    throw error;
  }
});

const syncMarketingInsights = asyncHandler(async (req, res) => {
  const payload = validate(manualSyncSchema, req.body || {});
  const result = await aggregationService.syncMarketingInsights({
    ...payload,
    trigger: "manual-api",
    requestedByAdminUserId: req.adminUser.id,
  });
  if (result?.skipped && result.reason === "sync_already_running") {
    throw new ApiError(409, "Marketing intelligence synchronization is already running", [{ code: "LOCK_CONFLICT" }]);
  }
  await createAuditLog({ adminUserId: req.adminUser.id, action: "MARKETING_INTELLIGENCE_SYNCED", targetId: result.runId, targetType: "marketing_intelligence_evaluation_run", metadata: { runId: result.runId, trigger: "manual-api", scope: { platforms: payload.platforms || [], connectionIds: payload.connectionIds || [] }, resultStatus: result.completedAt ? "SUCCEEDED" : "FAILED" }, req });
  return ApiResponse.success(res, 202, "Marketing intelligence synchronization checked", serializeIntelligenceResponse(result), partialMeta(result));
});

const listCreatives = asyncHandler(async (req, res) => {
  const query = validate(creativeListQuerySchema, req.query);
  const result = await creativeQueryService.listCreatives(query);
  return ApiResponse.success(res, 200, "Marketing creative assets retrieved", serializeIntelligenceResponse(result));
});

const getCreative = asyncHandler(async (req, res) => {
  const result = await creativeQueryService.getCreative(validatedId(req, "creativeId"));
  return ApiResponse.success(res, 200, "Marketing creative asset retrieved", serializeIntelligenceResponse(result));
});

const syncCreatives = asyncHandler(async (req, res) => {
  const payload = validate(creativeSyncSchema, req.body || {});
  const result = await creativeSyncService.syncCreatives({
    ...payload,
    trigger: "manual-api",
    requestedByAdminUserId: req.adminUser.id,
  });
  if (result?.skipped && result.reason === "creative_sync_already_running") {
    throw new ApiError(409, "Marketing creative synchronization is already running", [{ code: "LOCK_CONFLICT" }]);
  }
  await createAuditLog({ adminUserId: req.adminUser.id, action: "MARKETING_CREATIVE_SYNCED", targetId: result.runId, targetType: "marketing_intelligence_evaluation_run", metadata: { runId: result.runId, trigger: "manual-api", scope: { platforms: payload.platforms || [], connectionIds: payload.connectionIds || [] }, resultStatus: result.status }, req });
  return ApiResponse.success(res, 202, "Marketing creative synchronization checked", serializeIntelligenceResponse(result), partialMeta(result));
});

const scoreCreatives = asyncHandler(async (req, res) => {
  const payload = validate(creativeScoreSchema, req.body || {});
  const result = await creativeScoringService.scoreCreatives({
    ...payload,
    trigger: "manual-api",
    requestedByAdminUserId: req.adminUser.id,
  });
  if (result?.skipped && result.reason === "creative_score_already_running") {
    throw new ApiError(409, "Marketing creative scoring is already running", [{ code: "LOCK_CONFLICT" }]);
  }
  await createAuditLog({ adminUserId: req.adminUser.id, action: "MARKETING_CREATIVE_SCORED", targetId: result.runId, targetType: "marketing_intelligence_evaluation_run", metadata: { runId: result.runId, trigger: "manual-api", scope: { platform: payload.platform || "all", connectionIds: payload.connectionIds || [] }, resultStatus: result.status }, req });
  return ApiResponse.success(res, 202, "Marketing creative scoring checked", serializeIntelligenceResponse(result), partialMeta(result));
});

const listCreativeScores = asyncHandler(async (req, res) => {
  const query = validate(scoreListQuerySchema, req.query);
  const result = await creativeScoringService.listScores(validatedId(req, "creativeId"), query);
  return ApiResponse.success(res, 200, "Marketing creative scores retrieved", serializeIntelligenceResponse(result));
});

const getLatestCreativeScore = asyncHandler(async (req, res) => {
  const result = await creativeScoringService.latestScore(validatedId(req, "creativeId"));
  if (!result) throw new ApiError(404, "Creative score not found");
  return ApiResponse.success(res, 200, "Latest marketing creative score retrieved", serializeIntelligenceResponse(result));
});

const listRecommendations = asyncHandler(async (req, res) => {
  const query = validate(recommendationListSchema, req.query);
  return ApiResponse.success(res, 200, "Marketing recommendations retrieved", serializeIntelligenceResponse(await recommendationQueryService.list(query)));
});

const getRecommendation = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "Marketing recommendation retrieved", serializeIntelligenceResponse(await recommendationQueryService.get(validatedId(req, "recommendationId"))));
});

const evaluateRecommendations = asyncHandler(async (req, res) => {
  const payload = validate(recommendationEvaluateSchema, req.body || {});
  const result = await recommendationEvaluationService.evaluate({ ...payload, trigger: "manual-api", requestedByAdminUserId: req.adminUser.id });
  if (result?.skipped) throw new ApiError(409, "Marketing recommendation evaluation is already running", [{ code: "LOCK_CONFLICT" }]);
  await createAuditLog({ adminUserId: req.adminUser.id, action: "MARKETING_RECOMMENDATION_EVALUATED", targetId: result.runId, targetType: "marketing_intelligence_evaluation_run", metadata: { runId: result.runId, platform: payload.platform, connectionId: payload.connectionId || null, trigger: "manual-api", resultStatus: result.status, recommendationCount: result.results.length }, req });
  return ApiResponse.success(res, 202, "Marketing recommendation evaluation completed", serializeIntelligenceResponse(result), partialMeta(result));
});

const acceptRecommendation = asyncHandler(async (req, res) => {
  const result = await recommendationLifecycleService.accept(validatedId(req, "recommendationId"), experimentActor(req));
  return ApiResponse.success(res, 200, "Marketing recommendation accepted", serializeIntelligenceResponse(result));
});

const dismissRecommendation = asyncHandler(async (req, res) => {
  const payload = validate(recommendationDismissSchema, req.body || {});
  const result = await recommendationLifecycleService.dismiss(validatedId(req, "recommendationId"), experimentActor(req), payload.reason);
  return ApiResponse.success(res, 200, "Marketing recommendation dismissed", serializeIntelligenceResponse(result));
});

const convertRecommendationToTask = asyncHandler(async (req, res) => {
  const payload = validate(recommendationConvertToTaskSchema, req.body || {});
  const result = await recommendationTaskAdapter.convert({
    recommendationId: validatedId(req, "recommendationId"),
    actorAdminUserId: req.adminUser.id,
    ...payload,
    ipAddress: req.ip,
    userAgent: req.headers?.["user-agent"],
  });
  return ApiResponse.success(res, 200, result.idempotent ? "Existing recommendation task retrieved" : "Recommendation converted to task", serializeIntelligenceResponse(result));
});

const listAlerts = asyncHandler(async (req, res) => {
  const query = validate(alertListSchema, req.query);
  return ApiResponse.success(res, 200, "Marketing alerts retrieved", serializeIntelligenceResponse(await alertQueryService.list(query)));
});

const getAlert = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "Marketing alert retrieved", serializeIntelligenceResponse(await alertQueryService.get(validatedId(req, "alertId"))));
});

const evaluateAlerts = asyncHandler(async (req, res) => {
  const payload = validate(alertEvaluateSchema, req.body || {});
  const result = await alertEvaluationService.evaluate({ ...payload, trigger: "manual-api", requestedByAdminUserId: req.adminUser.id });
  if (result?.skipped) throw new ApiError(409, "Marketing alert evaluation is already running", [{ code: "LOCK_CONFLICT" }]);
  await createAuditLog({ adminUserId: req.adminUser.id, action: "MARKETING_ALERT_EVALUATED", targetId: result.runId, targetType: "marketing_intelligence_evaluation_run", metadata: { runId: result.runId, platform: payload.platform, connectionId: payload.connectionId || null, trigger: "manual-api", resultStatus: result.status, alertCount: result.results.length }, req });
  return ApiResponse.success(res, 202, "Marketing alert evaluation completed", serializeIntelligenceResponse(result), partialMeta(result));
});

const acknowledgeAlert = asyncHandler(async (req, res) => {
  const result = await alertLifecycleService.acknowledge(validatedId(req, "alertId"), experimentActor(req));
  return ApiResponse.success(res, 200, "Marketing alert acknowledged", serializeIntelligenceResponse(result));
});

const resolveAlert = asyncHandler(async (req, res) => {
  const payload = validate(alertResolveSchema, req.body || {});
  const result = await alertLifecycleService.resolve(validatedId(req, "alertId"), experimentActor(req), payload.reason);
  return ApiResponse.success(res, 200, "Marketing alert resolved", serializeIntelligenceResponse(result));
});

const experimentActor = (req) => ({ id: req.adminUser.id, ipAddress: req.ip, userAgent: req.headers?.["user-agent"] });

const createExperiment = asyncHandler(async (req, res) => {
  const payload = validate(experimentCreateSchema, req.body || {});
  return ApiResponse.success(res, 201, "Marketing experiment draft created", serializeIntelligenceResponse(await experimentService.create(payload, experimentActor(req))));
});

const listExperiments = asyncHandler(async (req, res) => {
  const query = validate(experimentListSchema, req.query);
  return ApiResponse.success(res, 200, "Marketing experiments retrieved", serializeIntelligenceResponse(await experimentService.list(query)));
});

const getExperiment = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "Marketing experiment retrieved", serializeIntelligenceResponse(await experimentService.get(validatedId(req, "experimentId"))));
});

const updateExperiment = asyncHandler(async (req, res) => {
  const payload = validate(experimentUpdateSchema, req.body || {});
  return ApiResponse.success(res, 200, "Marketing experiment draft updated", serializeIntelligenceResponse(await experimentService.update(validatedId(req, "experimentId"), payload, experimentActor(req))));
});

const startExperiment = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "Marketing experiment started", serializeIntelligenceResponse(await experimentService.start(validatedId(req, "experimentId"), experimentActor(req))));
});

const completeExperiment = asyncHandler(async (req, res) => {
  const payload = validate(experimentCompleteSchema, req.body || {});
  return ApiResponse.success(res, 200, "Marketing experiment completed", serializeIntelligenceResponse(await experimentService.complete(validatedId(req, "experimentId"), payload, experimentActor(req))));
});

const cancelExperiment = asyncHandler(async (req, res) => {
  const payload = validate(experimentCancelSchema, req.body || {});
  return ApiResponse.success(res, 200, "Marketing experiment cancelled", serializeIntelligenceResponse(await experimentService.cancel(validatedId(req, "experimentId"), payload.reason, experimentActor(req))));
});

const getSettings = asyncHandler(async (req, res) => {
  const query = validate(settingsQuerySchema, req.query);
  const result = await settingsService.getSettings(query, query);
  return ApiResponse.success(res, 200, "Marketing Intelligence settings retrieved", serializeIntelligenceResponse(result), { warnings: result.warnings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const payload = validate(settingsPatchSchema, req.body || {});
  const actor = experimentActor(req);
  const updated = await settingsService.updateSettings(payload.updates, actor);
  const context = payload.updates.length === 1 ? payload.updates[0] : {};
  const effective = await settingsService.getSettings(context, { includeConfigured: true, includeDefaults: true });
  return ApiResponse.success(res, 200, "Marketing Intelligence settings updated", serializeIntelligenceResponse({ updated, ...effective }), { warnings: effective.warnings });
});

const listEvaluationRuns = asyncHandler(async (req, res) => {
  const query = validate(runListSchema, req.query);
  return ApiResponse.success(res, 200, "Marketing Intelligence evaluation runs retrieved", serializeIntelligenceResponse(await runQueryService.list(query)));
});

const getEvaluationRun = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, 200, "Marketing Intelligence evaluation run retrieved", serializeIntelligenceResponse(await runQueryService.get(validatedId(req, "evaluationRunId"))));
});

const recordProviderValidationEvidence = asyncHandler(async (req, res) => {
  const payload = validate(providerValidationEvidenceSchema, req.body || {});
  const connectionId = validatedId(req, "connectionId");
  const result = await providerConnectionsService.recordValidationEvidence(
    connectionId,
    payload,
  );
  await createAuditLog({
    adminUserId: req.adminUser.id,
    action: "MARKETING_INTELLIGENCE_VALIDATION_UPDATED",
    targetId: connectionId,
    targetType: "marketing_ad_platform_connection",
    metadata: {
      platform: result.platform,
      validationStatus: result.validationStatus,
      recordedChecks: Object.keys(payload).filter((key) => key !== "checkedAt"),
    },
    req,
  });
  return ApiResponse.success(res, 200, "Marketing provider validation evidence recorded", result);
});

module.exports = {
  getPerformance,
  captureClickAttribution,
  ingestInternalFunnelEvent,
  listConnections,
  listProviderValidationStatus,
  getConnection,
  upsertConnection,
  updateConnection,
  disableConnection,
  enableConnection,
  deleteConnection,
  bootstrapConnections,
  testConnection,
  recordProviderValidationEvidence,
  startOAuth,
  callbackOAuth,
  syncMarketingInsights,
  listCreatives,
  getCreative,
  syncCreatives,
  scoreCreatives,
  listCreativeScores,
  getLatestCreativeScore,
  listRecommendations,
  getRecommendation,
  evaluateRecommendations,
  acceptRecommendation,
  dismissRecommendation,
  convertRecommendationToTask,
  listAlerts,
  getAlert,
  evaluateAlerts,
  acknowledgeAlert,
  resolveAlert,
  createExperiment,
  listExperiments,
  getExperiment,
  updateExperiment,
  startExperiment,
  completeExperiment,
  cancelExperiment,
  getSettings,
  updateSettings,
  listEvaluationRuns,
  getEvaluationRun,
  requireInternalServiceKey,
};
