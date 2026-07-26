const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const { createExecutionService } = require("./execution.service");
const { executionError } = require("./execution.errors");

function requestPayload(req) {
  if (typeof req.body?.payload !== "string") return req.body || {};
  try { return JSON.parse(req.body.payload); } catch (_error) { throw executionError("INVALID_EXECUTION_PLAN", { field: "body.payload", reasonCode: "INVALID_JSON" }); }
}

function createExecutionController({ service = createExecutionService() } = {}) {
  const actor = (req) => ({ ...req.adminUser, correlationId: req.correlationId || null });
  const ok = (status, message, handler) => asyncHandler(async (req, res) => ApiResponse.success(res, status, message, await handler(req), { correlationId: req.correlationId || null }));
  return {
    getCapabilities: ok(200, "Advertising execution capabilities retrieved", (req) => service.capabilities(req.query || {})),
    getPolicies: ok(200, "Advertising execution policies retrieved", (req) => service.listPolicies(req.query || {})),
    updatePolicy: ok(200, "Advertising execution policy updated", (req) => service.updatePolicy({ actor: actor(req), input: req.body || {} })),
    createEmergencyOverride: ok(201, "Advertising execution emergency override created", (req) => service.createEmergencyOverride({ actor: actor(req), input: req.body || {} })),
    createPlan: ok(201, "Advertising execution draft created", (req) => service.createPlan({ actor: actor(req), input: req.body || {} })),
    listPlans: ok(200, "Advertising execution plans retrieved", (req) => service.listPlans(req.query || {})),
    getPlan: ok(200, "Advertising execution plan retrieved", (req) => service.getPlan({ id: req.params.id })),
    updatePlan: ok(200, "Advertising execution draft updated", (req) => service.updatePlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    deletePlan: ok(200, "Advertising execution draft cancelled", (req) => service.deletePlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    validatePlan: ok(200, "Advertising execution plan validated", (req) => service.validatePlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    submitPlan: ok(200, "Advertising execution plan submitted", (req) => service.submitPlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    approvePlan: ok(200, "Advertising execution approval recorded", (req) => service.approvePlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    rejectPlan: ok(200, "Advertising execution rejection recorded", (req) => service.rejectPlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    revokeApproval: ok(200, "Advertising execution approval revoked", (req) => service.revokeApproval({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    queuePlan: ok(202, "Approved plan queued", (req) => service.queuePlan({ actor: actor(req), planId: req.params.id || req.params.planId, input: req.body || {} })),
    cancelPlan: ok(200, "Advertising execution cancellation processed", (req) => service.cancelPlan({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    createCompensation: ok(201, "Compensation draft created", (req) => service.createCompensationDraft({ actor: actor(req), planId: req.params.id, input: req.body || {} })),
    listRuns: ok(200, "Advertising execution runs retrieved", (req) => service.listRuns(req.query || {})),
    getRun: ok(200, "Advertising execution run retrieved", (req) => service.getRun({ id: req.params.id || req.params.runId })),
    getOperation: ok(200, "Advertising execution operation retrieved", (req) => service.getOperation({ id: req.params.id })),
    retryOperation: ok(202, "Advertising execution retry review scheduled", (req) => service.retryOperation({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    listDrift: ok(200, "Advertising execution drift incidents retrieved", (req) => service.listDrift(req.query || {})),
    acknowledgeDrift: ok(200, "Advertising execution drift acknowledged", (req) => service.acknowledgeDrift({ actor: actor(req), id: req.params.id, input: req.body || {} })),
    convertRecommendation: ok(201, "Recommendation converted to draft plan", (req) => service.convertRecommendation({ actor: actor(req), recommendationId: req.params.id || req.params.recommendationId })),
    createCreativePublication: ok(201, "Creative publication revision validated and created", (req) => service.createCreativePublication({ actor: actor(req), creativeId: req.params.id, input: requestPayload(req), media: req.file })),
    listCreativePublications: ok(200, "Creative publications retrieved", (req) => service.listCreativePublications({ actor: actor(req), creativeId: req.params.id, query: req.query || {} })),
    getHealth: ok(200, "Advertising execution readiness retrieved", (req) => service.health(req.query || {})),
    getLifecycle: ok(200, "Advertising execution lifecycle retrieved", () => service.lifecycle()),
    preflight: ok(200, "Advertising execution preflight completed", (req) => service.preflight(req.body || {})),
    createCreativeRevision: ok(201, "Creative publication revision validated and created", (req) => service.createCreativePublication({ actor: actor(req), creativeId: requestPayload(req).creativeAssetId, input: requestPayload(req), media: req.file })),
    getCreativePublication: ok(200, "Creative publication retrieved", (req) => service.getCreativePublication({ actor: actor(req), id: req.params.id })),
    syncCreativeReview: ok(200, "Creative review synchronized", (req) => service.syncCreativeReview({ actor: actor(req), id: req.params.id })),
    getRunStatus: ok(200, "Advertising execution run retrieved", (req) => service.getRun({ id: req.params.runId })),
    reviewDeadLetter: ok(200, "Dead-letter review recorded", (req) => service.reviewDeadLetter({ actor: actor(req), jobId: req.params.jobId, input: req.body || {} })),
    getReconciliationStatus: ok(200, "Reconciliation status retrieved", (req) => service.getReconciliationStatus({ id: req.params.id })),
    createCompensationDraft: ok(201, "Compensation draft created", (req) => service.createCompensationDraft({ actor: actor(req), planId: req.body?.originalPlanId, input: req.body || {} })),
  };
}

module.exports = createExecutionController();
module.exports.createExecutionController = createExecutionController;
module.exports.requestPayload = requestPayload;
