const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  requireSection,
} = require("../../shared/middlewares/rbac.middleware");
const {
  listServices,
  getService,
  registerService,
  updateService,
  deregisterService,
  pingService,
  listJobs,
  getJob,
  trackJob,
  listDeadLetters,
  getDeadLetter,
  resolveDeadLetter,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listWebhookLogs,
  getWebhookLog,
  listIncidents,
  getIncident,
  createIncident,
  updateIncident,
  resolveIncident,
  listAlerts,
  getAlert,
  createAlert,
  markAlertRead,
  resolveAlert,
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  deleteFlag,
  checkFlag,
  listHealthHistory,
  getLatestHealthCheck,
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

const view = requireSection("development", "admin-ops", "VIEW");
const edit = requireSection("development", "admin-ops", "EDIT");

router.get("/services", view, listServices);
router.post("/services", edit, registerService);
router.get("/services/:id", view, getService);
router.put("/services/:id", edit, updateService);
router.delete("/services/:id", edit, deregisterService);
router.post("/services/:id/ping", edit, pingService);

router.get("/jobs", view, listJobs);
router.post("/jobs/track", edit, trackJob);
router.get("/jobs/:id", view, getJob);

router.get("/dead-letters", view, listDeadLetters);
router.get("/dead-letters/:id", view, getDeadLetter);
router.put("/dead-letters/:id/resolve", edit, resolveDeadLetter);

router.get("/webhooks", view, listWebhooks);
router.post("/webhooks", edit, createWebhook);
router.get("/webhooks/:id", view, getWebhook);
router.put("/webhooks/:id", edit, updateWebhook);
router.delete("/webhooks/:id", edit, deleteWebhook);

router.get("/webhook-logs", view, listWebhookLogs);
router.get("/webhook-logs/:id", view, getWebhookLog);

router.get("/incidents", view, listIncidents);
router.post("/incidents", edit, createIncident);
router.get("/incidents/:id", view, getIncident);
router.put("/incidents/:id", edit, updateIncident);
router.post("/incidents/:id/resolve", edit, resolveIncident);

router.get("/alerts", view, listAlerts);
router.post("/alerts", edit, createAlert);
router.get("/alerts/:id", view, getAlert);
router.put("/alerts/:id/read", edit, markAlertRead);
router.put("/alerts/:id/resolve", edit, resolveAlert);

router.get("/flags", view, listFlags);
router.post("/flags", edit, createFlag);
router.get("/flags/:key/check", view, checkFlag);
router.get("/flags/:key", view, getFlag);
router.put("/flags/:key", edit, updateFlag);
router.delete("/flags/:key", edit, deleteFlag);

router.get("/health-history", view, listHealthHistory);
router.get("/health-history/latest", view, getLatestHealthCheck);

router.get("/env-configs", view, listEnvConfigs);
router.post("/env-configs", edit, createEnvConfig);
router.put("/env-configs/:id", edit, updateEnvConfig);
router.delete("/env-configs/:id", edit, deleteEnvConfig);

module.exports = router;
