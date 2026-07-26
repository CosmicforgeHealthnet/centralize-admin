const { sanitizeBoundedJson } = require("../intelligence/validation-security");
const { sanitizeExecutionEvent } = require("./execution.observability");

function mapPlanSummary(plan) {
  if (!plan) return null;
  return Object.freeze({
    id: plan.id, planNumber: plan.planNumber, sourceType: plan.sourceType,
    platform: plan.platform, connectionId: plan.connectionId,
    accountExternalId: plan.accountExternalId, name: plan.name, status: plan.status,
    version: plan.version, currencyCode: plan.currencyCode,
    validatedAt: plan.validatedAt || null, expiresAt: plan.expiresAt || null,
    itemCount: plan._count?.items ?? plan.items?.length, approvalCount: plan._count?.approvals ?? plan.approvals?.length,
    latestRun: plan.runs?.[0] ? { id: plan.runs[0].id, status: plan.runs[0].status, createdAt: plan.runs[0].createdAt } : null,
    validation: plan.validationPackets?.[0] ? { valid: plan.validationPackets[0].valid, expiresAt: plan.validationPackets[0].expiresAt, issueCount: plan.validationPackets[0].issueCount, warningCount: plan.validationPackets[0].warningCount } : null,
    createdAt: plan.createdAt, updatedAt: plan.updatedAt,
  });
}

function mapApproval(approval) {
  if (!approval) return null;
  const events = (approval.events || []).map((event) => ({ id: event.id, decision: event.decision, reason: event.reason || null, decidedAt: event.decidedAt }));
  const currentDecision = events.at(-1)?.decision || approval.decision;
  return Object.freeze({ id: approval.id, planVersion: approval.planVersion, validationFingerprint: approval.validationFingerprint, decision: currentDecision, approverAdminUserId: approval.approverAdminUserId, reason: approval.reason || null, decidedAt: approval.decidedAt, events });
}

function mapPlanDetail(plan) {
  if (!plan) return null;
  const currentIssues = (plan.validationIssues || []).filter((issue) => issue.planVersion === plan.version && issue.validationFingerprint === plan.validationFingerprint).map((issue) => ({ id: issue.id, severity: issue.severity, code: issue.code, fieldPath: issue.fieldPath, message: issue.message, providerCode: issue.providerCode || null }));
  return Object.freeze({ ...mapPlanSummary(plan), description: plan.description || null, desiredState: sanitizeExecutionEvent(plan.desiredState), validationFingerprint: plan.validationFingerprint || null, items: (plan.items || []).map((item) => ({ id: item.id, sequence: item.sequence, operationType: item.operationType, resourceType: item.resourceType, providerResourceId: item.providerResourceId || null, clientReference: item.clientReference, dependsOnItemIds: item.dependsOnItemIds, intent: sanitizeExecutionEvent(item.intent), beforeState: item.beforeState == null ? null : sanitizeExecutionEvent(item.beforeState), materialHash: item.materialHash, status: item.status })), validationPackets: (plan.validationPackets || []).map((packet) => ({ id: packet.id, planVersion: packet.planVersion, validationFingerprint: packet.validationFingerprint, valid: packet.valid, providerApiVersion: packet.providerApiVersion, beforeStateHash: packet.beforeStateHash, budgetExposure: String(packet.budgetExposure), activationExposure: packet.activationExposure, issueCount: packet.issueCount, warningCount: packet.warningCount, expiresAt: packet.expiresAt, createdAt: packet.createdAt })), currentValidationIssues: currentIssues, historicalValidationIssueCount: Math.max(0, (plan.validationIssues || []).length - currentIssues.length), approvals: (plan.approvals || []).map(mapApproval), runs: (plan.runs || []).map((run) => ({ id: run.id, status: run.status, trigger: run.trigger, createdAt: run.createdAt, completedAt: run.completedAt || null })), compensation: { originals: (plan.originalCompensations || []).map((link) => ({ id: link.id, originalPlanId: link.originalPlanId, originalRunId: link.originalRunId, originalOperationId: link.originalOperationId })), links: (plan.compensationLinks || []).map((link) => ({ id: link.id, compensationPlanId: link.compensationPlanId, compensationRunId: link.compensationRunId || null })) } });
}

function mapPolicy(policy) { if (!policy) return null; return Object.freeze({ id: policy.id, scope: policy.scope, platform: policy.platform || null, connectionId: policy.connectionId || null, key: policy.key, valueType: policy.valueType, value: sanitizeExecutionEvent(policy.value), enabled: policy.enabled, version: policy.version, effectiveSource: policy.effectiveSource || null, latestHistory: policy.history?.[0] ? sanitizeExecutionEvent({ version: policy.history[0].version, previousVersion: policy.history[0].previousVersion, previousValue: policy.history[0].previousValue, previousEnabled: policy.history[0].previousEnabled, newVersion: policy.history[0].newVersion, newValue: policy.history[0].newValue, newEnabled: policy.history[0].newEnabled, behaviorChanged: policy.history[0].behaviorChanged, changedFields: policy.history[0].changedFields, effectiveScope: policy.history[0].effectiveScope, correlationId: policy.history[0].correlationId, reason: policy.history[0].reason, createdAt: policy.history[0].createdAt }) : null, createdAt: policy.createdAt, updatedAt: policy.updatedAt }); }

function mapJobSummary(job) {
  if (!job) return null;
  return Object.freeze({
    id: job.id, runId: job.runId, platform: job.platform,
    connectionId: job.connectionId, accountExternalId: job.accountExternalId,
    status: job.status, attemptCount: job.attemptCount,
    nextAttemptAt: job.nextAttemptAt || null, recoveryOutcome: job.recoveryOutcome || null,
    reconciliationRequired: job.reconciliationRequired === true,
    completedAt: job.completedAt || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
  });
}

