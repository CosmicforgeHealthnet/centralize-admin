const { prisma } = require("../../../../shared/config/database");
const {
  socialFeatureFlags,
} = require("../privacy/retention-settings.service");
const {
  snapshotWorkerMetrics,
} = require("./worker-metrics.registry");

const JOB_STATUSES = ["PENDING", "CLAIMED", "RUNNING", "RETRY_SCHEDULED", "SUCCEEDED", "FAILED", "CANCELLED"];
const ACTIVE_PUBLICATION_JOB_STATUSES = ["PENDING", "CLAIMED", "RUNNING", "RETRY_SCHEDULED"];
const SAFETY_CLASSIFICATIONS = ["MEDICAL_EMERGENCY", "SELF_HARM_RISK"];

function secondsSince(date, now) {
  if (!date) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / 1000));
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("METRIC_TIMEOUT")), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function safeCategory(name, fn, timeoutMs) {
  try {
    return await withTimeout(Promise.resolve().then(fn), timeoutMs);
  } catch {
    return {
      available: false,
      error: "METRIC_UNAVAILABLE",
      category: name,
    };
  }
}

async function groupStatusCounts(model, statuses) {
  if (typeof model.groupBy === "function") {
    const rows = await model.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    return Object.fromEntries(
      statuses.map((status) => [
        status,
        rows.find((row) => row.status === status)?._count?._all || 0,
      ]),
    );
  }

  const pairs = await Promise.all(
    statuses.map(async (status) => [
      status,
      typeof model.count === "function" ? await model.count({ where: { status } }) : 0,
    ]),
  );
  return Object.fromEntries(pairs);
}

async function queueMetrics({ model, now }) {
  const byStatus = await groupStatusCounts(model, JOB_STATUSES);
  const oldest = await model.findFirst({
    where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] } },
    orderBy: { scheduledForUtc: "asc" },
    select: { scheduledForUtc: true },
  });
  const active = await model.findMany({
    where: { status: { in: ACTIVE_PUBLICATION_JOB_STATUSES } },
    select: {
      attemptCount: true,
      maxAttempts: true,
      leaseExpiresAt: true,
      heartbeatAt: true,
    },
    take: 1000,
  });
  return {
    available: true,
    byStatus,
    pendingCount: byStatus.PENDING || 0,
    retryScheduledCount: byStatus.RETRY_SCHEDULED || 0,
    claimedCount: byStatus.CLAIMED || 0,
    runningCount: byStatus.RUNNING || 0,
    failedCount: byStatus.FAILED || 0,
    oldestPendingAgeSeconds: secondsSince(oldest?.scheduledForUtc, now),
    nearMaxAttemptsCount: active.filter(
      (job) => Number(job.maxAttempts || 0) - Number(job.attemptCount || 0) <= 1,
    ).length,
    staleLeaseCount: active.filter(
      (job) => job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < now.getTime(),
    ).length,
  };
}

async function webhookMetrics({ db, now }) {
  const byStatus = await groupStatusCounts(db.socialWebhookEvent, [
    "RECEIVED",
    "PROCESSING",
    "PROCESSED",
    "FAILED",
    "IGNORED_DUPLICATE",
  ]);
  const oldest = await db.socialWebhookEvent.findFirst({
    where: { status: { in: ["RECEIVED", "PROCESSING", "FAILED"] } },
    orderBy: { receivedAt: "asc" },
    select: { receivedAt: true },
  });
  return {
    available: true,
    byStatus,
    receivedCount: byStatus.RECEIVED || 0,
    invalidSignatureCount: await db.socialWebhookEvent.count({
      where: { signatureValid: false },
    }),
    duplicateEventCount: byStatus.IGNORED_DUPLICATE || 0,
    duplicateHashCount: byStatus.IGNORED_DUPLICATE || 0,
    failedProcessingCount: byStatus.FAILED || 0,
    oldestUnprocessedAgeSeconds: secondsSince(oldest?.receivedAt, now),
  };
}

