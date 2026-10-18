const adminOpsService = require("./admin-ops.service");
const ApiResponse = require("../../shared/utils/ApiResponse");
const asyncHandler = require("../../shared/utils/asyncHandler");

// ─── Service Registry ────────────────────────────────────────────────────────

const listServices = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const data = await adminOpsService.listServices({
    status,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Services retrieved", data);
});

const getService = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getService(req.params.id);
  return ApiResponse.success(res, 200, "Service retrieved", data);
});

const registerService = asyncHandler(async (req, res) => {
  const data = await adminOpsService.registerService(req.body);
  return ApiResponse.success(res, 201, "Service registered", data);
});

const updateService = asyncHandler(async (req, res) => {
  const data = await adminOpsService.updateService(req.params.id, req.body);
  return ApiResponse.success(res, 200, "Service updated", data);
});

const deregisterService = asyncHandler(async (req, res) => {
  await adminOpsService.deregisterService(req.params.id);
  return ApiResponse.success(res, 200, "Service deregistered");
});

const pingService = asyncHandler(async (req, res) => {
  const data = await adminOpsService.pingService(req.params.id);
  return ApiResponse.success(res, 200, "Service pinged", data);
});

// ─── Job Monitoring ──────────────────────────────────────────────────────────

const listJobs = asyncHandler(async (req, res) => {
  const { status, jobType, jobName, page, limit } = req.query;
  const data = await adminOpsService.listJobs({
    status,
    jobType,
    jobName,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Job executions retrieved", data);
});

const getJob = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getJob(req.params.id);
  return ApiResponse.success(res, 200, "Job execution retrieved", data);
});

const trackJob = asyncHandler(async (req, res) => {
  const data = await adminOpsService.trackJob(req.body);
  return ApiResponse.success(res, 201, "Job execution recorded", data);
});

// ─── Dead Letter Jobs ────────────────────────────────────────────────────────

const listDeadLetters = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const data = await adminOpsService.listDeadLetters({
    status,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Dead letter jobs retrieved", data);
});

const getDeadLetter = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getDeadLetter(req.params.id);
  return ApiResponse.success(res, 200, "Dead letter job retrieved", data);
});

