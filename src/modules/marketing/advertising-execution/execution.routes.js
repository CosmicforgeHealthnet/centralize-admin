const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { authenticate } = require("../../../shared/middlewares/auth.middleware");
const { requireSection, requireTier } = require("../../../shared/middlewares/rbac.middleware");
const { requireExecutionRole } = require("./execution.authorization");
const { executionError } = require("./execution.errors");
const defaultController = require("./execution.controller");

function requestLimiter(max) { return rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { success: false, code: "RATE_LIMITED", message: "Too many advertising execution requests" } }); }
function mutationTransport(req, _res, next) {
  if (req.is("multipart/form-data")) return next();
  if (!req.is("application/json")) throw executionError("INVALID_EXECUTION_PLAN", { field: "headers.content-type", reasonCode: "APPLICATION_JSON_REQUIRED" });
  next();
}

function createExecutionRouter({ controller = defaultController, authenticateMiddleware = authenticate, sectionGate = requireSection, fineGate = requireExecutionRole } = {}) {
  const router = express.Router(); const readLimit = requestLimiter(120); const writeLimit = requestLimiter(30); const elevatedLimit = requestLimiter(10);
  const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 32 * 1024 * 1024, fields: 40, fieldSize: 32 * 1024, parts: 42, headerPairs: 100 } });
  const view = sectionGate("marketing", "advertising-execution", "VIEW"); const edit = sectionGate("marketing", "advertising-execution", "EDIT");
  const author = fineGate("AUTHOR"); const approver = fineGate("APPROVER"); const executionAdmin = fineGate("EXECUTION_ADMIN"); const emergencyOperator = fineGate("EMERGENCY_OPERATOR");
  router.use(authenticateMiddleware);
  const register = (method, path, ...handlers) => { const handler = handlers.at(-1); if (typeof handler === "function") router[method](path, ...handlers); };

  register("get", "/capabilities", readLimit, view, controller.getCapabilities);
  register("get", "/policies", readLimit, view, controller.getPolicies);
  register("patch", "/policies", elevatedLimit, edit, executionAdmin, mutationTransport, controller.updatePolicy);
  register("post", "/overrides", elevatedLimit, edit, emergencyOperator, mutationTransport, controller.createEmergencyOverride);
  register("post", "/plans", writeLimit, edit, author, mutationTransport, controller.createPlan);
  register("get", "/plans", readLimit, view, controller.listPlans);
  register("get", "/plans/:id", readLimit, view, controller.getPlan);
  register("patch", "/plans/:id", writeLimit, edit, author, mutationTransport, controller.updatePlan);
  register("delete", "/plans/:id", writeLimit, edit, author, mutationTransport, controller.deletePlan);
  register("post", "/plans/:id/validate", writeLimit, edit, author, mutationTransport, controller.validatePlan);
  register("post", "/plans/:id/submit", writeLimit, edit, author, mutationTransport, controller.submitPlan);
  register("post", "/plans/:id/approve", elevatedLimit, edit, approver, mutationTransport, controller.approvePlan);
  register("post", "/plans/:id/reject", elevatedLimit, edit, approver, mutationTransport, controller.rejectPlan);
  register("post", "/plans/:id/revoke-approval", elevatedLimit, edit, approver, mutationTransport, controller.revokeApproval);
  register("post", "/plans/:id/queue", elevatedLimit, edit, author, mutationTransport, controller.queuePlan);
  register("post", "/plans/:id/cancel", elevatedLimit, edit, author, mutationTransport, controller.cancelPlan);
  register("post", "/plans/:id/create-compensation", elevatedLimit, edit, author, mutationTransport, controller.createCompensation);
  register("get", "/runs", readLimit, view, controller.listRuns);
  register("get", "/runs/:id", readLimit, view, controller.getRun);
  register("get", "/operations/:id", readLimit, view, controller.getOperation);
  register("post", "/operations/:id/retry", elevatedLimit, edit, executionAdmin, mutationTransport, controller.retryOperation);
  register("get", "/drift", readLimit, view, controller.listDrift);
  register("post", "/drift/:id/acknowledge", elevatedLimit, edit, executionAdmin, mutationTransport, controller.acknowledgeDrift);
  register("post", "/recommendations/:id/create-plan", elevatedLimit, edit, author, mutationTransport, controller.convertRecommendation);
  register("post", "/creatives/:id/publications", elevatedLimit, edit, author, mediaUpload.single("media"), controller.createCreativePublication);
  register("get", "/creatives/:id/publications", readLimit, view, controller.listCreativePublications);
  register("get", "/health", readLimit, view, controller.getHealth);

  // Backward-compatible read/preflight and operational routes retained for Sections 6-24 clients.
  register("get", "/lifecycle", readLimit, view, controller.getLifecycle);
  register("post", "/preflight", writeLimit, edit, mutationTransport, controller.preflight);
  register("post", "/creatives", writeLimit, edit, mediaUpload.single("media"), controller.createCreativeRevision);
  register("get", "/creatives/:id", readLimit, view, controller.getCreativePublication);
  register("post", "/creatives/:id/sync-review", elevatedLimit, edit, mutationTransport, controller.syncCreativeReview);
  register("post", "/recommendations/:recommendationId/draft-plan", writeLimit, edit, mutationTransport, controller.convertRecommendation);
  register("get", "/runs/:runId/status", readLimit, view, controller.getRunStatus);
  register("post", "/jobs/:jobId/dead-letter-review", elevatedLimit, edit, requireTier("ADMIN"), mutationTransport, controller.reviewDeadLetter);
  register("get", "/reconciliations/:id", readLimit, view, controller.getReconciliationStatus);
  register("post", "/compensations", elevatedLimit, edit, requireTier("ADMIN"), mutationTransport, controller.createCompensationDraft);
  return router;
}

module.exports = createExecutionRouter();
module.exports.createExecutionRouter = createExecutionRouter;
module.exports.mutationTransport = mutationTransport;
