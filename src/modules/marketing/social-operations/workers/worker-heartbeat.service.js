const { prisma } = require("../../../../shared/config/database");
const { resolveQueueConfig } = require("./lease.service");
const {
  recordHeartbeat,
} = require("../observability/worker-metrics.registry");

async function heartbeatOnce({
  queue,
  jobId,
  workerId,
  leaseDurationMs = 5 * 60 * 1000,
  db = prisma,
} = {}) {
  const config = resolveQueueConfig(queue);
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
  const result = await db[config.modelName].updateMany({
    where: {
      id: jobId,
      leaseOwner: workerId,
      status: "RUNNING",
    },
    data: {
      heartbeatAt: new Date(),
      leaseExpiresAt,
    },
  });
  recordHeartbeat(config.queue);
  return result;
}

function startHeartbeat({
  queue,
  jobId,
  workerId,
  db = prisma,
  intervalMs = 30 * 1000,
  leaseDurationMs = 5 * 60 * 1000,
} = {}) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    heartbeatOnce({ queue, jobId, workerId, db, leaseDurationMs }).catch(() => {});
  };
  const interval = setInterval(tick, intervalMs);
  if (typeof interval.unref === "function") interval.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

module.exports = {
  heartbeatOnce,
  startHeartbeat,
};
