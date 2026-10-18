const { prisma } = require("../../../../shared/config/database");
const { getConnector } = require("../connectors/connector.registry");
const {
  validateNormalizedProviderContent,
} = require("../connectors/connector.validators");
const {
  connectorForIdentity,
  evaluateActionExecution,
  loadSocialSettings,
  attemptMeta,
  planExecutionFailure,
} = require("./worker-execution-utils");
const {
  updateIdentitySyncCheckpoint,
} = require("./reconciliation.service");
const {
  PUBLICATION_STATUS_TRANSITION_SOURCES,
  normalizePublicationStatusResult,
  transitionPublicationStatus,
} = require("./publication-status-transition.service");
const { startHeartbeat } = require("../workers/worker-heartbeat.service");

const ACTION_CAPABILITY_BY_TYPE = Object.freeze({
  SEND_MESSAGE: "sendMessage",
  REPLY_COMMENT: "replyToComment",
  HIDE_COMMENT: "moderateComment",
  DELETE_COMMENT: "moderateComment",
  DELETE_PROVIDER_POST: "deletePost",
  SYNC_PROVIDER_CONTENT: "listContent",
  SYNC_COMMENTS: "listComments",
  SYNC_MESSAGES: "listConversations",
  SYNC_METRICS: "listContentMetrics",
  POLL_PUBLICATION: "getPublishStatus",
});

const POLL_TERMINAL_NO_PROVIDER_STATUSES = Object.freeze([
  "PUBLISHED",
  "FAILED_PERMANENT",
  "CANCELLED",
  "DELETED",
]);

async function loadActionJobContext({ jobId, db = prisma }) {
  const job = await db.socialActionJob.findUnique({
    where: { id: jobId },
    include: {
      identity: { include: { connection: true, syncState: true } },
      message: true,
      comment: {
        include: {
          parent: true,
          providerContent: true,
        },
      },
      providerContent: true,
      publication: {
        include: {
          target: {
            include: {
              identity: { include: { connection: true } },
              post: true,
            },
          },
        },
      },
    },
  });
  if (!job) {
    throw Object.assign(new Error("Action job not found"), {
      permanent: true,
      reasonCode: "ACTION_JOB_NOT_FOUND",
    });
  }
  return { job, identity: job.identity, connection: job.identity?.connection };
}

function connectorMethodForJob(jobType) {
  const capability = ACTION_CAPABILITY_BY_TYPE[jobType];
  if (!capability) {
    throw Object.assign(new Error("Unsupported Social action job type"), {
      permanent: true,
      reasonCode: "UNSUPPORTED_ACTION_JOB_TYPE",
    });
  }
  return capability;
}

async function createActionAttempt({
  jobId,
  attemptNo,
  resultStatus,
  errorCategory,
  sanitizedError,
  responseMetaJson,
  startedAt,
  finishedAt,
  db,
}) {
  return db.socialActionAttempt.create({
    data: {
      jobId,
      attemptNo,
      resultStatus,
      errorCategory,
      sanitizedError,
      responseMetaJson,
      startedAt,
      finishedAt,
    },
  });
}

