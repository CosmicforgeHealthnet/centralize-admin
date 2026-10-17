const { prisma } = require("../../../../shared/config/database");
const {
  recoverThenClaim,
} = require("./lease.service");
const {
  executePublishingJob,
} = require("../services/publication-execution.service");
const {
  recordProcessingDuration,
} = require("../observability/worker-metrics.registry");

async function runPublishingWorkerOnce({
  workerId = `social-publishing-${process.pid}`,
  batchSize = 5,
  leaseDurationMs = 5 * 60 * 1000,
  db = prisma,
  connectorResolver,
  executor = executePublishingJob,
} = {}) {
  const startedAt = Date.now();
  try {
    const claimed = await recoverThenClaim({
      queue: "publishing",
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
    recordProcessingDuration("publishing", Date.now() - startedAt);
  }
}

module.exports = {
  runPublishingWorkerOnce,
};
