const crypto = require("crypto");
const ApiError = require("../../../shared/utils/ApiError");
const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const intelligenceService = require("./intelligence.service");
const funnelIngestionService = require("./funnel-ingestion.service");
const providerConnectionsService = require("./provider-connections.service");
const oauthService = require("./oauth.service");
const aggregationService = require("./aggregation/aggregation.service");
const {
  performanceQuerySchema,
  attributionPayloadSchema,
  funnelEventEnvelopeSchema,
  connectionUpsertSchema,
  connectionBootstrapSchema,
  connectionTestQuerySchema,
  connectionListQuerySchema,
  oauthStartQuerySchema,
  oauthCallbackQuerySchema,
  manualSyncSchema,
} = require("./intelligence.validator");

function validate(schema, data) {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));

    throw new ApiError(400, "Validation failed", errors);
  }

  return result.data;
}

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

const getConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.getConnection(req.params.id);
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
  const connection = await providerConnectionsService.updateConnection(req.params.id, {
    ...payload,
    accessTokenExpiresAt: parseOptionalDateTime(payload.accessTokenExpiresAt),
    refreshTokenExpiresAt: parseOptionalDateTime(payload.refreshTokenExpiresAt),
  });

  return ApiResponse.success(res, 200, "Marketing provider connection updated", connection);
});

const disableConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.disableConnection(req.params.id);
  return ApiResponse.success(res, 200, "Marketing provider connection disabled", connection);
});

const enableConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.enableConnection(req.params.id);
  return ApiResponse.success(res, 200, "Marketing provider connection enabled", connection);
});

const deleteConnection = asyncHandler(async (req, res) => {
  const connection = await providerConnectionsService.deleteConnection(req.params.id);
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
  const result = await providerConnectionsService.testConnection(req.params.id, query);
  return ApiResponse.success(res, 200, "Marketing provider connection tested", result);
});

const startOAuth = asyncHandler(async (req, res) => {
  const query = validate(oauthStartQuerySchema, req.query);
  const result = await oauthService.startOAuth(
    req.params.platform,
    query,
    req.adminUser.id,
  );
  return ApiResponse.success(res, 200, "Marketing provider OAuth start created", result);
});

const callbackOAuth = asyncHandler(async (req, res) => {
  const query = validate(oauthCallbackQuerySchema, req.query);
  try {
    const result = await oauthService.callbackOAuth(req.params.platform, query);
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
  });
  return ApiResponse.success(res, 202, "Marketing intelligence synchronization checked", result);
});

module.exports = {
  getPerformance,
  captureClickAttribution,
  ingestInternalFunnelEvent,
  listConnections,
  getConnection,
  upsertConnection,
  updateConnection,
  disableConnection,
  enableConnection,
  deleteConnection,
  bootstrapConnections,
  testConnection,
  startOAuth,
  callbackOAuth,
  syncMarketingInsights,
  requireInternalServiceKey,
};
