const crypto = require("crypto");
const { prisma } = require("../../../../shared/config/database");
const { readExecutionConfig } = require("../execution.config");
const { executionError } = require("../execution.errors");
const { canonicalJson } = require("../execution-json.validator");
const { sanitizeExecutionEvent } = require("../execution.observability");
const { assertApprovalIntegrity } = require("../validation/approval-integrity.service");
const { assertBeforeStateCurrent } = require("./idempotency.service");
const { ExecutionJobRepository } = require("../jobs/execution-job.repository");
const { normalizeProviderError } = require("../adapters/provider-error-normalizer");

const RETRYABLE_CATEGORIES = new Set(["RATE_LIMIT", "TRANSIENT", "NETWORK"]);
const TERMINAL_CHILD_STATES = new Set(["SUCCEEDED", "VERIFIED"]);

function retryIdentity(operation) {
  const latestAttempt = operation.attempts?.[0];
  return crypto.createHash("sha256").update(canonicalJson({
    version: 1,
    operationId: operation.id,
    runId: operation.runId,
    planVersion: operation.run.approvedPlanVersion,
    approvalFingerprint: operation.run.approvalFingerprint,
    failedAttemptNumber: latestAttempt?.number || 0,
  })).digest("hex");
}

function assertDependencySafety(operation) {
  const operations = operation.run.operations || [];
  const required = new Set(operation.item.dependsOnItemIds || []);
  const incompleteRequired = operations.filter((candidate) => required.has(candidate.itemId) && !TERMINAL_CHILD_STATES.has(candidate.status));
  if (incompleteRequired.length) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "RETRY_DEPENDENCY_NOT_SUCCESSFUL" });
  const completedChildren = operations.filter((candidate) => candidate.id !== operation.id && (candidate.item.dependsOnItemIds || []).includes(operation.itemId) && TERMINAL_CHILD_STATES.has(candidate.status));
  if (completedChildren.length) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "RETRY_WOULD_INVALIDATE_COMPLETED_DEPENDENCY" });
}

function assertRetryDatabaseEligibility(operation, now) {
  if (!operation) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "OPERATION_NOT_FOUND" });
  if (operation.status === "UNKNOWN" || operation.outcomeCertainty === "UNKNOWN") throw executionError("EXECUTION_OUTCOME_UNKNOWN", { operationId: operation.id, reconciliationRequired: true });
  if (operation.status !== "FAILED" || operation.outcomeCertainty !== "KNOWN_FAILURE") throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "OPERATION_NOT_KNOWN_FAILED" });
  const category = String(operation.attempts?.[0]?.errorCategory || "").toUpperCase();
  if (!RETRYABLE_CATEGORIES.has(category)) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: `RETRY_BLOCKED_${category || "MISSING_CATEGORY"}` });
  const normalizedError = operation.attempts?.[0]?.normalizedError || {};
  if (normalizedError.providerProcessing && normalizedError.providerProcessing !== "NOT_STARTED") throw executionError("EXECUTION_OUTCOME_UNKNOWN", { reasonCode: "PROVIDER_PROCESSING_MAY_HAVE_STARTED", reconciliationRequired: true });
  const plan = operation.run.plan;
  const packet = plan.validationPackets?.[0];
  assertApprovalIntegrity({ plan, run: operation.run, approvals: plan.approvals, now });
  if (!packet || !packet.valid || packet.planVersion !== plan.version || packet.validationFingerprint !== plan.validationFingerprint || packet.expiresAt <= now) {
    throw executionError("STALE_VALIDATION_FINGERPRINT", { reasonCode: "CURRENT_VALIDATION_PACKET_REQUIRED" });
  }
  assertDependencySafety(operation);
  return { category, packet };
}

function accountState(connection) {
  const metadata = connection?.connectionMetadata || {};
  return {
    status: connection?.status,
    validationStatus: connection?.validationStatus,
    accountRole: metadata.accountRole,
    oauthScopes: Array.isArray(metadata.oauthScopes) ? metadata.oauthScopes : [],
    accessTier: metadata.accessTier,
    editReady: metadata.editReady === true,
    pageIdentityReady: metadata.pageIdentityReady === true,
    instagramIdentityReady: metadata.instagramIdentityReady === true,
    sparkAuthorized: metadata.sparkAuthorized === true,
    placementAllowlisted: metadata.placementAllowlisted === true,
    fundingInstrumentReady: metadata.fundingInstrumentReady === true,
  };
}

