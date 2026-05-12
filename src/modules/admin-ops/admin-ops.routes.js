const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const { requireTier } = require("../../shared/middlewares/rbac.middleware");
const {
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
} = require("./admin-ops.controller");

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);
router.use(requireTier("ADMIN"));
router.use(limiter);

// ─── Service Registry ────────────────────────────────────────────────────────
router.get("/services", listServices);
router.post("/services", registerService);
router.get("/services/:id", getService);
router.put("/services/:id", updateService);
router.delete("/services/:id", deregisterService);
router.post("/services/:id/ping", pingService);

// ─── Job Monitoring ──────────────────────────────────────────────────────────
router.get("/jobs", listJobs);
router.post("/jobs/track", trackJob);
router.get("/jobs/:id", getJob);

// ─── Dead Letter Jobs ────────────────────────────────────────────────────────
router.get("/dead-letters", listDeadLetters);
router.get("/dead-letters/:id", getDeadLetter);
router.put("/dead-letters/:id/resolve", resolveDeadLetter);

// ─── Webhook Endpoints ───────────────────────────────────────────────────────
router.get("/webhooks", listWebhooks);
router.post("/webhooks", createWebhook);
router.get("/webhooks/:id", getWebhook);
router.put("/webhooks/:id", updateWebhook);
router.delete("/webhooks/:id", deleteWebhook);

// ─── Webhook Delivery Logs ───────────────────────────────────────────────────
router.get("/webhook-logs", listWebhookLogs);
router.get("/webhook-logs/:id", getWebhookLog);

// ─── Incidents ───────────────────────────────────────────────────────────────
router.get("/incidents", listIncidents);
router.post("/incidents", createIncident);
router.get("/incidents/:id", getIncident);
router.put("/incidents/:id", updateIncident);
router.post("/incidents/:id/resolve", resolveIncident);

// ─── System Alerts ───────────────────────────────────────────────────────────
router.get("/alerts", listAlerts);
router.post("/alerts", createAlert);
router.get("/alerts/:id", getAlert);
router.put("/alerts/:id/read", markAlertRead);
router.put("/alerts/:id/resolve", resolveAlert);

// ─── Feature Flags ───────────────────────────────────────────────────────────
router.get("/flags", listFlags);
router.post("/flags", createFlag);
router.get("/flags/:key/check", checkFlag);
router.get("/flags/:key", getFlag);
router.put("/flags/:key", updateFlag);
router.delete("/flags/:key", deleteFlag);

// ─── Health History ──────────────────────────────────────────────────────────
router.get("/health-history", listHealthHistory);
router.get("/health-history/latest", getLatestHealthCheck);

// ─── Environment Configs ─────────────────────────────────────────────────────
router.get("/env-configs", listEnvConfigs);
router.post("/env-configs", createEnvConfig);
router.put("/env-configs/:id", updateEnvConfig);
router.delete("/env-configs/:id", deleteEnvConfig);

module.exports = router;
