const { prisma } = require("../../../../shared/config/database");
const { getConnector } = require("../connectors/connector.registry");
const {
  mapProviderPublishResult,
} = require("../connectors/publish-result.mapper");
const {
  mapTikTokPublishResult,
} = require("../connectors/tiktok-publish-result.mapper");
const {
  connectorForIdentity,
  evaluatePublicationExecution,
  publishFailureEvent,
  attemptMeta,
  planExecutionFailure,
} = require("./worker-execution-utils");
const {
  PUBLICATION_STATUS_TRANSITION_SOURCES,
  transitionPublicationStatus,
} = require("./publication-status-transition.service");
const { startHeartbeat } = require("../workers/worker-heartbeat.service");

async function loadPublishingJobContext({ jobId, db = prisma }) {
  const job = await db.socialPublishingJob.findUnique({
    where: { id: jobId },
    include: {
      publication: {
        include: {
          target: {
            include: {
              post: true,
              identity: { include: { connection: true } },
              media: { include: { asset: true } },
            },
          },
        },
      },
    },
  });
  if (!job || !job.publication || !job.publication.target) {
    throw Object.assign(new Error("Publishing job context is incomplete"), {
      permanent: true,
      reasonCode: "PUBLISHING_CONTEXT_NOT_FOUND",
    });
  }
  return {
    job,
    publication: job.publication,
    target: job.publication.target,
    post: job.publication.target.post,
    identity: job.publication.target.identity,
    connection: job.publication.target.identity.connection,
    media: job.publication.target.media || [],
  };
}

function normalizePublishResult({ provider, result }) {
  if (provider === "TIKTOK") return mapTikTokPublishResult(result);
  return mapProviderPublishResult(result);
}

async function createPublicationAttempt({
  publicationId,
  attemptNo,
  category,
  responseMetaJson,
  startedAt,
  finishedAt,
  db,
}) {
  return db.socialPublicationAttempt.create({
    data: {
      publicationId,
      attemptNo,
      category,
      responseMetaJson,
      startedAt,
      finishedAt,
    },
  });
}