async function connectionMetrics({ db, now }) {
  const nearExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    available: true,
    expiredCredentialCount: await db.socialAccountConnection.count({
      where: {
        OR: [
          { accessTokenExpiresAt: { lt: now } },
          { refreshTokenExpiresAt: { lt: now } },
        ],
      },
    }),
    credentialsNearingExpiryCount: await db.socialAccountConnection.count({
      where: {
        OR: [
          { accessTokenExpiresAt: { gte: now, lte: nearExpiry } },
          { refreshTokenExpiresAt: { gte: now, lte: nearExpiry } },
        ],
      },
    }),
    requiresReauthorizationCount: await db.socialAccountConnection.count({
      where: { requiresReauthorization: true },
    }),
    unhealthySubscriptionCount: await db.socialWebhookSubscription.count({
      where: { status: { in: ["DEGRADED", "ERROR"] } },
    }),
  };
}

async function privacyMetrics({ db, env }) {
  const flags = socialFeatureFlags(env);
  return {
    available: true,
    phaseDEnabled: flags.phaseDEnabled,
    inboxEnabled: flags.inboxEnabled,
    redactionWorkerEnabled: flags.redactionWorkerEnabled,
    recordsAwaitingApprovedRedaction: {
      messages: await db.socialMessage.count({
        where: { sensitiveDataState: { in: ["FLAGGED", "CONFIRMED"] }, redactedAt: null },
      }),
      comments: await db.socialComment.count({
        where: { sensitiveDataState: { in: ["FLAGGED", "CONFIRMED"] }, redactedAt: null },
      }),
      internalNotes: await db.socialInternalNote.count({
        where: { sensitiveDataState: { in: ["FLAGGED", "CONFIRMED"] }, redactedAt: null },
      }),
      webhookEvents: await db.socialWebhookEvent.count({
        where: { retentionExpiresAt: { not: null }, redactedAt: null },
      }),
    },
    redactionBatchesFailed: 0,
  };
}

async function healthNetMetrics({ db, now }) {
  const unresolvedWhere = { status: { in: ["DETECTED", "CONFIRMED"] } };
  const oldest = await db.socialEscalation.findFirst({
    where: {
      ...unresolvedWhere,
      classification: { in: SAFETY_CLASSIFICATIONS },
    },
    orderBy: { detectedAt: "asc" },
    select: { detectedAt: true },
  });
  return {
    available: true,
    restrictedEscalationCount: await db.socialEscalation.count({
      where: { ...unresolvedWhere, restrictedVisibility: true },
    }),
    unresolvedEmergencyCount: await db.socialEscalation.count({
      where: { ...unresolvedWhere, classification: "MEDICAL_EMERGENCY" },
    }),
    unresolvedSelfHarmCount: await db.socialEscalation.count({
      where: { ...unresolvedWhere, classification: "SELF_HARM_RISK" },
    }),
    unassignedSafetyTaskCount: await db.socialEscalation.count({
      where: {
        ...unresolvedWhere,
        classification: { in: SAFETY_CLASSIFICATIONS },
        OR: [{ taskId: null }, { task: { is: { assigneeId: null } } }],
      },
    }),
    oldestUnresolvedSafetyEscalationAgeSeconds: secondsSince(oldest?.detectedAt, now),
    privacyIncidentCount: await db.socialEscalation.count({
      where: { ...unresolvedWhere, classification: "PRIVACY_INCIDENT" },
    }),
  };
}

function workerMetrics() {
  return {
    available: true,
    ...snapshotWorkerMetrics(),
  };
}

async function getSocialOperationsHealth({
  db = prisma,
  env = process.env,
  now = new Date(),
  timeoutMs = 1000,
} = {}) {
  const [
    publishingQueue,
    actionQueue,
    webhooks,
    connections,
    privacy,
    healthNet,
  ] = await Promise.all([
    safeCategory("publishingQueue", () => queueMetrics({ model: db.socialPublishingJob, now }), timeoutMs),
    safeCategory("actionQueue", () => queueMetrics({ model: db.socialActionJob, now }), timeoutMs),
    safeCategory("webhooks", () => webhookMetrics({ db, now }), timeoutMs),
    safeCategory("connections", () => connectionMetrics({ db, now }), timeoutMs),
    safeCategory("privacy", () => privacyMetrics({ db, env }), timeoutMs),
    safeCategory("healthNet", () => healthNetMetrics({ db, now }), timeoutMs),
  ]);

  return {
    generatedAt: now.toISOString(),
    publishingQueue,
    actionQueue,
    workers: workerMetrics(),
    webhooks,
    connections,
    privacy,
    healthNet,
  };
}

module.exports = {
  getSocialOperationsHealth,
};