function operationInclude() {
  return {
    attempts: { orderBy: { number: "desc" }, take: 1 },
    snapshots: { orderBy: { sequence: "desc" } },
    item: true,
    run: {
      include: {
        operations: { include: { item: true } },
        plan: {
          include: {
            connection: true,
            approvals: { include: { events: { orderBy: { decidedAt: "asc" } } } },
            validationPackets: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        },
      },
    },
  };
}

function createRetryReviewService({ client = prisma, env = process.env, adapterRegistry, providerReadRegistry, connectionPolicyResolver, audit, events, metrics, failureInjector = null, now = () => new Date() } = {}) {
  async function inject(point, context) { if (failureInjector) await failureInjector(point, context); }

  async function schedule({ operationId, actor, reason, correlationId = null }) {
    if (!actor?.id) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "AUTHENTICATED_ACTOR_REQUIRED" });
    const operation = await client.marketingProviderOperation.findUnique({ where: { id: operationId }, include: operationInclude() });
    const idempotencyKey = operation ? retryIdentity(operation) : null;
    if (operation?.status === "RETRY_SCHEDULED" && idempotencyKey) {
      const existing = await client.marketingExecutionRetryReview.findUnique({ where: { idempotencyKey } });
      if (existing) return { reviewId: existing.id, jobId: existing.actionJobId, runId: operation.runId, created: false };
    }
    assertRetryDatabaseEligibility(operation, now());
    const plan = operation.run.plan;
    const config = readExecutionConfig(env);
    if (!config.enabled || config.dryRun || !config.workerEnabled || !config.providers[plan.platform]) throw executionError("AD_EXECUTION_DISABLED", { reasonCode: "RETRY_EXECUTION_GATE_DISABLED" });
    if (!await connectionPolicyResolver({ platform: plan.platform, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId })) throw executionError("AD_EXECUTION_DISABLED", { reasonCode: "RETRY_CONNECTION_WRITE_GATE_DISABLED" });

    const capability = await adapterRegistry.get(plan.platform).getCapabilities({
      connection: plan.connection,
      accountExternalId: plan.accountExternalId,
      accountState: accountState(plan.connection),
      operationType: operation.item.operationType,
      resourceType: operation.item.resourceType,
    });
    if (capability.configurationReady !== true || capability.operationSupported !== true || capability.permissionReady !== true) throw executionError("EXECUTION_CAPABILITY_UNAVAILABLE", { reasonCode: "RETRY_CAPABILITY_OR_PERMISSION_UNAVAILABLE" });

    let currentState;
    try {
      currentState = await providerReadRegistry.resolve(plan.platform).readResource({ plan, operation, mutation: false });
    } catch (error) {
      throw normalizeProviderError(error, { provider: plan.platform, operationId });
    }
    const before = operation.snapshots.find((snapshot) => snapshot.kind === "BEFORE");
    assertBeforeStateCurrent({ approvedHash: before?.hash, currentState });
    const execute = () => client.$transaction(async (tx) => {
      if (typeof tx.$queryRawUnsafe === "function") await tx.$queryRawUnsafe("SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) AS guard", String(operationId));
      const locked = await tx.marketingProviderOperation.findUnique({ where: { id: operationId }, include: operationInclude() });
      const existing = await tx.marketingExecutionRetryReview.findUnique({ where: { idempotencyKey } });
      if (existing) return { review: existing, jobId: existing.actionJobId, runId: locked.runId, platform: locked.run.plan.platform, created: false };
      assertRetryDatabaseEligibility(locked, now());
      if (retryIdentity(locked) !== idempotencyKey) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "FAILED_ATTEMPT_CHANGED" });
      await inject("before-retry-job", { operation: locked });
      const jobRepository = new ExecutionJobRepository({ client: tx, now });
      const job = await jobRepository.create({ runId: locked.runId, connectionId: locked.run.plan.connectionId, platform: locked.run.plan.platform, accountExternalId: locked.run.plan.accountExternalId, purpose: `RETRY:${operationId}:${locked.attempts[0].number}`, priority: 10 });
      await inject("after-retry-job", { operation: locked, job });
      const review = await tx.marketingExecutionRetryReview.create({ data: { operationId, reviewedByAdminUserId: actor.id, reason, decision: "RETRY_SCHEDULED", idempotencyKey, actionJobId: job.id } });
      await tx.marketingProviderOperation.update({ where: { id: operationId }, data: { status: "RETRY_SCHEDULED", safeToRetry: false } });
      await tx.marketingExecutionRun.updateMany({ where: { id: locked.runId, status: "FAILED" }, data: { status: "QUEUED", completedAt: null } });
      await inject("before-retry-audit", { operation: locked, job, review });
      await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_OPERATION_RETRY_REVIEWED", targetId: operationId, targetType: "marketing_provider_operation", metadata: sanitizeExecutionEvent({ correlationId, reason, decision: "RETRY_SCHEDULED", actionJobId: job.id, failedAttemptNumber: locked.attempts[0].number, providerBeforeStateHash: before.hash }) } });
      await inject("before-retry-commit", { operation: locked, job, review });
      return { review, jobId: job.id, runId: locked.runId, platform: locked.run.plan.platform, created: true };
    }, { isolationLevel: "Serializable" });

    let result;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { result = await execute(); break; }
      catch (error) { if (error?.code !== "P2034" || attempt === 3) throw error; }
    }
    if (result.created) {
      metrics?.increment("operationRetries", 1, { provider: result.platform });
      await events?.emit("OPERATION_RETRY_SCHEDULED", { correlationId, operationId, runId: result.runId, jobId: result.jobId, reason }, [actor.id]);
    } else metrics?.increment("idempotentDuplicateRecovery", 1, { provider: result.platform });
    return { reviewId: result.review.id, jobId: result.jobId, runId: result.runId, created: result.created };
  }

  return Object.freeze({ schedule });
}

module.exports = { RETRYABLE_CATEGORIES, retryIdentity, assertDependencySafety, assertRetryDatabaseEligibility, createRetryReviewService };
