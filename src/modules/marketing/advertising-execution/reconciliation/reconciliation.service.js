const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { canonicalJson, hashExecutionJson, sanitizeExecutionJson } = require("../execution-json.validator");
const { PlanRepository } = require("../plans/plan.repository");

function normalizeMaterial(value) {
  if (Array.isArray(value)) return value.map(normalizeMaterial).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalizeMaterial(child)]));
  if (typeof value === "string" && /^https:\/\//i.test(value)) { try { const url = new URL(value); url.hash = ""; url.searchParams.sort(); return url.toString(); } catch (_error) { return value; } }
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value).toString();
  return value;
}
function compareMaterialState(desired, actual, { maxDifferences = 100 } = {}) {
  const differences = [];
  function visit(expected, observed, path) {
    if (differences.length >= maxDifferences) return;
    if (canonicalJson(normalizeMaterial(expected)) === canonicalJson(normalizeMaterial(observed))) return;
    if (expected && observed && typeof expected === "object" && typeof observed === "object" && !Array.isArray(expected) && !Array.isArray(observed)) {
      for (const key of new Set([...Object.keys(expected), ...Object.keys(observed)])) visit(expected[key], observed[key], path ? `${path}.${key}` : key);
    } else differences.push({ field: path, desired: expected ?? null, actual: observed ?? null });
  }
  visit(desired, actual, ""); return differences;
}
function classifyReconciliation({ desired, current, previousVerifiedHash }) {
  if (!current) return { status: "UNKNOWN", differences: [{ field: "resource", reason: "READ_BACK_UNAVAILABLE" }] };
  const differences = compareMaterialState(desired, current); const currentHash = hashExecutionJson(normalizeMaterial(current), "normalizedState").hash;
  if (!differences.length) return { status: "VERIFIED", differences, currentHash };
  if (previousVerifiedHash && previousVerifiedHash !== currentHash) return { status: "EXTERNAL_CHANGE", differences, currentHash, previousVerifiedHash };
  return { status: "DRIFTED", differences, currentHash };
}