const resolveDeadLetter = asyncHandler(async (req, res) => {
  const data = await adminOpsService.resolveDeadLetter(
    req.params.id,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Dead letter job resolved", data);
});

// ─── Webhook Endpoints ───────────────────────────────────────────────────────

const listWebhooks = asyncHandler(async (req, res) => {
  const { isActive, page, limit } = req.query;
  const data = await adminOpsService.listWebhooks({
    isActive: isActive !== undefined ? isActive === "true" : undefined,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Webhook endpoints retrieved", data);
});

const getWebhook = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getWebhook(req.params.id);
  return ApiResponse.success(res, 200, "Webhook endpoint retrieved", data);
});

const createWebhook = asyncHandler(async (req, res) => {
  const data = await adminOpsService.createWebhook(req.body);
  return ApiResponse.success(res, 201, "Webhook endpoint created", data);
});

const updateWebhook = asyncHandler(async (req, res) => {
  const data = await adminOpsService.updateWebhook(req.params.id, req.body);
  return ApiResponse.success(res, 200, "Webhook endpoint updated", data);
});

const deleteWebhook = asyncHandler(async (req, res) => {
  await adminOpsService.deleteWebhook(req.params.id);
  return ApiResponse.success(res, 200, "Webhook endpoint deleted");
});

// ─── Webhook Delivery Logs ───────────────────────────────────────────────────

const listWebhookLogs = asyncHandler(async (req, res) => {
  const { webhookEndpointId, status, event, page, limit } = req.query;
  const data = await adminOpsService.listWebhookLogs({
    webhookEndpointId,
    status,
    event,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Webhook delivery logs retrieved", data);
});

const getWebhookLog = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getWebhookLog(req.params.id);
  return ApiResponse.success(res, 200, "Webhook delivery log retrieved", data);
});

// ─── Incidents ───────────────────────────────────────────────────────────────

const listIncidents = asyncHandler(async (req, res) => {
  const { status, severity, page, limit } = req.query;
  const data = await adminOpsService.listIncidents({
    status,
    severity,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Incidents retrieved", data);
});

const getIncident = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getIncident(req.params.id);
  return ApiResponse.success(res, 200, "Incident retrieved", data);
});

const createIncident = asyncHandler(async (req, res) => {
  const data = await adminOpsService.createIncident(req.body, req.adminUser);
  return ApiResponse.success(res, 201, "Incident created", data);
});

const updateIncident = asyncHandler(async (req, res) => {
  const data = await adminOpsService.updateIncident(req.params.id, req.body);
  return ApiResponse.success(res, 200, "Incident updated", data);
});

const resolveIncident = asyncHandler(async (req, res) => {
  const data = await adminOpsService.resolveIncident(
    req.params.id,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Incident resolved", data);
});

// ─── System Alerts ───────────────────────────────────────────────────────────

const listAlerts = asyncHandler(async (req, res) => {
  const { isResolved, isRead, severity, page, limit } = req.query;
  const data = await adminOpsService.listAlerts({
    isResolved: isResolved !== undefined ? isResolved === "true" : undefined,
    isRead: isRead !== undefined ? isRead === "true" : undefined,
    severity,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "System alerts retrieved", data);
});

const getAlert = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getAlert(req.params.id);
  return ApiResponse.success(res, 200, "Alert retrieved", data);
});

const createAlert = asyncHandler(async (req, res) => {
  const data = await adminOpsService.createAlert(req.body);
  return ApiResponse.success(res, 201, "Alert created", data);
});

const markAlertRead = asyncHandler(async (req, res) => {
  const data = await adminOpsService.markAlertRead(req.params.id);
  return ApiResponse.success(res, 200, "Alert marked as read", data);
});

const resolveAlert = asyncHandler(async (req, res) => {
  const data = await adminOpsService.resolveAlert(req.params.id);
  return ApiResponse.success(res, 200, "Alert resolved", data);
});

// ─── Feature Flags ───────────────────────────────────────────────────────────

const listFlags = asyncHandler(async (req, res) => {
  const { environment, page, limit } = req.query;
  const data = await adminOpsService.listFlags({
    environment,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Feature flags retrieved", data);
});

const getFlag = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getFlag(req.params.key);
  return ApiResponse.success(res, 200, "Feature flag retrieved", data);
});

const createFlag = asyncHandler(async (req, res) => {
  const data = await adminOpsService.createFlag(req.body, req.adminUser);
  return ApiResponse.success(res, 201, "Feature flag created", data);
});

const updateFlag = asyncHandler(async (req, res) => {
  const data = await adminOpsService.updateFlag(
    req.params.key,
    req.body,
    req.adminUser,
  );
  return ApiResponse.success(res, 200, "Feature flag updated", data);
});

const deleteFlag = asyncHandler(async (req, res) => {
  await adminOpsService.deleteFlag(req.params.key);
  return ApiResponse.success(res, 200, "Feature flag deleted");
});

const checkFlag = asyncHandler(async (req, res) => {
  const data = await adminOpsService.checkFlag(req.params.key);
  return ApiResponse.success(res, 200, "Feature flag checked", data);
});

// ─── Health History ──────────────────────────────────────────────────────────

const listHealthHistory = asyncHandler(async (req, res) => {
  const { status, environment, page, limit } = req.query;
  const data = await adminOpsService.listHealthHistory({
    status,
    environment,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Health check history retrieved", data);
});

const getLatestHealthCheck = asyncHandler(async (req, res) => {
  const data = await adminOpsService.getLatestHealthCheck();
  return ApiResponse.success(res, 200, "Latest health check retrieved", data);
});

// ─── Environment Configs ─────────────────────────────────────────────────────

const listEnvConfigs = asyncHandler(async (req, res) => {
  const { environment, page, limit } = req.query;
  const data = await adminOpsService.listEnvConfigs({
    environment,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  return ApiResponse.success(res, 200, "Environment configs retrieved", data);
});

const createEnvConfig = asyncHandler(async (req, res) => {
  const data = await adminOpsService.createEnvConfig(req.body);
  return ApiResponse.success(res, 201, "Config entry added", data);
});

const updateEnvConfig = asyncHandler(async (req, res) => {
  const data = await adminOpsService.updateEnvConfig(req.params.id, req.body);
  return ApiResponse.success(res, 200, "Config entry updated", data);
});

const deleteEnvConfig = asyncHandler(async (req, res) => {
  await adminOpsService.deleteEnvConfig(req.params.id);
  return ApiResponse.success(res, 200, "Config entry deleted");
});

module.exports = {
  // services
  listServices,
  getService,
  registerService,
  updateService,
  deregisterService,
  pingService,
  // jobs
  listJobs,
  getJob,
  trackJob,
  // dead letters
  listDeadLetters,
  getDeadLetter,
  resolveDeadLetter,
  // webhooks
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  // webhook logs
  listWebhookLogs,
  getWebhookLog,
  // incidents
  listIncidents,
  getIncident,
  createIncident,
  updateIncident,
  resolveIncident,
  // alerts
  listAlerts,
  getAlert,
  createAlert,
  markAlertRead,
  resolveAlert,
  // flags
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  deleteFlag,
  checkFlag,
  // health
  listHealthHistory,
  getLatestHealthCheck,
  // env configs
  listEnvConfigs,
  createEnvConfig,
  updateEnvConfig,
  deleteEnvConfig,
};