async function markPublicationPermanentFailure({
  job,
  publication,
  startedAt,
  error,
  errorCategory = "PERMANENT",
  reasonCode,
  db,
}) {
  const finishedAt = new Date();
  const attemptNo = job.attemptCount + 1;
  const sanitizedError = reasonCode || error?.reasonCode || error?.message || "PERMANENT";

  await createPublicationAttempt({
    publicationId: publication.id,
    attemptNo,
    category: errorCategory,
    responseMetaJson: attemptMeta({
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      providerStatus: "FAILED",
      operation: "publishPost",
    }),
    startedAt,
    finishedAt,
    db,
  });
  await db.socialPublication.update({
    where: { id: publication.id },
    data: {
      status: "FAILED_PERMANENT",
      lastErrorCategory: errorCategory,
      lastError: sanitizedError,
    },
  });
  await db.socialPublishingJob.update({
    where: { id: job.id },
    data: {
      status: "FAILED",
      attemptCount: { increment: 1 },
      lastErrorCategory: errorCategory,
      lastError: sanitizedError,
      nextAttemptAt: null,
      completedAt: finishedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });
  await publishFailureEvent({
    publicationId: publication.id,
    jobId: job.id,
    reasonCode: sanitizedError,
  });
}

async function executePublishingJob({
  jobId,
  workerId,
  db = prisma,
  connectorResolver = getConnector,
  heartbeatFactory = startHeartbeat,
  now = () => new Date(),
  random = Math.random,
} = {}) {
  const startedAt = now();
  const context = await loadPublishingJobContext({ jobId, db });
  const { job, publication, target, identity, connection, media } = context;
  const provider = connection.provider;
  const attemptNo = job.attemptCount + 1;

  const { connector, capabilities } = await connectorForIdentity(
    identity,
    connectorResolver,
  );
  const policy = await evaluatePublicationExecution({
    publication,
    identity,
    capability: capabilities.publishPost,
    requiredCapability: "publishPost",
    db,
  });

  if (!policy.allowed) {
    if (policy.retryable) {
      const finishedAt = now();
      const retry = planExecutionFailure({
        error: {
          retryable: true,
          reasonCode: policy.reasonCode,
          message: policy.message,
          retryAfter: capabilities.publishPost?.retryAt,
        },
        nextAttemptNumber: attemptNo,
        maxAttempts: job.maxAttempts,
        now: finishedAt,
        random,
      });
      await createPublicationAttempt({
        publicationId: publication.id,
        attemptNo,
        category: retry.errorCategory,
        responseMetaJson: attemptMeta({
          provider,
          identityId: identity.id,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          providerStatus: "FAILED",
          idempotencyKey: publication.idempotencyKey,
          operation: "publishPost",
        }),
        startedAt,
        finishedAt,
        db,
      });
      await db.socialPublication.update({
        where: { id: publication.id },
        data: {
          status: retry.retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
          lastErrorCategory: retry.errorCategory,
          lastError: retry.sanitizedError,
        },
      });
      await db.socialPublishingJob.update({
        where: { id: job.id },
        data: {
          status: retry.retryable ? "RETRY_SCHEDULED" : "FAILED",
          attemptCount: { increment: 1 },
          nextAttemptAt: retry.nextAttemptAt,
          lastErrorCategory: retry.errorCategory,
          lastError: retry.sanitizedError,
          completedAt: retry.retryable ? null : finishedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      });
      return {
        status: retry.retryable ? "RETRY_SCHEDULED" : "FAILED",
        retryable: retry.retryable,
        reasonCode: policy.reasonCode,
      };
    }
    await markPublicationPermanentFailure({
      job,
      publication,
      startedAt,
      error: policy,
      errorCategory: policy.errorCategory || "PERMANENT",
      reasonCode: policy.reasonCode,
      db,
    });
    return { status: "FAILED", permanent: true, reasonCode: policy.reasonCode };
  }

  await db.socialPublishingJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", heartbeatAt: now() },
  });
  const heartbeat = heartbeatFactory({
    queue: "publishing",
    jobId: job.id,
    workerId,
    db,
  });

  try {
    const uploadedMedia = [];
    for (const mediaItem of media) {
      uploadedMedia.push(
        await connector.uploadMedia({
          asset: mediaItem.asset,
          target,
          connection,
        }),
      );
    }

    const providerResult = await connector.publishPost({
      target,
      post: context.post,
      uploadedMedia,
      idempotencyKey: publication.idempotencyKey,
      connection,
    });
    const normalized = normalizePublishResult({ provider, result: providerResult });
    const finishedAt = now();

    await createPublicationAttempt({
      publicationId: publication.id,
      attemptNo,
      category: "SUCCESS",
      responseMetaJson: attemptMeta({
        provider,
        identityId: identity.id,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        providerStatus: normalized.status,
        providerPostId: normalized.providerPostId,
        idempotencyKey: publication.idempotencyKey,
        operation: "publishPost",
      }),
      startedAt,
      finishedAt,
      db,
    });
    await transitionPublicationStatus({
      publicationId: publication.id,
      publication,
      nextStatus: normalized.status,
      providerPostId: normalized.providerPostId,
      url: normalized.url,
      postingMode: normalized.postingMode || publication.postingMode,
      providerTimestamp: normalized.publishedAt || finishedAt,
      source: PUBLICATION_STATUS_TRANSITION_SOURCES.PUBLISH_RESPONSE,
      identityId: identity.id,
      db,
      now: finishedAt,
    });
    await db.socialPublishingJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        attemptCount: { increment: 1 },
        completedAt: finishedAt,
        lastError: null,
        lastErrorCategory: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      },
    });

    return { status: "SUCCEEDED", publicationStatus: normalized.status, normalized };
  } catch (error) {
    const finishedAt = now();
    const retry = planExecutionFailure({
      error,
      nextAttemptNumber: attemptNo,
      maxAttempts: job.maxAttempts,
      now: finishedAt,
      random,
    });
    const publicationStatus = retry.retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT";
    const jobStatus = retry.retryable ? "RETRY_SCHEDULED" : "FAILED";

    await createPublicationAttempt({
      publicationId: publication.id,
      attemptNo,
      category: retry.errorCategory,
      responseMetaJson: attemptMeta({
        provider,
        identityId: identity.id,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        providerStatus: "FAILED",
        idempotencyKey: publication.idempotencyKey,
        operation: "publishPost",
      }),
      startedAt,
      finishedAt,
      db,
    });
    await db.socialPublication.update({
      where: { id: publication.id },
      data: {
        status: publicationStatus,
        lastErrorCategory: retry.errorCategory,
        lastError: retry.sanitizedError,
      },
    });
    await db.socialPublishingJob.update({
      where: { id: job.id },
      data: {
        status: jobStatus,
        attemptCount: { increment: 1 },
        nextAttemptAt: retry.nextAttemptAt,
        lastErrorCategory: retry.errorCategory,
        lastError: retry.sanitizedError,
        completedAt: retry.retryable ? null : finishedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      },
    });

    if (!retry.retryable) {
      await publishFailureEvent({
        publicationId: publication.id,
        jobId: job.id,
        reasonCode: retry.errorCategory,
      });
    }

    return {
      status: jobStatus,
      publicationStatus,
      retryable: retry.retryable,
      errorCategory: retry.errorCategory,
    };
  } finally {
    if (heartbeat?.stop) await heartbeat.stop();
  }
}

module.exports = {
  loadPublishingJobContext,
  normalizePublishResult,
  executePublishingJob,
};