function createReconciliationService({ client = prisma, planRepository = new PlanRepository({ client }), audit, events } = {}) {
  async function reconcile({ bundle, currentState, providerVersion, externalActor }) {
    const operation = bundle.operation || bundle; const run = operation.run || bundle.run; const plan = run.plan || bundle.plan;
    const desiredSnapshot = operation.snapshots?.filter((snapshot) => snapshot.kind === "DESIRED").sort((a, b) => b.sequence - a.sequence)[0];
    const previousAfter = operation.snapshots?.filter((snapshot) => snapshot.kind === "AFTER").sort((a, b) => b.sequence - a.sequence)[0];
    const desired = desiredSnapshot?.normalizedState || operation.item?.intent || {};
    const classification = classifyReconciliation({ desired, current: currentState, previousVerifiedHash: previousAfter?.hash || null });
    const current = currentState ? sanitizeExecutionJson(currentState, "normalizedState") : null;
    const result = await client.$transaction(async (tx) => {
      if (current) await tx.marketingExecutionStateSnapshot.create({ data: { operationId: operation.id, kind: "AFTER", sequence: (operation.snapshots?.filter((entry) => entry.kind === "AFTER").length || 0) + 1, normalizedState: current, hash: classification.currentHash, capturedAt: new Date() } });
      const reconciliation = await tx.marketingExecutionReconciliation.create({ data: { runId: run.id, operationId: operation.id, status: classification.status, differences: sanitizeExecutionJson(classification.differences, "differences"), checkedAt: new Date(), previousVerifiedHash: classification.previousVerifiedHash || previousAfter?.hash || null, currentHash: classification.currentHash || null, providerVersion: providerVersion || null, externalActor: externalActor || null } });
      const operationStatus = classification.status === "VERIFIED" ? "VERIFIED" : classification.status === "DRIFTED" || classification.status === "EXTERNAL_CHANGE" ? "DRIFTED" : "UNKNOWN";
      await tx.marketingProviderOperation.update({ where: { id: operation.id }, data: { status: operationStatus, safeToRetry: false, outcomeCertainty: classification.status === "UNKNOWN" ? "UNKNOWN" : operation.outcomeCertainty } });
      const siblings = await tx.marketingProviderOperation.findMany({ where: { runId: run.id }, select: { id: true, status: true } });
      const projected = siblings.map((entry) => entry.id === operation.id ? operationStatus : entry.status);
      const runStatus = projected.every((status) => status === "VERIFIED") ? "SUCCEEDED" : projected.some((status) => status === "UNKNOWN") ? "RECONCILING" : projected.some((status) => ["VERIFIED", "SUCCEEDED"].includes(status)) ? "PARTIAL_SUCCESS" : "FAILED";
      await tx.marketingExecutionRun.update({ where: { id: run.id }, data: { status: runStatus, completedAt: runStatus === "RECONCILING" ? null : new Date() } });
      const planStatus = runStatus === "SUCCEEDED" ? "SUCCEEDED" : runStatus === "PARTIAL_SUCCESS" ? "PARTIAL_SUCCESS" : runStatus === "RECONCILING" ? "EXECUTING" : "FAILED";
      await tx.marketingExecutionPlan.updateMany({ where: { id: plan.id, version: plan.version }, data: { status: planStatus } });
      if (bundle.reason === "COMPENSATION_VERIFICATION" && classification.status === "VERIFIED") {
        const link = await tx.marketingExecutionCompensationLink.findFirst({ where: { compensationRunId: run.id }, include: { compensationRun: { include: { operations: true } } } });
        const projectedCompensationStatuses = link?.compensationRun?.operations?.map((entry) => entry.id === operation.id ? "VERIFIED" : entry.status) || [];
        if (link && projectedCompensationStatuses.length && projectedCompensationStatuses.every((status) => status === "VERIFIED")) {
          await tx.marketingExecutionCompensationLink.update({ where: { id: link.id }, data: { reconciliationId: reconciliation.id, verifiedSafeStateHash: classification.currentHash, compensatedAt: new Date() } });
          await tx.marketingExecutionPlan.update({ where: { id: plan.id }, data: { status: "ROLLED_BACK" } });
        }
      }
      return { reconciliation, operationStatus, runStatus, planStatus };
    });
    if (audit) await audit.event({ actorId: null, action: ["DRIFTED", "EXTERNAL_CHANGE"].includes(classification.status) ? "EXECUTION_DRIFT_DETECTED" : `MARKETING_RECONCILIATION_${classification.status}`, targetId: operation.id, targetType: "marketing_provider_operation", metadata: { correlationId: run.summary?.correlationId || null, operationId: operation.id, runId: run.id, planId: plan.id, status: classification.status, differenceCount: classification.differences.length } });
    if (events) await events.emit(`RECONCILIATION_${classification.status}`, { correlationId: run.summary?.correlationId || null, planId: plan.id, operationId: operation.id, runId: run.id, status: classification.status }, plan.createdByAdminUserId ? [plan.createdByAdminUserId] : []);
    if (bundle.reason === "COMPENSATION_VERIFICATION" && classification.status === "VERIFIED" && events) await events.emit("COMPENSATION_COMPLETED", { correlationId: run.summary?.correlationId || null, operationId: operation.id, runId: run.id, planId: plan.id }, plan.createdByAdminUserId ? [plan.createdByAdminUserId] : []);
    return { ...classification, ...result };
  }

  async function createCompensationDraft({ originalPlanId, originalRunId, originalOperationId, reconciliationId = null, actor, reason, safeAction, proposedValues = null, irreversibleWarning }) {
    if (!actor?.id || !String(reason || "").trim() || !safeAction || !irreversibleWarning) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "COMPENSATION_REQUEST_REQUIRED" });
    if (!["PAUSE", "UPDATE", "DELETE"].includes(safeAction.operationType)) throw executionError("INVALID_EXECUTION_PLAN", { field: "safeAction.operationType", reasonCode: "UNSAFE_COMPENSATION_ACTION" });
    const result = await client.$transaction(async (tx) => {
      if (typeof tx.$queryRawUnsafe === "function") await tx.$queryRawUnsafe("SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS guard", `${originalPlanId}:${originalRunId}:${originalOperationId}:${reconciliationId || "none"}`);
      const originalPlan = await tx.marketingExecutionPlan.findUnique({ where: { id: originalPlanId } });
      if (!originalPlan || !["PARTIAL_SUCCESS", "FAILED", "SUCCEEDED"].includes(originalPlan.status)) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "ELIGIBLE_ORIGINAL_PLAN_REQUIRED" });
      const run = await tx.marketingExecutionRun.findFirst({ where: { id: originalRunId, planId: originalPlan.id } });
      if (!run) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "COMPENSATION_RUN_LINEAGE_MISMATCH" });
      const operation = await tx.marketingProviderOperation.findFirst({ where: { id: originalOperationId, runId: run.id }, include: { item: true, snapshots: { orderBy: [{ kind: "asc" }, { sequence: "desc" }] }, reconciliations: { orderBy: { checkedAt: "desc" } } } });
      if (!operation || operation.item?.planId !== originalPlan.id) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "COMPENSATION_OPERATION_LINEAGE_MISMATCH" });
      if (safeAction.resourceType !== operation.item.resourceType || safeAction.providerResourceId && safeAction.providerResourceId !== operation.item.providerResourceId) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "COMPENSATION_RESOURCE_IDENTITY_MISMATCH" });
      const reconciliation = reconciliationId ? operation.reconciliations.find((entry) => entry.id === reconciliationId) : operation.reconciliations[0] || null;
      if (reconciliationId && !reconciliation) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "COMPENSATION_RECONCILIATION_LINEAGE_MISMATCH" });
      const beforeSnapshot = operation.snapshots.find((entry) => entry.kind === "BEFORE");
      const currentSnapshot = operation.snapshots.filter((entry) => entry.kind === "AFTER").sort((a, b) => b.sequence - a.sequence)[0];
      if (!beforeSnapshot || !currentSnapshot) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "AUTHORITATIVE_COMPENSATION_SNAPSHOTS_REQUIRED" });
      const existing = await tx.marketingExecutionCompensationLink.findFirst({ where: { originalPlanId, originalRunId, originalOperationId, reconciliationId: reconciliation?.id || null, compensationPlan: { status: { in: ["DRAFT", "VALIDATING", "VALIDATED", "PENDING_APPROVAL", "APPROVED", "QUEUED", "EXECUTING"] } } }, include: { compensationPlan: { include: { items: true } } } });
      if (existing) return { plan: existing.compensationPlan, created: false, originalPlan };
      const proposedSafeState = sanitizeExecutionJson(proposedValues || safeAction.intent || beforeSnapshot.normalizedState, "normalizedState");
      const spendAlreadyIncurred = String(run.summary?.spendIncurred || run.summary?.executedExposure || "0.00");
      const desiredState = sanitizeExecutionJson({ compensationFor: { planId: originalPlan.id, runId: run.id, operationId: operation.id, reconciliationId: reconciliation?.id || null }, evidence: { beforeSnapshotId: beforeSnapshot.id, currentSnapshotId: currentSnapshot.id, currentHash: currentSnapshot.hash, reconciliationStatus: reconciliation?.status || null }, proposedSafeState, historyPreserved: true, spendAlreadyIncurred, irreversibleWarning, authorReviewRequired: true }, "desiredState");
      const repository = new PlanRepository({ client: tx });
      const plan = await repository.create({ sourceType: "ROLLBACK", platform: originalPlan.platform, connectionId: originalPlan.connectionId, accountExternalId: originalPlan.accountExternalId, currencyCode: originalPlan.currencyCode, name: `Compensation for ${originalPlan.planNumber || originalPlan.id}`, description: "Human-authored compensation draft; normal validation and approval required.", desiredState, createdByAdminUserId: actor.id, updatedByAdminUserId: actor.id, items: [{ sequence: 0, operationType: safeAction.operationType, resourceType: safeAction.resourceType, providerResourceId: operation.item.providerResourceId, clientReference: "compensation-1", dependsOnItemIds: [], intent: proposedSafeState, beforeState: currentSnapshot.normalizedState }] });
      await tx.marketingExecutionCompensationLink.create({ data: { originalPlanId: originalPlan.id, originalRunId: run.id, originalOperationId: operation.id, reconciliationId: reconciliation?.id || null, compensationPlanId: plan.id, authoredByAdminUserId: actor.id, reason: String(reason).trim(), currentProviderState: sanitizeExecutionJson(currentSnapshot.normalizedState, "normalizedState"), proposedSafeState, irreversibleWarning: String(irreversibleWarning).slice(0, 2000), spendAlreadyIncurred } });
      await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_COMPENSATION_CREATED", targetId: plan.id, targetType: "marketing_execution_plan", metadata: sanitizeExecutionJson({ correlationId: actor.correlationId, originalPlanId: originalPlan.id, originalRunId: run.id, originalOperationId: operation.id, reconciliationId: reconciliation?.id || null, compensationPlanId: plan.id }, "summary") } });
      return { plan, created: true, originalPlan };
    }, { isolationLevel: "Serializable" });
    if (result.created) await events?.emit("COMPENSATION_DRAFT_CREATED", { correlationId: actor.correlationId, planId: result.plan.id, originalPlanId, originalRunId, originalOperationId, actorId: actor.id }, [result.originalPlan.createdByAdminUserId]);
    return result.plan;
  }
  return Object.freeze({ reconcile, createCompensationDraft });
}
module.exports = { normalizeMaterial, compareMaterialState, classifyReconciliation, createReconciliationService };
