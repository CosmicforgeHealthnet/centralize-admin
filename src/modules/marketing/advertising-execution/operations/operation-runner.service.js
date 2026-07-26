const { operationIdentity, createProviderOperationKey, assertBeforeStateCurrent } = require("./idempotency.service");
const { decideRetry } = require("./retry-policy.service");
const { hashExecutionJson } = require("../execution-json.validator");
const { createNormalizedResult } = require("./normalized-result");
const { normalizeProviderError } = require("../adapters/provider-error-normalizer");

function durationSeconds(started) { return Math.max(0, (Date.now() - started) / 1000); }
function eventName(status) { return status === "SUCCEEDED" ? "OPERATION_SUCCEEDED" : status === "UNKNOWN" ? "OPERATION_UNKNOWN" : "OPERATION_FAILED"; }
function metricName(status) { return status === "SUCCEEDED" ? "operationSuccess" : status === "UNKNOWN" ? "unknownOutcomes" : "operationFailure"; }

function createOperationRunner({ operationRepository, adapterResolver, providerReadRegistry, finalMutationGate, reconciliationRepository, audit, events, metrics } = {}) {
  async function run({ bundle, leaseOwner, lockKey, heartbeat = async () => undefined }) {
    const plan = bundle.run.plan;
    const operations = bundle.run.operations || [];
    const outcomes = [];
    const correlationId = bundle.run.summary?.correlationId || null;
    const recipients = plan.createdByAdminUserId ? [plan.createdByAdminUserId] : [];
    for (const operation of operations.sort((a, b) => a.item.sequence - b.item.sequence)) {
      if (!["READY", "RETRY_SCHEDULED"].includes(operation.status)) continue;
      const common = { correlationId, planId: plan.id, runId: bundle.run.id, jobId: bundle.id, operationId: operation.id, provider: plan.platform, resourceType: operation.item.resourceType, operationType: operation.item.operationType };
      const failedDependency = (operation.item.dependsOnItemIds || []).some((id) => outcomes.some((outcome) => outcome.itemId === id && !["SUCCEEDED", "VERIFIED"].includes(outcome.status)));
      if (failedDependency) {
        const result = createNormalizedResult({ status: "FAILED", retryable: false, outcomeCertain: true, error: { code: "DEPENDENCY_NOT_SUCCESSFUL", category: "PRECONDITION", message: "A required predecessor operation did not succeed", retryable: false }, returnedState: {} });
        await operationRepository.persistResult({ id: operation.id, expectedStatus: operation.status, status: "FAILED", safeToRetry: false, outcomeCertainty: "KNOWN_FAILURE", result });
        await events?.emit("OPERATION_FAILED", { ...common, resultCategory: "PRECONDITION", retryable: false, outcomeCertainty: "KNOWN_FAILURE", duration: 0 }, recipients);
        metrics?.increment("operationFailure", 1, { provider: plan.platform, operationType: operation.item.operationType, resourceType: operation.item.resourceType, resultCategory: "PRECONDITION" });
        outcomes.push({ operationId: operation.id, itemId: operation.itemId, status: "FAILED", reason: "DEPENDENCY_NOT_SUCCESSFUL" });
        continue;
      }
      await heartbeat();
      const identity = operationIdentity({ version: 2, provider: plan.platform, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId, approvedPlanId: plan.id, approvedPlanVersion: bundle.run.approvedPlanVersion, itemId: operation.itemId, operationType: operation.item.operationType, resourceType: operation.item.resourceType, materialHash: operation.item.materialHash });
      const key = createProviderOperationKey(identity);
      const reader = providerReadRegistry.resolve(plan.platform);
      const readStarted = Date.now();
      let currentState;
      try { currentState = await reader.readResource({ plan, operation, mutation: false }); }
      catch (error) { throw normalizeProviderError(error, { provider: plan.platform, operationId: operation.id }); }
      finally { metrics?.observe("providerReadLatency", durationSeconds(readStarted), { provider: plan.platform }); }
      const beforeSnapshot = operation.snapshots?.filter((snapshot) => snapshot.kind === "BEFORE").sort((a, b) => b.sequence - a.sequence)[0];
      const approvedHash = beforeSnapshot?.hash || (operation.item.beforeState ? hashExecutionJson(operation.item.beforeState, "beforeState").hash : hashExecutionJson(currentState, "beforeState").hash);
      assertBeforeStateCurrent({ approvedHash, currentState });
      const attemptNumber = (operation.attempts?.[0]?.number || 0) + 1;
      const attempt = await operationRepository.createAttempt({ operationId: operation.id, number: attemptNumber });
      metrics?.increment("operationAttempts", 1, { provider: plan.platform, operationType: operation.item.operationType, resourceType: operation.item.resourceType });
      const started = Date.now();
      let result;
      try {
        const executionContext = await finalMutationGate.assert({ bundle, operation, leaseOwner, lockKey, idempotencyKey: key, currentState, businessPolicyValid: true, capabilityValid: true, currencyValid: true, budgetValid: true, scheduleValid: true, creativeReviewValid: true, targetingValid: true, beforeStateValid: true });
        await events?.emit("OPERATION_STARTED", { ...common, attempt: attemptNumber }, recipients);
        await audit?.event({ actorId: null, action: "PROVIDER_OPERATION_ATTEMPTED", targetId: operation.id, targetType: "marketing_provider_operation", metadata: { ...common, attempt: attemptNumber, phase: "BEFORE_PROVIDER_CALL" } });
        const adapter = await adapterResolver({ provider: plan.platform, connectionId: plan.connectionId });
        result = await adapter.executeOperation({ operation: { ...operation, operationType: operation.item.operationType, resourceType: operation.item.resourceType, transportInstruction: operation.item.intent, executionContext }, idempotencyKey: key, expectedState: currentState });
      } catch (error) {
        const normalized = normalizeProviderError(error, { provider: plan.platform, operationId: operation.id });
        const status = normalized.outcomeCertain === false ? "UNKNOWN" : "FAILED";
        const retry = decideRetry({ category: normalized.category, statusCode: normalized.statusCode, providerProcessing: normalized.providerProcessing, outcomeCertain: normalized.outcomeCertain, retryAfterAt: normalized.retryAfterAt, attempt: attemptNumber });
        result = createNormalizedResult({ status, retryable: retry.automaticRetry, outcomeCertain: status !== "UNKNOWN", error: { code: normalized.code || "PROVIDER_OPERATION_FAILED", category: normalized.category || "PROVIDER", message: normalized.message, retryable: retry.automaticRetry, retryAfterAt: normalized.retryAfterAt }, returnedState: {} });
      }

      const status = result.status === "SUCCEEDED" ? "SUCCEEDED" : result.status === "UNKNOWN" ? "UNKNOWN" : "FAILED";
      const retry = result.error ? decideRetry({ category: result.error.category, statusCode: result.error.statusCode, providerProcessing: status === "UNKNOWN" ? "UNKNOWN" : "NOT_STARTED", outcomeCertain: result.outcomeCertain, retryAfterAt: result.error.retryAfterAt, attempt: attemptNumber }) : { automaticRetry: false, action: "VERIFY" };
      await operationRepository.completeAttempt({ id: attempt.id, errorCode: result.error?.code, errorCategory: result.error?.category, retryAfterAt: result.error?.retryAfterAt, normalizedError: result.error ? { ...result.error, providerProcessing: status === "UNKNOWN" ? "UNKNOWN" : "NOT_STARTED" } : null, retryDecision: retry });
      try {
        await operationRepository.persistResult({ id: operation.id, expectedStatus: operation.status, status, safeToRetry: Boolean(retry.automaticRetry), outcomeCertainty: status === "SUCCEEDED" ? "KNOWN_SUCCESS" : status === "FAILED" ? "KNOWN_FAILURE" : "UNKNOWN", result });
      } catch (error) {
        try { await reconciliationRepository.enqueue({ operationId: operation.id, runId: bundle.run.id, planId: plan.id, reason: "PROVIDER_SUCCESS_LOCAL_PERSISTENCE_FAILED", providerIdentity: { providerRequestId: result.providerRequestId, nativeResourceId: result.nativeResourceId, idempotencyKey: key }, priority: 100 }); } catch (_recoveryError) { /* durable attempt remains recovery evidence */ }
        await events?.emit("LOCAL_PERSISTENCE_FAILURE", { ...common, resultCategory: "PERSISTENCE", attempt: attemptNumber }, recipients);
        await events?.emit("OPERATION_FAILED", { ...common, resultCategory: "PERSISTENCE", attempt: attemptNumber, duration: durationSeconds(started), providerResultKnown: result.outcomeCertain }, recipients);
        metrics?.increment("localPersistenceRecovery", 1, { provider: plan.platform });
        error.category = "PERSISTENCE"; error.localPersistenceFailed = true; error.outcomeCertain = result.outcomeCertain; error.providerProcessing = "COMPLETED"; throw error;
      }

      let reconciliation = null;
      if (status === "UNKNOWN") reconciliation = await reconciliationRepository.enqueue({ operationId: operation.id, runId: bundle.run.id, planId: plan.id, reason: "UNKNOWN_PROVIDER_OUTCOME", providerIdentity: { providerRequestId: result.providerRequestId, nativeResourceId: result.nativeResourceId, idempotencyKey: key }, priority: 100 });
      else if (status === "SUCCEEDED") reconciliation = await reconciliationRepository.enqueue({ operationId: operation.id, runId: bundle.run.id, planId: plan.id, reason: plan.sourceType === "ROLLBACK" ? "COMPENSATION_VERIFICATION" : "POST_WRITE_VERIFICATION", providerIdentity: { providerRequestId: result.providerRequestId, nativeResourceId: result.nativeResourceId, idempotencyKey: key }, priority: 50 });
      const duration = durationSeconds(started);
      await audit?.event({ actorId: null, action: "PROVIDER_OPERATION_ATTEMPTED", targetId: operation.id, targetType: "marketing_provider_operation", metadata: { ...common, attempt: attemptNumber, phase: "DURABLE_RESULT", status, duration, retryable: Boolean(retry.automaticRetry), outcomeCertainty: status === "UNKNOWN" ? "UNKNOWN" : status === "SUCCEEDED" ? "KNOWN_SUCCESS" : "KNOWN_FAILURE", providerRequestId: result.providerRequestId } });
      await events?.emit(eventName(status), { ...common, attempt: attemptNumber, duration, providerRequestId: result.providerRequestId, retryable: Boolean(retry.automaticRetry), resultCategory: result.error?.category || "SUCCESS", outcomeCertainty: status === "UNKNOWN" ? "UNKNOWN" : status === "SUCCEEDED" ? "KNOWN_SUCCESS" : "KNOWN_FAILURE", reconciliationId: reconciliation?.id || null }, recipients);
      metrics?.increment(metricName(status), 1, { provider: plan.platform, operationType: operation.item.operationType, resourceType: operation.item.resourceType, resultCategory: result.error?.category || "SUCCESS" });
      metrics?.observe("providerWriteLatency", duration, { provider: plan.platform, operationType: operation.item.operationType, resourceType: operation.item.resourceType });
      if (result.error?.category === "RATE_LIMIT") metrics?.increment("providerRateLimits", 1, { provider: plan.platform });
      if (reconciliation) await events?.emit("RECONCILIATION_QUEUED", { ...common, reconciliationId: reconciliation.id, reason: status === "UNKNOWN" ? "UNKNOWN_PROVIDER_OUTCOME" : plan.sourceType === "ROLLBACK" ? "COMPENSATION_VERIFICATION" : "POST_WRITE_VERIFICATION" }, recipients);
      outcomes.push({ operationId: operation.id, itemId: operation.itemId, status, retry });
      if (status === "UNKNOWN") break;
    }
    const status = outcomes.some((item) => item.status === "UNKNOWN") ? "RECONCILING" : outcomes.length > 0 && outcomes.every((item) => item.status === "SUCCEEDED") ? "SUCCEEDED" : outcomes.some((item) => item.status === "SUCCEEDED") ? "PARTIAL_SUCCESS" : "FAILED";
    if (status === "PARTIAL_SUCCESS") metrics?.increment("partialSuccess", 1, { provider: plan.platform });
    return { status, outcomes };
  }
  return Object.freeze({ run, persistsAttemptsBeforeProviderCalls: true });
}
module.exports = { createOperationRunner };