function actionOperationPayload({ context }) {
  const { job } = context;
  if (job.jobType === "SEND_MESSAGE") {
    if (!job.message) {
      throw Object.assign(new Error("Message no longer exists"), {
        permanent: true,
        reasonCode: "MESSAGE_NOT_FOUND",
      });
    }
    return {
      method: "sendMessage",
      args: {
        conversationId: job.message.conversationId,
        message: {
          id: job.message.id,
          text: job.message.content,
          type: job.message.type,
        },
        connection: context.connection,
      },
      entityType: "MESSAGE",
      entityId: job.message.id,
    };
  }

  if (job.jobType === "REPLY_COMMENT") {
    if (!job.comment) {
      throw Object.assign(new Error("Comment reply no longer exists"), {
        permanent: true,
        reasonCode: "COMMENT_NOT_FOUND",
      });
    }
    return {
      method: "replyToComment",
      args: {
        providerCommentId:
          job.comment.parent?.providerCommentId || job.comment.providerCommentId,
        text: job.comment.text,
        connection: context.connection,
      },
      entityType: "COMMENT",
      entityId: job.comment.id,
    };
  }

  if (["HIDE_COMMENT", "DELETE_COMMENT"].includes(job.jobType)) {
    if (!job.comment) {
      throw Object.assign(new Error("Comment no longer exists"), {
        permanent: true,
        reasonCode: "COMMENT_NOT_FOUND",
      });
    }
    return {
      method: "moderateComment",
      args: {
        providerCommentId: job.comment.providerCommentId,
        action: job.jobType === "DELETE_COMMENT" ? "DELETE" : "HIDE",
        connection: context.connection,
      },
      entityType: "COMMENT",
      entityId: job.comment.id,
    };
  }

  if (job.jobType === "DELETE_PROVIDER_POST") {
    if (!job.publication) {
      throw Object.assign(new Error("Publication no longer exists"), {
        permanent: true,
        reasonCode: "PUBLICATION_NOT_FOUND",
      });
    }
    return {
      method: "deletePost",
      args: {
        providerPublicationId: job.publication.providerPostId,
        connection: context.connection,
      },
      entityType: "PUBLICATION",
      entityId: job.publication.id,
    };
  }

  if (job.jobType === "SYNC_PROVIDER_CONTENT") {
    return {
      method: "listContent",
      args: {
        identity: context.identity,
        since: context.identity.syncState?.lastContentSync || null,
        until: new Date(),
        cursor: context.identity.syncState?.contentCursor || null,
        connection: context.connection,
      },
      entityType: "IDENTITY",
      entityId: context.identity.id,
    };
  }

  if (job.jobType === "SYNC_COMMENTS") {
    return {
      method: "listComments",
      args: {
        providerPublicationId: job.providerContent?.providerContentId,
        cursor: context.identity.syncState?.commentCursor || null,
        connection: context.connection,
      },
      entityType: "PROVIDER_CONTENT",
      entityId: job.providerContentId,
    };
  }

  if (job.jobType === "SYNC_MESSAGES") {
    return {
      method: "listConversations",
      args: {
        identity: context.identity,
        cursor: context.identity.syncState?.messageCursor || null,
        connection: context.connection,
      },
      entityType: "IDENTITY",
      entityId: context.identity.id,
    };
  }

  if (job.jobType === "SYNC_METRICS") {
    return {
      method: "listContentMetrics",
      args: {
        identity: context.identity,
        providerContentIds: job.providerContent
          ? [job.providerContent.providerContentId]
          : [],
        cursor: context.identity.syncState?.metricCursor || null,
        connection: context.connection,
      },
      entityType: "PROVIDER_CONTENT",
      entityId: job.providerContentId,
    };
  }

  if (job.jobType === "POLL_PUBLICATION") {
    return {
      method: "getPublishStatus",
      args: {
        providerPublicationId: job.publication?.providerPostId,
        connection: context.connection,
      },
      entityType: "PUBLICATION",
      entityId: job.publicationId,
    };
  }

  return connectorMethodForJob(job.jobType);
}

async function applyActionSuccess({ context, result, operation, db }) {
  const { job, identity } = context;
  if (job.jobType === "SYNC_PROVIDER_CONTENT" && Array.isArray(result?.items)) {
    for (const item of result.items) {
      const normalized = validateNormalizedProviderContent(item);
      await db.socialProviderContent.upsert({
        where: {
          identityId_providerContentId: {
            identityId: identity.id,
            providerContentId: normalized.providerContentId,
          },
        },
        update: {
          contentType: normalized.contentType,
          text: normalized.text,
          providerUrl: normalized.providerUrl,
          providerUpdatedAt: normalized.providerUpdatedAt
            ? new Date(normalized.providerUpdatedAt)
            : null,
          metadataJson: normalized.metadata,
        },
        create: {
          identityId: identity.id,
          providerContentId: normalized.providerContentId,
          source: "PROVIDER_IMPORTED",
          contentType: normalized.contentType,
          text: normalized.text,
          providerUrl: normalized.providerUrl,
          providerCreatedAt: normalized.providerCreatedAt
            ? new Date(normalized.providerCreatedAt)
            : null,
          providerUpdatedAt: normalized.providerUpdatedAt
            ? new Date(normalized.providerUpdatedAt)
            : null,
          metadataJson: normalized.metadata,
        },
      });
    }
    await updateIdentitySyncCheckpoint({
      identityId: identity.id,
      scope: "content",
      cursor: result.nextCursor || null,
      db,
    });
  }

  if (job.jobType === "DELETE_PROVIDER_POST" && job.publicationId) {
    await db.socialPublication.update({
      where: { id: job.publicationId },
      data: { status: "DELETED" },
    });
  }

  return { operation };
}

