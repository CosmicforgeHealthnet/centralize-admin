const { prisma } = require("../../../../shared/config/database");
const { getConnector } = require("../connectors/connector.registry");
const { CAPABILITY_STATUS } = require("../connectors/connector.constants");
const {
  evaluateJobExecutionPolicy,
} = require("../governance/job-execution.policy");
const {
  publishSocialEvent,
  SOCIAL_DOMAIN_EVENTS,
} = require("./social-domain-events.service");
const { sanitizeError, planRetry } = require("../workers/retry-policy");

async function loadSocialSettings(db = prisma) {
  return db.socialOperationsSetting.findMany({
    select: { key: true, valueJson: true },
  });
}

async function approvedRevisionForPost({ postId, db = prisma }) {
  const approval = await db.socialPostApproval.findFirst({
    where: { postId, decision: "APPROVED" },
    orderBy: { decidedAt: "desc" },
    include: { revision: true },
  });
  return approval?.revision || null;
}

async function currentRevisionForPost({ postId, db = prisma }) {
  return db.socialPostRevision.findFirst({
    where: { postId },
    orderBy: { version: "desc" },
  });
}

async function connectorForIdentity(identity, connectorResolver = getConnector) {
  const connector = connectorResolver(identity.connection.provider);
  const capabilities = await connector.getCapabilities({
    identity,
    connection: identity.connection,
  });
  return { connector, capabilities };
}

async function evaluatePublicationExecution({
  publication,
  identity,
  requiredCapability = "publishPost",
  capability,
  db = prisma,
}) {
  const post = publication.target.post;
  return evaluateJobExecutionPolicy({
    connection: identity.connection,
    identity,
    requiredCapability,
    capability,
    publication: { postVersion: publication.postVersion, postId: post.id },
    approvedRevision: await approvedRevisionForPost({ postId: post.id, db }),
    currentRevision: await currentRevisionForPost({ postId: post.id, db }),
    settings: await loadSocialSettings(db),
  });
}

function deny(reasonCode, message, category = "PERMANENT") {
  return {
    allowed: false,
    retryable: false,
    errorCategory: category,
    reasonCode,
    message,
  };
}

async function evaluateActionExecution({
  identity,
  capability,
  requiredCapability,
  settings,
} = {}) {
  if (!identity) return deny("IDENTITY_NOT_FOUND", "The Social identity no longer exists.");
  if (!identity.connection) {
    return deny("CONNECTION_NOT_FOUND", "The Social connection no longer exists.");
  }
  if (identity.connection.status !== "ACTIVE") {
    return deny("CONNECTION_NOT_ACTIVE", "The Social connection is not active.");
  }
  if (identity.connection.requiresReauthorization) {
    return deny(
      "CONNECTION_REAUTHORIZATION_REQUIRED",
      "The Social connection requires reauthorization.",
      "AUTH_REQUIRED",
    );
  }
  if (identity.disabledAt) {
    return deny("IDENTITY_DISABLED", "The Social identity is disabled.");
  }

  const blockedProviders = settings.find(
    (setting) => setting.key === "social.policy.blocked_providers",
  )?.valueJson;
  if (Array.isArray(blockedProviders) && blockedProviders.includes(identity.connection.provider)) {
    return deny("PROVIDER_BLOCKED_BY_POLICY", "Provider is blocked by policy.");
  }

  const blockedIdentities = settings.find(
    (setting) => setting.key === "social.policy.blocked_identity_ids",
  )?.valueJson;
  if (Array.isArray(blockedIdentities) && blockedIdentities.includes(identity.id)) {
    return deny("IDENTITY_BLOCKED_BY_POLICY", "Identity is blocked by policy.");
  }

  if (!capability || capability.status !== CAPABILITY_STATUS.AVAILABLE) {
    if (capability?.status === CAPABILITY_STATUS.RATE_LIMITED && capability.retryAt) {
      return {
        allowed: false,
        retryable: true,
        errorCategory: "RATE_LIMITED",
        reasonCode: "PROVIDER_RATE_LIMITED",
        message: "Provider is rate limited.",
      };
    }
    return deny(
      "CAPABILITY_NOT_AVAILABLE",
      `${requiredCapability || "Provider capability"} is not currently available.`,
      "PROVIDER_POLICY",
    );
  }

  return {
    allowed: true,
    retryable: false,
    errorCategory: null,
    reasonCode: null,
    message: null,
  };
}

async function publishFailureEvent({ publicationId, jobId, reasonCode }) {
  await publishSocialEvent({
    type: SOCIAL_DOMAIN_EVENTS.SOCIAL_PUBLICATION_FAILED,
    payload: { publicationId, jobId, reasonCode },
  });
}

function attemptMeta({
  provider,
  identityId,
  durationMs,
  providerStatus,
  providerPostId,
  idempotencyKey,
  operation,
}) {
  return {
    provider,
    identityId,
    durationMs,
    providerStatus,
    providerPostId,
    idempotencyKey,
    operation,
  };
}

function planExecutionFailure({ error, nextAttemptNumber, maxAttempts, now, random }) {
  const retry = planRetry({
    attemptNumber: nextAttemptNumber,
    maxAttempts,
    error,
    now,
    random,
  });
  return {
    ...retry,
    sanitizedError: retry.sanitizedError || sanitizeError(error),
  };
}

module.exports = {
  loadSocialSettings,
  approvedRevisionForPost,
  currentRevisionForPost,
  connectorForIdentity,
  evaluatePublicationExecution,
  evaluateActionExecution,
  publishFailureEvent,
  attemptMeta,
  planExecutionFailure,
};
