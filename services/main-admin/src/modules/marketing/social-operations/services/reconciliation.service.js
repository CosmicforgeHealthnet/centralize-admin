const crypto = require("crypto");
const { prisma } = require("../../../../shared/config/database");
const {
  validateActionPayload,
} = require("../security/sensitive-payload.validator");

function socialReconciliationEnabled() {
  return String(process.env.SOCIAL_RECONCILIATION_ENABLED || "false").toLowerCase() === "true";
}

function reconciliationStatus() {
  return {
    enabled: socialReconciliationEnabled(),
    providerPollingOnStartup: false,
  };
}

function syncJobKey(identityId, scope = "content") {
  return crypto
    .createHash("sha256")
    .update(`social-sync:${scope}:${identityId}`)
    .digest("hex");
}

async function enqueueContentSync({ identityId, requestedById, db = prisma } = {}) {
  const identity = await db.socialPublishingIdentity.findUnique({
    where: { id: identityId },
  });
  if (!identity) {
    const ApiError = require("../../../../shared/utils/ApiError");
    throw new ApiError(404, "Social identity not found");
  }

  await db.socialIdentitySyncState.upsert({
    where: { identityId },
    update: {},
    create: { identityId },
  });

  return db.socialActionJob.upsert({
    where: { idempotencyKey: syncJobKey(identityId, "content") },
    update: {
      status: "PENDING",
      nextAttemptAt: null,
      lastError: null,
      payloadJson: validateActionPayload({ requestedById, scope: "content" }),
    },
    create: {
      jobType: "SYNC_PROVIDER_CONTENT",
      status: "PENDING",
      identityId,
      idempotencyKey: syncJobKey(identityId, "content"),
      payloadJson: validateActionPayload({ requestedById, scope: "content" }),
    },
  });
}

async function listDueIdentitySyncStates({ db = prisma, limit = 25 } = {}) {
  return db.socialIdentitySyncState.findMany({
    include: { identity: { include: { connection: true } } },
    take: limit,
  });
}

async function updateIdentitySyncCheckpoint({
  identityId,
  scope,
  cursor,
  syncedAt = new Date(),
  db = prisma,
} = {}) {
  const dataByScope = {
    content: { contentCursor: cursor || null, lastContentSync: syncedAt },
    comments: { commentCursor: cursor || null, lastCommentSync: syncedAt },
    messages: { messageCursor: cursor || null, lastMessageSync: syncedAt },
    metrics: { metricCursor: cursor || null, lastMetricSync: syncedAt },
  };

  const data = dataByScope[scope];
  if (!data) throw new Error("Unsupported Social reconciliation scope");

  return db.socialIdentitySyncState.upsert({
    where: { identityId },
    update: data,
    create: { identityId, ...data },
  });
}

async function runReconciliationOnce({ db = prisma } = {}) {
  if (!socialReconciliationEnabled()) {
    return {
      enabled: false,
      providerCallsMade: 0,
      processed: 0,
    };
  }

  const states = await listDueIdentitySyncStates({ db });
  return {
    enabled: true,
    providerCallsMade: 0,
    processed: states.length,
    deferredProviderPolling: true,
  };
}

module.exports = {
  socialReconciliationEnabled,
  reconciliationStatus,
  syncJobKey,
  enqueueContentSync,
  listDueIdentitySyncStates,
  updateIdentitySyncCheckpoint,
  runReconciliationOnce,
};
