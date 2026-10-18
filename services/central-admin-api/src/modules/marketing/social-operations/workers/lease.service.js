const { prisma } = require("../../../../shared/config/database");
const {
  recordClaimFailure,
  recordLeaseRecovery,
} = require("../observability/worker-metrics.registry");

const QUEUE_CONFIGS = Object.freeze({
  publishing: {
    queue: "publishing",
    table: "social_publishing_jobs",
    modelName: "socialPublishingJob",
  },
  action: {
    queue: "action",
    table: "social_action_jobs",
    modelName: "socialActionJob",
  },
});

function resolveQueueConfig(queue) {
  const config = typeof queue === "string" ? QUEUE_CONFIGS[queue] : queue;
  if (!config || !QUEUE_CONFIGS[config.queue]) {
    throw new Error("Unsupported Social Operations worker queue");
  }
  return QUEUE_CONFIGS[config.queue];
}

function buildRecoverExpiredLeasesSql(queue) {
  const { table } = resolveQueueConfig(queue);
  return `
UPDATE ${table}
SET status = 'RETRY_SCHEDULED',
    next_attempt_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    heartbeat_at = NULL
WHERE status IN ('CLAIMED', 'RUNNING')
  AND lease_expires_at < now()
`;
}

function buildClaimDueJobsSql(queue) {
  const { table } = resolveQueueConfig(queue);
  return `
SELECT id
FROM ${table}
WHERE status IN ('PENDING', 'RETRY_SCHEDULED')
  AND scheduled_for_utc <= now()
  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
ORDER BY priority DESC, scheduled_for_utc ASC
FOR UPDATE SKIP LOCKED
LIMIT $1
`;
}

function recoverExpiredLeasesInMemory({ jobs, now = new Date() }) {
  let count = 0;
  for (const job of jobs) {
    if (
      ["CLAIMED", "RUNNING"].includes(job.status) &&
      job.leaseExpiresAt &&
      new Date(job.leaseExpiresAt).getTime() < now.getTime()
    ) {
      job.status = "RETRY_SCHEDULED";
      job.nextAttemptAt = now;
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      job.heartbeatAt = null;
      count += 1;
    }
  }
  return count;
}

function claimDueJobsInMemory({
  jobs,
  workerId,
  limit = 10,
  leaseDurationMs = 5 * 60 * 1000,
  now = new Date(),
}) {
  const claimable = jobs
    .filter(
      (job) =>
        ["PENDING", "RETRY_SCHEDULED"].includes(job.status) &&
        new Date(job.scheduledForUtc).getTime() <= now.getTime() &&
        (!job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() <= now.getTime()),
    )
    .sort((left, right) => {
      if ((right.priority || 0) !== (left.priority || 0)) {
        return (right.priority || 0) - (left.priority || 0);
      }
      return new Date(left.scheduledForUtc).getTime() - new Date(right.scheduledForUtc).getTime();
    })
    .slice(0, limit);

  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  for (const job of claimable) {
    job.status = "CLAIMED";
    job.leaseOwner = workerId;
    job.leaseExpiresAt = leaseExpiresAt;
  }
  return claimable.map((job) => ({ id: job.id, leaseOwner: workerId, leaseExpiresAt }));
}

async function recoverExpiredLeases({ queue, db = prisma } = {}) {
  const config = resolveQueueConfig(queue);
  if (db.__leaseMemory?.[config.queue]) {
    const count = recoverExpiredLeasesInMemory({ jobs: db.__leaseMemory[config.queue] });
    recordLeaseRecovery(config.queue, count);
    return count;
  }
  const sql = buildRecoverExpiredLeasesSql(config);
  const count = await db.$transaction((tx) => tx.$executeRawUnsafe(sql));
  recordLeaseRecovery(config.queue, count);
  return count;
}

async function claimDueJobs({
  queue,
  workerId,
  limit = 10,
  leaseDurationMs = 5 * 60 * 1000,
  db = prisma,
} = {}) {
  const config = resolveQueueConfig(queue);
  if (db.__leaseMemory?.[config.queue]) {
    return claimDueJobsInMemory({
      jobs: db.__leaseMemory[config.queue],
      workerId,
      limit,
      leaseDurationMs,
    });
  }

  const claimSql = buildClaimDueJobsSql(config);
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  try {
    return await db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(claimSql, limit);
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return [];

      await tx[config.modelName].updateMany({
        where: { id: { in: ids } },
        data: {
          status: "CLAIMED",
          leaseOwner: workerId,
          leaseExpiresAt,
        },
      });

      return ids.map((id) => ({ id, leaseOwner: workerId, leaseExpiresAt }));
    });
  } catch (error) {
    recordClaimFailure(config.queue);
    throw error;
  }
}

async function recoverThenClaim({
  queue,
  workerId,
  limit,
  leaseDurationMs,
  db = prisma,
} = {}) {
  await recoverExpiredLeases({ queue, db });
  return claimDueJobs({ queue, workerId, limit, leaseDurationMs, db });
}

module.exports = {
  QUEUE_CONFIGS,
  resolveQueueConfig,
  buildRecoverExpiredLeasesSql,
  buildClaimDueJobsSql,
  recoverExpiredLeasesInMemory,
  claimDueJobsInMemory,
  recoverExpiredLeases,
  claimDueJobs,
  recoverThenClaim,
};