async function markActionFailure({
  context,
  startedAt,
  error,
  db,
  now,
  random,
}) {
  const { job, identity } = context;
  const finishedAt = now();
  const attemptNo = job.attemptCount + 1;
  const retry = planExecutionFailure({
    error,
    nextAttemptNumber: attemptNo,
    maxAttempts: job.maxAttempts,
    now: finishedAt,
    random,
  });
  const status = retry.retryable ? "RETRY_SCHEDULED" : "FAILED";

  await createActionAttempt({
    jobId: job.id,
    attemptNo,
    resultStatus: status,
    errorCategory: retry.errorCategory,
    sanitizedError: retry.sanitizedError,
    responseMetaJson: attemptMeta({
      provider: identity?.connection?.provider,
      identityId: identity?.id,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      providerStatus: "FAILED",
      operation: job.jobType,
    }),
    startedAt,
    finishedAt,
    db,
  });

  await db.socialActionJob.update({
    where: { id: job.id },
    data: {
      status,
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

  return { status, retryable: retry.retryable, errorCategory: retry.errorCategory };
}

async function updatePollActionJob({
  context,
  startedAt,
  resultStatus,
  providerStatus,
  jobStatus,
  errorCategory = null,
  sanitizedError = null,
  nextAttemptAt = null,
  completedAt,
  db,
  now,
}) {
  const { job, identity } = context;
  const finishedAt = now();
  const attemptNo = job.attemptCount + 1;
  await createActionAttempt({
    jobId: job.id,
    attemptNo,
    resultStatus,
    errorCategory,
    sanitizedError,
    responseMetaJson: attemptMeta({
      provider: identity?.connection?.provider,
      identityId: identity?.id,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      providerStatus,
      providerPostId: job.publication?.providerPostId,
      operation: "getPublishStatus",
    }),
    startedAt,
    finishedAt,
    db,
  });

  await db.socialActionJob.update({
    where: { id: job.id },
    data: {
      status: jobStatus,
      attemptCount: { increment: 1 },
      nextAttemptAt,
      completedAt,
      lastErrorCategory: errorCategory,
      lastError: sanitizedError,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });

  return {
    status: jobStatus,
    publicationStatus: providerStatus,
    retryable: jobStatus === "RETRY_SCHEDULED",
    errorCategory,
  };
}

function pollBackoffError(status, providerResult = {}) {
  return {
    retryable: true,
    message: `Publication status is ${status}`,
    retryAfter:
      providerResult.retryAfter ||
      providerResult.retryAfterSeconds ||
      providerResult.retryAfterAt,
  };
}

async function executePollPublicationJob({
  context,
  startedAt,
  workerId,
  db,
  connectorResolver,
  heartbeatFactory,
  now,
  random,
}) {
  const { job } = context;
  const publication = job.publication;
  if (!publication) {
    throw Object.assign(new Error("Publication no longer exists"), {
      permanent: true,
      reasonCode: "PUBLICATION_NOT_FOUND",
    });
  }

  if (publication.status === "PUBLISHED") {
    return updatePollActionJob({
      context,
      startedAt,
      resultStatus: "SUCCEEDED",
      providerStatus: "ALREADY_PUBLISHED",
      jobStatus: "SUCCEEDED",
      completedAt: now(),
      db,
      now,
    });
  }

  if (POLL_TERMINAL_NO_PROVIDER_STATUSES.includes(publication.status)) {
    return updatePollActionJob({
      context,
      startedAt,
      resultStatus: "SUCCEEDED",
      providerStatus: "NOT_POLLABLE",
      jobStatus: "SUCCEEDED",
      completedAt: now(),
      db,
      now,
    });
  }

  const identity = context.identity || publication.target?.identity;
  const { connector, capabilities } = await connectorForIdentity(
    identity,
    connectorResolver,
  );
  const policy = await evaluateActionExecution({
    identity,
    requiredCapability: "getPublishStatus",
    capability: capabilities.getPublishStatus,
    settings: await loadSocialSettings(db),
  });
  if (!policy.allowed) {
    throw Object.assign(new Error(policy.reasonCode), {
      permanent: !policy.retryable,
      retryable: policy.retryable,
      reasonCode: policy.reasonCode,
      capabilityStatus: capabilities.getPublishStatus?.status,
      retryAfter: capabilities.getPublishStatus?.retryAt,
    });
  }

  await db.socialActionJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", heartbeatAt: now() },
  });
  const heartbeat = heartbeatFactory({
    queue: "action",
    jobId: job.id,
    workerId,
    db,
  });

  try {
    const providerResult = await connector.getPublishStatus({
      providerPublicationId: publication.providerPostId,
      publication,
      connection: identity.connection,
    });
    const normalized = normalizePublicationStatusResult({
      provider: identity.connection.provider,
      result: providerResult,
    });
    const finishedAt = now();
    await transitionPublicationStatus({
      publicationId: publication.id,
      publication,
      nextStatus: normalized.status,
      providerPostId: normalized.providerPostId,
      url: normalized.url,
      postingMode: normalized.postingMode || publication.postingMode,
      providerTimestamp:
        providerResult.publishedAt ||
        providerResult.providerTimestamp ||
        providerResult.providerPublishedAt ||
        finishedAt,
      source: PUBLICATION_STATUS_TRANSITION_SOURCES.POLL,
      identityId: identity.id,
      ensurePoll: false,
      db,
      now: finishedAt,
    });

    if (normalized.status === "PUBLISHED") {
      return updatePollActionJob({
        context,
        startedAt,
        resultStatus: "SUCCEEDED",
        providerStatus: "PUBLISHED",
        jobStatus: "SUCCEEDED",
        completedAt: finishedAt,
        db,
        now,
      });
    }

    if (normalized.status === "FAILED_PERMANENT") {
      return updatePollActionJob({
        context,
        startedAt,
        resultStatus: "FAILED",
        providerStatus: "FAILED_PERMANENT",
        jobStatus: "FAILED",
        errorCategory: "PERMANENT",
        sanitizedError: "Publication failed permanently at provider",
        completedAt: finishedAt,
        db,
        now,
      });
    }

    const retry = planExecutionFailure({
      error: pollBackoffError(normalized.status, providerResult),
      nextAttemptNumber: job.attemptCount + 1,
      maxAttempts: job.maxAttempts,
      now: finishedAt,
      random,
    });

    return updatePollActionJob({
      context,
      startedAt,
      resultStatus: retry.retryable ? "RETRY_SCHEDULED" : "FAILED",
      providerStatus: normalized.status,
      jobStatus: retry.retryable ? "RETRY_SCHEDULED" : "FAILED",
      errorCategory: retry.errorCategory,
      sanitizedError: retry.sanitizedError,
      nextAttemptAt: retry.nextAttemptAt,
      completedAt: retry.retryable ? null : finishedAt,
      db,
      now,
    });
  } finally {
    if (heartbeat?.stop) await heartbeat.stop();
  }
}

async function executeActionJob({
  jobId,
  workerId,
  db = prisma,
  connectorResolver = getConnector,
  heartbeatFactory = startHeartbeat,
  now = () => new Date(),
  random = Math.random,
} = {}) {
  const startedAt = now();
  const context = await loadActionJobContext({ jobId, db });
  const { job, identity } = context;
  const attemptNo = job.attemptCount + 1;
  const capabilityName = connectorMethodForJob(job.jobType);

  try {
    if (job.jobType === "POLL_PUBLICATION") {
      return await executePollPublicationJob({
        context,
        startedAt,
        workerId,
        db,
        connectorResolver,
        heartbeatFactory,
        now,
        random,
      });
    }

    const { connector, capabilities } = await connectorForIdentity(
      identity,
      connectorResolver,
    );
    const policy = await evaluateActionExecution({
      identity,
      requiredCapability: capabilityName,
      capability: capabilities[capabilityName],
      settings: await loadSocialSettings(db),
    });
    if (!policy.allowed) {
      throw Object.assign(new Error(policy.reasonCode), {
        permanent: !policy.retryable,
        reasonCode: policy.reasonCode,
        capabilityStatus: capabilities[capabilityName]?.status,
      });
    }

    const operation = actionOperationPayload({ context });
    await db.socialActionJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", heartbeatAt: now() },
    });
    const heartbeat = heartbeatFactory({
      queue: "action",
      jobId: job.id,
      workerId,
      db,
    });

    try {
      const result = await connector[operation.method](operation.args);
      await applyActionSuccess({ context, result, operation, db });
      const finishedAt = now();
      await createActionAttempt({
        jobId: job.id,
        attemptNo,
        resultStatus: "SUCCEEDED",
        errorCategory: null,
        sanitizedError: null,
        responseMetaJson: attemptMeta({
          provider: identity.connection.provider,
          identityId: identity.id,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          providerStatus: "SUCCEEDED",
          operation: operation.method,
        }),
        startedAt,
        finishedAt,
        db,
      });
      await db.socialActionJob.update({
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
      return { status: "SUCCEEDED", operation: operation.method };
    } finally {
      if (heartbeat?.stop) await heartbeat.stop();
    }
  } catch (error) {
    return markActionFailure({ context, startedAt, error, db, now, random });
  }
}

module.exports = {
  ACTION_CAPABILITY_BY_TYPE,
  loadActionJobContext,
  connectorMethodForJob,
  actionOperationPayload,
  executePollPublicationJob,
  executeActionJob,
};