function mapOperationSummary(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id, itemId: operation.itemId, status: operation.status,
    safeToRetry: operation.safeToRetry === true, outcomeCertainty: operation.outcomeCertainty,
    nativeResourceId: operation.nativeResourceId || null,
    nativeResourceName: operation.nativeResourceName || null,
    providerRequestId: operation.providerRequestId || null, normalizedResult: operation.normalizedResult == null ? null : sanitizeBoundedJson(operation.normalizedResult),
    createdAt: operation.createdAt, updatedAt: operation.updatedAt,
  });
}

function mapOperationDetail(operation) { if (!operation) return null; return Object.freeze({ ...mapOperationSummary(operation), runId: operation.runId, providerOperationKey: operation.providerOperationKey, counts: operation._count ? { attempts: operation._count.attempts, snapshots: operation._count.snapshots, reconciliations: operation._count.reconciliations, retryReviews: operation._count.retryReviews } : null, item: operation.item ? { id: operation.item.id, operationType: operation.item.operationType, resourceType: operation.item.resourceType, dependsOnItemIds: operation.item.dependsOnItemIds } : null, attempts: (operation.attempts || []).map((attempt) => ({ id: attempt.id, number: attempt.number, errorCode: attempt.errorCode || null, errorCategory: attempt.errorCategory || null, retryAfterAt: attempt.retryAfterAt || null, retryDecision: sanitizeExecutionEvent(attempt.retryDecision), startedAt: attempt.startedAt, completedAt: attempt.completedAt || null })), snapshots: (operation.snapshots || []).map((snapshot) => ({ id: snapshot.id, kind: snapshot.kind, sequence: snapshot.sequence, hash: snapshot.hash, capturedAt: snapshot.capturedAt })), reconciliations: (operation.reconciliations || []).map(mapDrift), retryReviews: (operation.retryReviews || []).map((review) => ({ id: review.id, reason: review.reason, decision: review.decision, actionJobId: review.actionJobId || null, createdAt: review.createdAt })) }); }

function mapDrift(entry) { if (!entry) return null; return Object.freeze({ id: entry.id, runId: entry.runId, operationId: entry.operationId, status: entry.status, classification: entry.status, differences: sanitizeExecutionEvent(entry.differences || []), previousVerifiedHash: entry.previousVerifiedHash || null, currentHash: entry.currentHash || null, providerVersion: entry.providerVersion || null, externalActor: entry.externalActor || null, checkedAt: entry.checkedAt, acknowledged: Boolean(entry.acknowledgments?.length), acknowledgments: (entry.acknowledgments || []).map((ack) => ({ id: ack.id, reason: ack.reason, acknowledgedByAdminUserId: ack.acknowledgedByAdminUserId, createdAt: ack.createdAt })) }); }

function mapRun(run) {
  if (!run) return null;
  return Object.freeze({
    id: run.id, planId: run.planId, status: run.status, trigger: run.trigger,
    provider: run.plan?.platform || null, connectionId: run.plan?.connectionId || null, accountExternalId: run.plan?.accountExternalId || null,
    approvalFingerprint: run.approvalFingerprint, submissionIdentity: run.submissionKey,
    approvedPlanVersion: run.approvedPlanVersion, startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    summary: run.summary == null ? null : sanitizeBoundedJson(run.summary), counts: run._count ? sanitizeExecutionEvent(run._count) : null,
    jobs: (run.jobs || []).map(mapJobSummary),
    operations: (run.operations || []).map((operation) => operation.attempts || operation.snapshots || operation.reconciliations ? mapOperationDetail(operation) : mapOperationSummary(operation)),
    reconciliations: (run.reconciliations || []).map((entry) => Object.freeze({
      id: entry.id, operationId: entry.operationId, status: entry.status,
      differences: sanitizeBoundedJson(entry.differences || []), checkedAt: entry.checkedAt,
      previousVerifiedHash: entry.previousVerifiedHash || null, currentHash: entry.currentHash || null,
    })),
    reconciliationJobs: (run.reconciliationJobs || []).map(mapReconciliationJob),
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  });
}

function mapReconciliationJob(job) {
  if (!job) return null;
  return Object.freeze({
    id: job.id, operationId: job.operationId, runId: job.runId, planId: job.planId,
    reason: job.reason, status: job.status, attemptCount: job.attemptCount,
    nextAttemptAt: job.nextAttemptAt || null, lastErrorCategory: job.lastErrorCategory || null,
    completedAt: job.completedAt || null, escalatedAt: job.escalatedAt || null,
    operation: mapOperationSummary(job.operation), createdAt: job.createdAt, updatedAt: job.updatedAt,
  });
}

function mapQueueResult(value) {
  return Object.freeze({ planId: value.planId, created: value.created === true, run: mapRun(value.run), job: mapJobSummary(value.job) });
}

function mapDeadLetterResult(value) {
  return Object.freeze({
    review: value.review ? Object.freeze({
      id: value.review.id, jobId: value.review.jobId, status: value.review.status,
      decision: value.review.decision, reason: value.review.reason,
      actionJobId: value.review.actionJobId || null, reviewedAt: value.review.reviewedAt || null,
    }) : null,
    actionJob: mapJobSummary(value.actionJob), compensationPlan: mapPlanSummary(value.compensationPlan),
  });
}

module.exports = { mapPlanSummary, mapPlanDetail, mapApproval, mapPolicy, mapJobSummary, mapOperationSummary, mapOperationDetail, mapDrift, mapRun, mapReconciliationJob, mapQueueResult, mapDeadLetterResult };
