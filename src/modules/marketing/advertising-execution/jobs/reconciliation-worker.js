const { executionError } = require("../execution.errors");

function createReconciliationWorker({ enabled = false, repository, reconciliationService, providerReadRegistry, events, maximumAttempts = 5, pollIntervalMs = 5000 } = {}) {
  let started = false; let stopping = false; let timer = null; let inFlight = null;
  async function processNext({ owner = `reconciliation-${process.pid}`, leaseSeconds = 60 } = {}) {
    if (!enabled || stopping) return null;
    const job = await repository.claim({ owner, leaseSeconds }); if (!job) return null;
    await repository.markRunning({ id: job.id, owner });
    const bundle = await repository.loadBundle(job.id);
    try {
      const reader = providerReadRegistry.resolve(bundle.plan.platform);
      const currentState = await reader.readResource({ operation: bundle.operation, plan: bundle.plan, providerIdentity: bundle.providerIdentity });
      const result = await reconciliationService.reconcile({ bundle, currentState, providerVersion: reader.apiVersion, externalActor: currentState?.externalActor });
      if (result.status === "UNKNOWN" && bundle.attemptCount < maximumAttempts) { await repository.reschedule({ id: job.id, owner, nextAttemptAt: new Date(Date.now() + Math.min(60000 * 2 ** bundle.attemptCount, 3600000)), category: "READ_BACK_UNKNOWN" }); return result; }
      await repository.finish({ id: job.id, owner, status: result.status === "UNKNOWN" ? "ESCALATED" : "SUCCEEDED", category: result.status });
      if (result.status === "UNKNOWN" && events) await events.emit("RECONCILIATION_ESCALATED", { jobId: job.id, operationId: bundle.operationId });
      return result;
    } catch (error) {
      if (bundle.attemptCount >= maximumAttempts) await repository.finish({ id: job.id, owner, status: "ESCALATED", category: error.code || "READ_BACK_FAILED" });
      else await repository.reschedule({ id: job.id, owner, nextAttemptAt: new Date(Date.now() + Math.min(60000 * 2 ** bundle.attemptCount, 3600000)), category: error.code || "READ_BACK_FAILED" });
      return { status: "UNKNOWN", error: error.code || "READ_BACK_FAILED" };
    }
  }
  function start() { if (!enabled || started) return false; if (!repository || !reconciliationService || !providerReadRegistry) throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "RECONCILIATION_WORKER_DEPENDENCIES_REQUIRED" }); started = true; stopping = false; timer = setInterval(() => { if (!inFlight) { inFlight = processNext().finally(() => { inFlight = null; }); } }, Math.max(pollIntervalMs, 1000)); timer.unref?.(); return true; }
  async function shutdown() { stopping = true; if (timer) clearInterval(timer); if (inFlight) await inFlight; started = false; return { stopped: true, inFlightCheckpointed: true }; }
  return Object.freeze({ start, processNext, shutdown, isStarted: () => started });
}
module.exports = { createReconciliationWorker };
