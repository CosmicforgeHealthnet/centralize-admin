const { prisma } = require("../../../../shared/config/database");
const {
  recoverThenClaim,
} = require("./lease.service");
const {
  executeActionJob,
} = require("../services/action-execution.service");
const {
  recordProcessingDuration,
} = require("../observability/worker-metrics.registry");

async function runActionWorkerOnce({
  workerId = `social-action-${process.pid}`,
  batchSize = 10,
  leaseDurationMs = 5 * 60 * 1000,
  db = prisma,
  connectorResolver,
  executor = executeActionJob,
} = {}) {
  const startedAt = Date.now();
  try {
    const claimed = await recoverThenClaim({
      queue: "action",
      workerId,
      limit: batchSize,
      leaseDurationMs,
      db,
    });

    const results = [];
    for (const job of claimed) {
      try {
        results.push(
          await executor({
            jobId: job.id,
            workerId,
            db,
            connectorResolver,
          }),
        );
      } catch (error) {
        results.push({ status: "ERROR", jobId: job.id, error });
      }
    }

    return {
      claimed: claimed.length,
      results,
    };
  } finally {
    recordProcessingDuration("action", Date.now() - startedAt);
  }
}

module.exports = {
  runActionWorkerOnce,
};
