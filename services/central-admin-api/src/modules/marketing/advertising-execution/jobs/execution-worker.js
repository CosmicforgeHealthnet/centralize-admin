const { readExecutionConfig } = require("../execution.config");
const { executionError } = require("../execution.errors");
const { decideRetry } = require("../operations/retry-policy.service");

function createExecutionWorker({ env = process.env, jobRepository, accountLockRepository, connectionGate = async () => false, executeBundle, recoverExpiredLeases, audit, events, metrics, pollIntervalMs = 2000 } = {}) {
  let started = false; let stopping = false; let inFlight = null; let timer = null;
  function currentConfig() {
    const config = readExecutionConfig(env);
    if (stopping || !config.enabled || !config.workerEnabled || config.dryRun) throw executionError("EXECUTION_DISABLED", { reasonCode: stopping ? "WORKER_STOPPING" : config.dryRun ? "DRY_RUN_BLOCKS_PROVIDER_MUTATION" : "WORKER_GATE_DISABLED" });
    return config;
  }
  async function claimNext({ leaseOwner = `worker-${process.pid}`, leaseSeconds = 60 } = {}) {
    const config = currentConfig();
    if (!jobRepository?.claimEligibleApproved) throw executionError("PERSISTENCE_NOT_IMPLEMENTED");
    if (recoverExpiredLeases) await recoverExpiredLeases();
    else if (jobRepository.recoverExpiredLeases) await jobRepository.recoverExpiredLeases();
    const enabledProviders = Object.entries(config.providers).filter(([, enabled]) => enabled).map(([provider]) => provider);
    const job = (await jobRepository.claimEligibleApproved({ leaseOwner, leaseSeconds, limit: 1, enabledProviders }))?.[0] || null;
    if (!job) return null;
    const scope = { connectionId: job.connection_id || job.connectionId, platform: job.platform, accountExternalId: job.account_external_id || job.accountExternalId };
    const publicScope = { platform: scope.platform, connectionId: scope.connectionId, accountExternalId: scope.accountExternalId };
    if (!await connectionGate(scope)) { await jobRepository.releaseOwned({ id: job.id, leaseOwner, reason: "CONNECTION_WRITE_GATE_DISABLED" }); if (events) await events.emit("JOB_BLOCKED_BY_KILL_SWITCH", { jobId: job.id, ...publicScope }); throw executionError("EXECUTION_DISABLED", { reasonCode: "CONNECTION_WRITE_GATE_DISABLED" }); }
    if (events) await events.emit("JOB_CLAIMED", { jobId: job.id, ...publicScope });
    return job;
  }
  async function processClaimed({ leaseOwner = `worker-${process.pid}`, leaseSeconds = 60 } = {}) {
    const job = await claimNext({ leaseOwner, leaseSeconds }); if (!job) return null;
    const scope = { platform: job.platform, connectionId: job.connection_id || job.connectionId, accountExternalId: job.account_external_id || job.accountExternalId, owner: leaseOwner, leaseSeconds };
    const publicScope = { platform: scope.platform, connectionId: scope.connectionId, accountExternalId: scope.accountExternalId };
    let lock = null;
    try { lock = await accountLockRepository.acquire(scope); }
    catch (error) { await jobRepository.releaseOwned({ id: job.id, leaseOwner, reason: "ACCOUNT_EXECUTION_LOCKED" }); throw error; }
    try {
      const cancelled = await jobRepository.observeCancellationOwned?.({ id: job.id, leaseOwner });
      if (cancelled) {
        await audit?.event({ actorId: null, action: "EXECUTION_COMPLETED", targetId: job.id, targetType: "marketing_execution_job", metadata: { outcome: "CANCELLED_BEFORE_PROVIDER_MUTATION", runId: cancelled.runId, cancellationRequestedAt: cancelled.cancellationRequestedAt, cancellationObservedAt: cancelled.cancellationObservedAt } });
        await events?.emit("JOB_CANCELLATION_OBSERVED", { jobId: job.id, runId: cancelled.runId, status: "CANCELLED", ...publicScope }, cancelled.cancellationRequestedByAdminUserId ? [cancelled.cancellationRequestedByAdminUserId] : []);
        return { jobId: job.id, status: "CANCELLED", providerMutationAttempted: false };
      }
      await jobRepository.markRunningOwned({ id: job.id, leaseOwner }); if (events) await events.emit("JOB_STARTED", { jobId: job.id, ...publicScope }); const bundle = await jobRepository.loadExecutionBundle(job.id); const runContext = bundle.run || { id: job.runId || null, summary: null, plan: { id: null, platform: scope.platform, createdByAdminUserId: null } }; const correlationId = runContext.summary?.correlationId || null; await audit?.event({ actorId: null, action: "EXECUTION_STARTED", targetId: job.id, targetType: "marketing_execution_job", metadata: { correlationId, jobId: job.id, runId: runContext.id, planId: runContext.plan.id, platform: runContext.plan.platform } });
      const heartbeat = async () => { try { currentConfig(); if (!await connectionGate(scope)) throw executionError("EXECUTION_DISABLED", { reasonCode: "CONNECTION_WRITE_GATE_DISABLED" }); await accountLockRepository.heartbeat({ key: lock.key, owner: leaseOwner, leaseSeconds }); return await jobRepository.heartbeatOwned({ id: job.id, leaseOwner, leaseSeconds }); } catch (error) { if (events) await events.emit("HEARTBEAT_FAILED", { jobId: job.id, reason: error.code || "HEARTBEAT_FAILED" }); else metrics?.increment("heartbeatFailures"); throw error; } };
      let heartbeatFailure = null; const heartbeatTimer = setInterval(() => { heartbeat().catch((error) => { heartbeatFailure = error; }); }, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3))); heartbeatTimer.unref?.();
      try {
        const outcome = await executeBundle({ bundle, leaseOwner, lockKey: lock.key, heartbeat }); if (heartbeatFailure) throw heartbeatFailure; clearInterval(heartbeatTimer);
        if (outcome?.status === "RECONCILING") { await jobRepository.markReconcilingOwned({ id: job.id, leaseOwner, reason: "UNKNOWN_PROVIDER_OUTCOME" }); return { jobId: job.id, status: "RECONCILING", outcome }; }
        const terminal = outcome?.status === "SUCCEEDED" ? "SUCCEEDED" : outcome?.status === "DEAD_LETTER" ? "DEAD_LETTER" : "FAILED";
        await jobRepository.completeOwned({ id: job.id, leaseOwner, status: terminal, runStatus: outcome?.status }); await audit?.event({ actorId: null, action: "EXECUTION_COMPLETED", targetId: job.id, targetType: "marketing_execution_job", metadata: { correlationId, jobId: job.id, runId: runContext.id, planId: runContext.plan.id, status: outcome?.status || terminal } }); if (events) await events.emit(terminal === "DEAD_LETTER" ? "JOB_DEAD_LETTERED" : "JOB_COMPLETED", { correlationId, jobId: job.id, runId: runContext.id, planId: runContext.plan.id, status: outcome?.status || terminal }, runContext.plan.createdByAdminUserId ? [runContext.plan.createdByAdminUserId] : []); return { jobId: job.id, status: terminal, outcome };
      } catch (error) {
        clearInterval(heartbeatTimer);
        const decision = decideRetry({ category: error.category, statusCode: error.statusCode, providerProcessing: error.providerProcessing || "UNKNOWN", outcomeCertain: error.outcomeCertain, localPersistenceFailed: error.localPersistenceFailed === true, attempt: job.attempt_count || job.attemptCount || 1 });
        if (["RECONCILE_BEFORE_RETRY", "RECONCILE_LOCAL_PERSISTENCE"].includes(decision.action)) { await jobRepository.markReconcilingOwned({ id: job.id, leaseOwner, reason: decision.action }); if (events) await events.emit("UNKNOWN_OUTCOME", { jobId: job.id, action: decision.action }); return { jobId: job.id, status: "RECONCILING", decision }; }
        if (decision.automaticRetry) { const nextAttemptAt = decision.retryAfterAt ? new Date(decision.retryAfterAt) : new Date(Date.now() + decision.backoffMs); await jobRepository.scheduleRetryOwned({ id: job.id, leaseOwner, nextAttemptAt }); return { jobId: job.id, status: "RETRY_SCHEDULED", decision }; }
        const terminal = decision.action === "DEAD_LETTER_MANUAL_REVIEW" ? "DEAD_LETTER" : "FAILED"; await jobRepository.completeOwned({ id: job.id, leaseOwner, status: terminal }); await audit?.event({ actorId: null, action: "EXECUTION_COMPLETED", targetId: job.id, targetType: "marketing_execution_job", metadata: { correlationId, jobId: job.id, runId: runContext.id, planId: runContext.plan.id, status: terminal, reason: decision.action } }); if (events) await events.emit(terminal === "DEAD_LETTER" ? "JOB_DEAD_LETTERED" : "JOB_COMPLETED", { correlationId, jobId: job.id, status: terminal }, runContext.plan.createdByAdminUserId ? [runContext.plan.createdByAdminUserId] : []); return { jobId: job.id, status: terminal, decision };
      }
    } finally { if (lock) await accountLockRepository.release({ key: lock.key, owner: leaseOwner }); }
  }
  async function processNext(options = {}) { if (inFlight) return null; inFlight = processClaimed(options); try { return await inFlight; } finally { inFlight = null; } }
  function start() { if (started) return false; currentConfig(); if (!jobRepository || !accountLockRepository || !executeBundle) throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "EXECUTION_WORKER_DEPENDENCIES_REQUIRED" }); started = true; stopping = false; timer = setInterval(() => { processNext().catch(() => undefined); }, Math.max(pollIntervalMs, 500)); timer.unref?.(); return true; }
  function stopClaims() { stopping = true; if (timer) clearInterval(timer); }
  async function shutdown() { stopClaims(); if (inFlight) await inFlight; started = false; return { stopped: true, inFlightCheckpointed: true }; }
  return Object.freeze({ start, claimNext, processNext, stopClaims, shutdown, isStopping: () => stopping, isStarted: () => started });
}
module.exports = { createExecutionWorker, isStarted: () => false };
