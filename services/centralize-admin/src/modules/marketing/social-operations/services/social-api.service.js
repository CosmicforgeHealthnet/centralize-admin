const crypto = require("crypto");
const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { createAuditLog } = require("../../../../shared/middlewares/audit.middleware");
const { getConnector } = require("../connectors/connector.registry");
const { CAPABILITY_STATUS } = require("../connectors/connector.constants");
const { ConnectorError } = require("../connectors/connector.errors");
const {
  canApprovePost,
  planApprovedTargetEdit,
} = require("../governance/approval-governance.service");
const {
  evaluateJobExecutionPolicy,
} = require("../governance/job-execution.policy");
const {
  sanitizeForResponse,
  sanitizeConnectionRecord,
  sanitizeOperationRecord,
} = require("./sanitization.service");
const {
  publishSocialEvent,
  SOCIAL_DOMAIN_EVENTS,
} = require("./social-domain-events.service");
const { canViewRestricted } = require("./social-authorization.service");
const { enqueueContentSync } = require("./reconciliation.service");
const {
  cancelPendingPublishingJobsForPostEdit,
  assertJobCancellable,
} = require("./scheduling.service");
const {
  createOAuthState,
  consumeOAuthState,
} = require("../security/oauth-state.service");
const {
  validateActionPayload,
} = require("../security/sensitive-payload.validator");
const { hmacContent } = require("../security/content-hash.service");
const {
  PRIVATE_STATES,
} = require("../privacy/export-privacy.policy");
const {
  assertRestrictedContentAccess,
} = require("../privacy/restricted-content-query.policy");
const {
  createOrReuseEscalation,
} = require("../safety/escalation.service");
const logger = require("../../../../shared/utils/logger");
const {
  createMediaStorageAdapter,
} = require("../media/storage/media-storage.factory");
const {
  resolveMediaStorageConfig,
} = require("../media/storage/media-storage.config");
const {
  STORAGE_PROVIDER,
  allowedMimeTypes,
  assertAllowedMimeType,
  maxBytesForMime,
  resourceTypeFromMime,
  sanitizeProviderMetadata,
} = require("../media/storage/media-storage.interface");
const {
  MediaStorageError,
} = require("../media/storage/media-storage.errors");
const {
  fetchRemoteMediaSafely,
} = require("../security/ssrf-safe-fetch.service");
const {
  writeSocialAudit,
} = require("../security/social-audit.service");
const {
  getSocialOperationsHealth,
} = require("../observability/operations-health.service");

const SAFE_CONNECTION_SELECT = Object.freeze({
  id: true,
  provider: true,
  providerConnectionId: true,
  scopes: true,
  status: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
  requiresReauthorization: true,
  lastTestedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { identities: true, webhookSubscriptions: true } },
});

const IDENTITY_INCLUDE_CONNECTION = Object.freeze({
  connection: {
    select: {
      id: true,
      provider: true,
      status: true,
      requiresReauthorization: true,
    },
  },
});

function adminId(context) {
  const id = context?.adminUser?.id;
  if (!id) throw new ApiError(401, "Unauthorized");
  return id;
}

function nowDate() {
  return new Date();
}

function idempotencyKey(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).join(":"))
    .digest("hex");
}

function serializeList(rows) {
  return rows.map((row) => sanitizeForResponse(row));
}

async function writeSafeMediaAudit({
  operation,
  ownerId,
  assetId,
  metadata,
  auditWriter = writeSocialAudit,
} = {}) {
  try {
    await auditWriter({
      adminUserId: ownerId || null,
      operation,
      targetId: assetId || null,
      targetType: "SOCIAL_MEDIA_ASSET",
      metadata: sanitizeProviderMetadata(metadata || {}),
    });
  } catch (error) {
    logger.warn(
      `[SocialOperations] media audit failed: ${error.code || error.message || "unknown"}`,
    );
  }
}

async function ensureAdminOwner({ ownerId, db = prisma } = {}) {
  const owner = await db.adminUser.findUnique({
    where: { id: ownerId },
    select: { id: true },
  });
  if (!owner) throw new ApiError(403, "Social media owner is not valid");
  return owner;
}

function safeFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    return tail || "remote-media";
  } catch {
    return "remote-media";
  }
}

async function normalizeMediaUploadSource({
  body,
  file,
  storageConfig,
  remoteMediaFetcher,
  remoteMediaResolver,
} = {}) {
  if (file?.buffer) {
    return {
      buffer: Buffer.from(file.buffer),
      filename: file.originalname || "media",
      mimeType: file.mimetype || body?.mimeType,
      sizeBytes: Number(file.size || file.buffer.length),
      sourceKind: "multipart",
    };
  }

  if (!body?.url) throw new ApiError(400, "Social media asset is required");
  if (!remoteMediaFetcher) {
    throw new ApiError(400, "Remote media ingestion requires a safe fetcher");
  }

  const fetched = await fetchRemoteMediaSafely({
    url: body.url,
    fetcher: remoteMediaFetcher,
    resolver: remoteMediaResolver,
    allowedContentTypes: allowedMimeTypes(storageConfig),
    maxBytes: Math.max(storageConfig.imageMaxBytes, storageConfig.videoMaxBytes),
    timeoutMs: storageConfig.uploadTimeoutMs,
    allowHttpLocalTest: process.env.NODE_ENV === "test",
  });

  return {
    buffer: fetched.body,
    filename: safeFileNameFromUrl(fetched.url),
    mimeType: fetched.contentType || body.mimeType,
    sizeBytes: fetched.body.length,
    sourceKind: "remote",
  };
}

function mapStorageError(error) {
  if (!(error instanceof MediaStorageError)) throw error;
  throw new ApiError(error.statusCode || 500, error.message, [
    {
      reasonCode: error.code,
      retryable: Boolean(error.retryable),
      ...(error.details || {}),
    },
  ]);
}

function providerMetadataFromAsset(asset) {
  return asset?.processingMetadataJson?.providerMetadata || {};
}

function resourceTypeFromAsset(asset) {
  return (
    asset?.processingMetadataJson?.resourceType ||
    providerMetadataFromAsset(asset).resourceType ||
    resourceTypeFromMime(asset?.mimeType)
  );
}

function mapConnectorError(error) {
  if (!(error instanceof ConnectorError)) throw error;
  throw new ApiError(409, error.reasonCode || "Provider operation unavailable", {
    platform: error.platform,
    operation: error.operation,
    capabilityStatus: error.capabilityStatus,
    reasonCode: error.reasonCode,
  });
}

async function loadSettings(db = prisma) {
  return db.socialOperationsSetting.findMany({
    select: { key: true, valueJson: true },
  });
}

async function currentRevision(postId, db = prisma) {
  return db.socialPostRevision.findFirst({
    where: { postId },
    orderBy: { version: "desc" },
  });
}

async function approvedRevisionForPost(postId, db = prisma) {
  const approval = await db.socialPostApproval.findFirst({
    where: { postId, decision: "APPROVED" },
    orderBy: { decidedAt: "desc" },
    include: { revision: true },
  });
  return approval?.revision || null;
}

async function ensurePost(postId, db = prisma) {
  const post = await db.socialPost.findUnique({
    where: { id: postId },
    include: {
      revisions: { orderBy: { version: "desc" }, take: 1 },
      targets: { include: { identity: { include: IDENTITY_INCLUDE_CONNECTION } } },
    },
  });
  if (!post) throw new ApiError(404, "Social post not found");
  return post;
}

async function ensureIdentity(identityId, db = prisma) {
  const identity = await db.socialPublishingIdentity.findUnique({
    where: { id: identityId },
    include: IDENTITY_INCLUDE_CONNECTION,
  });
  if (!identity) throw new ApiError(404, "Social identity not found");
  return identity;
}

async function computeCapabilities(identity) {
  const connector = getConnector(identity.connection.provider);
  return connector.getCapabilities({
    identity,
    connection: identity.connection,
  });
}

async function connectionList({ db = prisma } = {}) {
  const rows = await db.socialAccountConnection.findMany({
    select: SAFE_CONNECTION_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => sanitizeConnectionRecord(row));
}

async function startOAuth({
  provider,
  context,
  connectionId,
  redirectUri,
  db = prisma,
} = {}) {
  const stateRecord = await createOAuthState({
    provider,
    adminUserId: adminId(context),
    connectionContext: connectionId ? { connectionId } : {},
    redirectUri:
      redirectUri ||
      process.env.SOCIAL_OAUTH_DEFAULT_REDIRECT_URI ||
      process.env.SOCIAL_OPERATIONS_OAUTH_DEFAULT_REDIRECT_URI,
    db,
  });
  return {
    provider,
    state: stateRecord.state,
    expiresAt: stateRecord.expiresAt,
    pkceChallenge: stateRecord.pkceChallenge,
    pkceMethod: stateRecord.pkceMethod,
    authorizationUrl: null,
    providerExchangeImplemented: false,
  };
}

async function verifyOAuthCallback({ provider, query, db = prisma } = {}) {
  const state = String(query?.state || "");
  if (!state) throw new ApiError(400, "OAuth state is required");
  await consumeOAuthState({
    provider,
    rawState: state,
    redirectUri:
      query?.redirectUri ||
      process.env.SOCIAL_OAUTH_DEFAULT_REDIRECT_URI ||
      process.env.SOCIAL_OPERATIONS_OAUTH_DEFAULT_REDIRECT_URI,
    db,
  });
  return {
    provider,
    connected: false,
    stateVerified: true,
    status: "PROVIDER_EXCHANGE_NOT_IMPLEMENTED",
  };
}

async function testConnection({ id, db = prisma } = {}) {
  const connection = await db.socialAccountConnection.findUnique({
    where: { id },
    include: { identities: true },
  });
  if (!connection) throw new ApiError(404, "Social connection not found");

  const connector = getConnector(connection.provider);
  const identities = await Promise.all(
    connection.identities.map(async (identity) => ({
      identityId: identity.id,
      providerIdentityId: identity.providerIdentityId,
      capabilities: await connector.getCapabilities({ identity, connection }),
    })),
  );

  await db.socialAccountConnection.update({
    where: { id },
    data: { lastTestedAt: nowDate() },
  });

  return { id, provider: connection.provider, identities };
}

async function reauthorizeConnection({ id, context, db = prisma } = {}) {
  const connection = await db.socialAccountConnection.findUnique({ where: { id } });
  if (!connection) throw new ApiError(404, "Social connection not found");
  return startOAuth({
    provider: connection.provider,
    context,
    connectionId: id,
    db,
  });
}

async function setConnectionStatus({ id, status, context, req, db = prisma } = {}) {
  const connection = await db.socialAccountConnection.update({
    where: { id },
    data: {
      status,
      requiresReauthorization: status === "ACTIVE" ? false : undefined,
    },
    select: SAFE_CONNECTION_SELECT,
  });

  await createAuditLog({
    adminUserId: adminId(context),
    action: "EMERGENCY_OVERRIDE_USED",
    targetId: id,
    targetType: "SOCIAL_ACCOUNT_CONNECTION",
    metadata: { operation: status === "DISABLED" ? "DISABLE" : "ENABLE" },
    req,
  });

  return sanitizeConnectionRecord(connection);
}

async function discoverIdentities({ id, db = prisma } = {}) {
  const connection = await db.socialAccountConnection.findUnique({ where: { id } });
  if (!connection) throw new ApiError(404, "Social connection not found");

  const connector = getConnector(connection.provider);
  try {
    return {
      provider: connection.provider,
      discovered: await connector.discoverIdentities({ connection }),
    };
  } catch (error) {
    if (error instanceof ConnectorError) {
      return {
        provider: connection.provider,
        discovered: [],
        providerRuntimeEnabled: false,
        reasonCode: error.reasonCode,
        capabilityStatus: error.capabilityStatus,
      };
    }
    throw error;
  }
}

async function identityList({ db = prisma } = {}) {
  const identities = await db.socialPublishingIdentity.findMany({
    include: IDENTITY_INCLUDE_CONNECTION,
    orderBy: { createdAt: "desc" },
  });

  return Promise.all(
    identities.map(async (identity) =>
      sanitizeForResponse({
        ...identity,
        capabilities: await computeCapabilities(identity),
      }),
    ),
  );
}

async function refreshIdentityCapabilities({ id, db = prisma } = {}) {
  const identity = await ensureIdentity(id, db);
  const capabilities = await computeCapabilities(identity);
  const updated = await db.socialPublishingIdentity.update({
    where: { id },
    data: { capabilitiesJson: capabilities },
    include: IDENTITY_INCLUDE_CONNECTION,
  });

  return sanitizeForResponse({ ...updated, capabilities });
}

async function createPost({ body, context, db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    const post = await tx.socialPost.create({
      data: {
        title: body.title,
        createdById: adminId(context),
        currentVersion: 1,
      },
    });

    const revision = await tx.socialPostRevision.create({
      data: {
        postId: post.id,
        version: 1,
        title: body.title,
        baseText: body.baseText,
        snapshotJson: {
          title: body.title,
          baseText: body.baseText,
          mediaAssetIds: body.mediaAssetIds || [],
          targets: body.targets || [],
        },
        changeSummary: "Initial draft",
        createdById: adminId(context),
      },
    });

    for (const target of body.targets || []) {
      await tx.socialPostTarget.create({
        data: {
          postId: post.id,
          identityId: target.identityId,
          text: target.text || body.baseText,
          optionsJson: target.options || {},
          scheduledForUtc: target.scheduledForUtc
            ? new Date(target.scheduledForUtc)
            : null,
          timezone: target.timezone || null,
        },
      });
    }

    return sanitizeForResponse({ ...post, revisions: [revision] });
  });
}

async function listPosts({ pagination, db = prisma } = {}) {
  return serializeList(
    await db.socialPost.findMany({
      take: pagination?.limit || 50,
      orderBy: { updatedAt: "desc" },
      include: {
        revisions: { orderBy: { version: "desc" }, take: 1 },
        targets: true,
      },
    }),
  );
}

async function readPost({ id, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialPost.findUniqueOrThrow({
      where: { id },
      include: {
        revisions: { orderBy: { version: "desc" } },
        targets: { include: { media: true, publications: true } },
        approvals: { orderBy: { createdAt: "desc" } },
      },
    }),
  );
}

async function updatePost({ id, body, context, db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    const post = await ensurePost(id, tx);
    const latest = post.revisions[0];
    const targetPlan = planApprovedTargetEdit({
      target: post.targets[0],
      currentRevision: latest,
      changes: body,
    });
    const version = (latest?.version || post.currentVersion || 1) + 1;
    const baseText = body.baseText || latest?.baseText || "";
    const title = body.title === undefined ? post.title : body.title;

    const revision = await tx.socialPostRevision.create({
      data: {
        postId: post.id,
        version,
        title,
        baseText,
        snapshotJson: {
          title,
          baseText,
          mediaAssetIds: body.mediaAssetIds || [],
          reapprovalRequired: targetPlan.reapprovalRequired,
        },
        changeSummary: body.changeSummary || "Draft updated",
        createdById: adminId(context),
      },
    });

    await tx.socialPost.update({
      where: { id },
      data: {
        title,
        status: targetPlan.reapprovalRequired ? "DRAFT" : post.status,
        currentVersion: version,
      },
    });

    if (targetPlan.reapprovalRequired) {
      await tx.socialPostTarget.updateMany({
        where: { postId: post.id },
        data: { status: "DRAFT", contentVersion: { increment: 1 } },
      });
      await cancelPendingPublishingJobsForPostEdit({ postId: post.id, db: tx });
    }

    return sanitizeForResponse({ postId: post.id, revision });
  });
}

async function deletePost({ id, db = prisma } = {}) {
  const post = await db.socialPost.findUnique({ where: { id } });
  if (!post) throw new ApiError(404, "Social post not found");
  if (!["DRAFT", "REJECTED", "CANCELLED"].includes(post.status)) {
    throw new ApiError(409, "Only safe draft-like Social posts can be deleted");
  }
  await db.socialPost.delete({ where: { id } });
  return { id, deleted: true };
}

async function duplicatePost({ id, context, db = prisma } = {}) {
  const source = await ensurePost(id, db);
  const latest = source.revisions[0];

  return db.$transaction(async (tx) => {
    const post = await tx.socialPost.create({
      data: {
        title: source.title ? `${source.title} Copy` : null,
        createdById: adminId(context),
        currentVersion: 1,
      },
    });
    const revision = await tx.socialPostRevision.create({
      data: {
        postId: post.id,
        version: 1,
        title: post.title,
        baseText: latest?.baseText || "",
        snapshotJson: latest?.snapshotJson || {},
        changeSummary: "Duplicated draft",
        createdById: adminId(context),
      },
    });
    for (const target of source.targets) {
      await tx.socialPostTarget.create({
        data: {
          postId: post.id,
          identityId: target.identityId,
          text: target.text,
          optionsJson: target.optionsJson || {},
          timezone: target.timezone,
        },
      });
    }
    return sanitizeForResponse({ ...post, revisions: [revision] });
  });
}

async function listPostVersions({ id, db = prisma } = {}) {
  return serializeList(
    await db.socialPostRevision.findMany({
      where: { postId: id },
      orderBy: { version: "desc" },
    }),
  );
}

async function submitPost({ id, context, db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    const post = await ensurePost(id, tx);
    const revision = post.revisions[0];
    if (!revision) throw new ApiError(409, "Post has no revision to submit");

    const approval = await tx.socialPostApproval.create({
      data: {
        postId: post.id,
        revisionId: revision.id,
        submittedById: adminId(context),
      },
    });

    await tx.socialPost.update({
      where: { id },
      data: { status: "PENDING_APPROVAL" },
    });
    await tx.socialPostTarget.updateMany({
      where: { postId: id },
      data: { status: "PENDING_APPROVAL" },
    });

    await publishSocialEvent({
      type: SOCIAL_DOMAIN_EVENTS.SOCIAL_POST_SUBMITTED,
      payload: { postId: id, revisionId: revision.id, submittedById: adminId(context) },
    });

    return sanitizeForResponse({ postId: id, approval });
  });
}

async function decideApproval({ id, decision, reason, context, db = prisma } = {}) {
  const post = await ensurePost(id, db);
  const revision = post.revisions[0];
  const settings = await loadSettings(db);
  const approvalDecision = canApprovePost({
    actorId: adminId(context),
    authorId: post.createdById,
    settings,
  });
  if (decision === "APPROVED" && !approvalDecision.allowed) {
    throw new ApiError(403, approvalDecision.message);
  }

  if (["REJECTED", "CHANGES_REQUESTED"].includes(decision) && !reason) {
    throw new ApiError(400, "reason is required");
  }

  const status =
    decision === "APPROVED"
      ? "APPROVED"
      : decision === "REJECTED"
        ? "REJECTED"
        : "DRAFT";

  const approval = await db.socialPostApproval.create({
    data: {
      postId: post.id,
      revisionId: revision.id,
      submittedById: post.createdById,
      decidedById: adminId(context),
      decision,
      reason,
      decidedAt: nowDate(),
    },
  });

  await db.socialPost.update({ where: { id }, data: { status } });
  await db.socialPostTarget.updateMany({
    where: { postId: id },
    data: { status: decision === "APPROVED" ? "APPROVED" : "DRAFT" },
  });

  await publishSocialEvent({
    type:
      decision === "APPROVED"
        ? SOCIAL_DOMAIN_EVENTS.SOCIAL_POST_APPROVED
        : SOCIAL_DOMAIN_EVENTS.SOCIAL_POST_REJECTED,
    payload: { postId: id, revisionId: revision.id, decision, reason },
  });

  return sanitizeForResponse({ postId: id, approval });
}

async function validateTargetForPublishing({ post, target, capabilityName, db }) {
  const identity = await ensureIdentity(target.identityId, db);
  const capabilities = await computeCapabilities(identity);
  const approvedRevision = await approvedRevisionForPost(post.id, db);
  const latestRevision = await currentRevision(post.id, db);
  const publicationPolicy = evaluateJobExecutionPolicy({
    connection: identity.connection,
    identity,
    requiredCapability: capabilityName,
    capability: capabilities[capabilityName],
    publication: { postVersion: post.currentVersion, postId: post.id },
    approvedRevision,
    currentRevision: latestRevision,
    settings: await loadSettings(db),
  });

  if (!publicationPolicy.allowed) {
    throw new ApiError(409, publicationPolicy.message, publicationPolicy);
  }
  return { identity, capabilities };
}

async function enqueuePublication({ post, target, requestedById, scheduledForUtc, db }) {
  const publication = await db.socialPublication.upsert({
    where: {
      targetId_postVersion: {
        targetId: target.id,
        postVersion: post.currentVersion,
      },
    },
    update: { status: "PENDING" },
    create: {
      targetId: target.id,
      postVersion: post.currentVersion,
      requestedById,
      status: "PENDING",
      idempotencyKey: idempotencyKey("publication", target.id, post.currentVersion),
    },
  });

  const job = await db.socialPublishingJob.upsert({
    where: { publicationId: publication.id },
    update: {
      status: "PENDING",
      scheduledForUtc,
      nextAttemptAt: null,
      lastError: null,
      lastErrorCategory: null,
    },
    create: {
      publicationId: publication.id,
      scheduledForUtc,
      status: "PENDING",
    },
  });

  return { publication, job };
}

async function publishPost({ id, body, context, db = prisma } = {}) {
  const post = await ensurePost(id, db);
  if (post.status !== "APPROVED") {
    throw new ApiError(409, "Only approved Social posts can be published");
  }
  const targets = post.targets;
  const queued = [];
  for (const target of targets) {
    await validateTargetForPublishing({
      post,
      target,
      capabilityName: "publishPost",
      db,
    });
    queued.push(
      await enqueuePublication({
        post,
        target,
        requestedById: adminId(context),
        scheduledForUtc: nowDate(),
        db,
      }),
    );
  }
  await publishSocialEvent({
    type: SOCIAL_DOMAIN_EVENTS.SOCIAL_PUBLICATION_STARTED,
    payload: { postId: id, publicationCount: queued.length },
  });
  return sanitizeForResponse({ postId: id, queued });
}

async function schedulePost({ id, body, context, db = prisma } = {}) {
  const post = await ensurePost(id, db);
  if (post.status !== "APPROVED") {
    throw new ApiError(409, "Only approved Social posts can be scheduled");
  }

  const queued = [];
  for (const targetInput of body.targets) {
    const existingTarget =
      post.targets.find((target) => target.identityId === targetInput.identityId) ||
      (await db.socialPostTarget.create({
        data: {
          postId: post.id,
          identityId: targetInput.identityId,
          text: targetInput.text,
          optionsJson: targetInput.options || {},
          scheduledForUtc: targetInput.scheduledForUtc,
          timezone: targetInput.timezone,
          status: "APPROVED",
        },
      }));

    await validateTargetForPublishing({
      post,
      target: existingTarget,
      capabilityName: "publishPost",
      db,
    });
    await db.socialPostTarget.update({
      where: { id: existingTarget.id },
      data: {
        status: "SCHEDULED",
        scheduledForUtc: targetInput.scheduledForUtc,
        timezone: targetInput.timezone,
      },
    });
    queued.push(
      await enqueuePublication({
        post,
        target: existingTarget,
        requestedById: adminId(context),
        scheduledForUtc: targetInput.scheduledForUtc,
        db,
      }),
    );
  }

  await db.socialPost.update({ where: { id }, data: { status: "SCHEDULED" } });
  return sanitizeForResponse({ postId: id, queued });
}

async function listPublications({ db = prisma } = {}) {
  return serializeList(
    await db.socialPublication.findMany({
      orderBy: { createdAt: "desc" },
      include: { target: { include: { identity: true } }, job: true },
    }),
  );
}

async function readPublication({ id, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialPublication.findUniqueOrThrow({
      where: { id },
      include: { target: { include: { identity: true } }, job: true, attempts: true },
    }),
  );
}

async function listPostPublications({ id, db = prisma } = {}) {
  return serializeList(
    await db.socialPublication.findMany({
      where: { target: { postId: id } },
      orderBy: { createdAt: "desc" },
      include: { job: true, target: true },
    }),
  );
}

async function retryPublication({ id, db = prisma } = {}) {
  const publication = await db.socialPublication.findUnique({
    where: { id },
    include: { job: true },
  });
  if (!publication) throw new ApiError(404, "Publication not found");
  if (!["FAILED_RETRYABLE", "FAILED_PERMANENT"].includes(publication.status)) {
    throw new ApiError(409, "Publication is not retryable");
  }
  const job = await db.socialPublishingJob.update({
    where: { publicationId: id },
    data: { status: "PENDING", nextAttemptAt: null, lastError: null },
  });
  return sanitizeForResponse({ publicationId: id, job });
}

async function cancelPublication({ id, db = prisma } = {}) {
  const publication = await db.socialPublication.findUnique({
    where: { id },
    include: { job: true },
  });
  if (!publication) throw new ApiError(404, "Publication not found");
  assertJobCancellable(publication.job);
  await db.socialPublication.update({ where: { id }, data: { status: "CANCELLED" } });
  const job = publication.job
    ? await db.socialPublishingJob.update({
        where: { publicationId: id },
        data: { status: "CANCELLED", completedAt: nowDate() },
      })
    : null;
  return sanitizeForResponse({ publicationId: id, job });
}

async function enqueueDeleteProviderPost({ id, context, db = prisma } = {}) {
  const publication = await db.socialPublication.findUnique({
    where: { id },
    include: { target: { include: { identity: true } } },
  });
  if (!publication) throw new ApiError(404, "Publication not found");
  if (!publication.providerPostId) {
    throw new ApiError(409, "Publication has no provider post to delete");
  }
  const job = await db.socialActionJob.create({
    data: {
      jobType: "DELETE_PROVIDER_POST",
      identityId: publication.target.identityId,
      publicationId: publication.id,
      idempotencyKey: idempotencyKey("delete-provider-post", publication.id),
      payloadJson: validateActionPayload({ publicationId: publication.id }),
    },
  });
  return sanitizeOperationRecord({ job, requestedById: adminId(context) });
}

async function listContent({ db = prisma } = {}) {
  return serializeList(
    await db.socialProviderContent.findMany({
      orderBy: { providerCreatedAt: "desc" },
      include: { identity: true, publication: true },
    }),
  );
}

async function readContent({ id, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialProviderContent.findUniqueOrThrow({
      where: { id },
      include: { identity: true, publication: true },
    }),
  );
}

async function syncContent({ id, context, db = prisma } = {}) {
  return sanitizeOperationRecord(
    await enqueueContentSync({
      identityId: id,
      requestedById: adminId(context),
      db,
    }),
  );
}

async function listContentComments({ id, db = prisma } = {}) {
  return serializeList(
    await db.socialComment.findMany({
      where: { providerContentId: id },
      orderBy: { providerCreatedAt: "desc" },
    }),
  );
}

async function listContentMetrics({ id, db = prisma } = {}) {
  return serializeList(
    await db.socialProviderContentMetricSnapshot.findMany({
      where: { providerContentId: id },
      orderBy: { date: "desc" },
    }),
  );
}

async function createMedia({
  body,
  file,
  context,
  db = prisma,
  storageAdapter,
  storageConfig = resolveMediaStorageConfig(),
  remoteMediaFetcher,
  remoteMediaResolver,
  auditWriter = writeSocialAudit,
} = {}) {
  const ownerId = adminId(context);
  await ensureAdminOwner({ ownerId, db });
  const source = await normalizeMediaUploadSource({
    body,
    file,
    storageConfig,
    remoteMediaFetcher,
    remoteMediaResolver,
  });
  const mimeType = assertAllowedMimeType({
    mimeType: source.mimeType,
    buffer: source.buffer,
    config: storageConfig,
  });
  const sizeBytes = Number(source.sizeBytes || source.buffer.length);
  const maxBytes = maxBytesForMime({ mimeType, config: storageConfig });
  if (sizeBytes > maxBytes) {
    throw new ApiError(400, "Social media asset is too large", [
      { reasonCode: "SOCIAL_MEDIA_SIZE_LIMIT", maxBytes },
    ]);
  }
  const checksumSha256 = crypto.createHash("sha256").update(source.buffer).digest("hex");
  const existing = await db.socialMediaAsset.findUnique({
    where: {
      ownerId_checksumSha256: {
        ownerId,
        checksumSha256,
      },
    },
  });
  if (existing && !existing.deletedAt && existing.status !== "DELETED") {
    await writeSafeMediaAudit({
      operation: "SOCIAL_MEDIA_UPLOAD_DEDUPED",
      ownerId,
      assetId: existing.id,
      metadata: {
        storageProvider: existing.storageProvider,
        resourceType: resourceTypeFromAsset(existing),
        sizeBytes: String(existing.sizeBytes),
        checksumSha256,
      },
      auditWriter,
    });
    return sanitizeForResponse(existing);
  }

  const adapter = storageAdapter || createMediaStorageAdapter();
  let uploadResult;
  try {
    uploadResult = await adapter.upload({
      ownerId,
      filename: source.filename,
      mimeType,
      buffer: source.buffer,
      sizeBytes,
      checksumSha256,
      purpose: body?.purpose || "SOCIAL_POST_MEDIA",
      idempotencyKey: body?.idempotencyKey,
      providerTargetRequirements: body?.providerTargetRequirements,
    });
  } catch (error) {
    mapStorageError(error);
  }

  const assetData = {
    ownerId,
    storageProvider: uploadResult.storageProvider,
    storageKey: uploadResult.storageKey,
    url: uploadResult.secureUrl,
    secureUrl: uploadResult.secureUrl,
    mimeType: uploadResult.mimeType,
    sizeBytes: BigInt(uploadResult.sizeBytes),
    width: uploadResult.width || null,
    height: uploadResult.height || null,
    durationMs: uploadResult.durationSeconds
      ? Math.round(Number(uploadResult.durationSeconds) * 1000)
      : null,
    checksumSha256: uploadResult.checksumSha256,
    status: uploadResult.complete === false ? "PROCESSING" : "READY",
    deletedAt: null,
    processingMetadataJson: sanitizeProviderMetadata({
      resourceType: uploadResult.resourceType,
      providerMetadata: uploadResult.providerMetadata,
      idempotencyKeyHash: body?.idempotencyKey
        ? crypto.createHash("sha256").update(String(body.idempotencyKey)).digest("hex")
        : undefined,
      sourceKind: source.sourceKind,
    }),
  };

  try {
    const asset = existing
      ? await db.socialMediaAsset.update({
          where: { id: existing.id },
          data: assetData,
        })
      : await db.socialMediaAsset.create({ data: assetData });
    await writeSafeMediaAudit({
      operation: "SOCIAL_MEDIA_UPLOADED",
      ownerId,
      assetId: asset.id,
      metadata: {
        storageProvider: asset.storageProvider,
        resourceType: uploadResult.resourceType,
        sizeBytes: String(asset.sizeBytes),
        checksumSha256,
      },
      auditWriter,
    });
    return sanitizeForResponse(asset);
  } catch (error) {
    try {
      await adapter.delete({
        storageKey: uploadResult.storageKey,
        publicId: uploadResult.publicId,
        resourceType: uploadResult.resourceType,
      });
      await writeSafeMediaAudit({
        operation: "SOCIAL_MEDIA_UPLOAD_ROLLED_BACK",
        ownerId,
        metadata: {
          storageProvider: uploadResult.storageProvider,
          resourceType: uploadResult.resourceType,
          checksumSha256,
        },
        auditWriter,
      });
    } catch (rollbackError) {
      logger.error(
        "[SocialOperations] media upload rollback failed",
        logger.maskSensitive({
          storageProvider: uploadResult.storageProvider,
          code: rollbackError.code,
          retryable: rollbackError.retryable,
        }),
      );
    }
    throw error;
  }
}

async function listMedia({ db = prisma } = {}) {
  return serializeList(
    await db.socialMediaAsset.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  );
}

async function readMedia({ id, db = prisma } = {}) {
  return sanitizeForResponse(await db.socialMediaAsset.findUniqueOrThrow({ where: { id } }));
}

async function mediaStatus({ id, db = prisma } = {}) {
  const asset = await db.socialMediaAsset.findUniqueOrThrow({ where: { id } });
  return sanitizeForResponse({
    id: asset.id,
    status: asset.status,
    processingMetadataJson: asset.processingMetadataJson,
    updatedAt: asset.updatedAt,
  });
}

async function reprocessMedia({ id, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialMediaAsset.update({
      where: { id },
      data: {
        status: "PROCESSING",
        processingMetadataJson: { reprocessRequestedAt: nowDate().toISOString() },
      },
    }),
  );
}

async function mediaUsage({ id, db = prisma } = {}) {
  const usages = await db.socialPostMedia.findMany({
    where: { assetId: id },
    include: { target: { include: { post: true } } },
  });
  return sanitizeForResponse({ assetId: id, usages });
}

async function deleteMedia({
  id,
  context,
  db = prisma,
  storageAdapter,
  auditWriter = writeSocialAudit,
} = {}) {
  const actorId = context?.adminUser?.id || null;
  const asset = await db.socialMediaAsset.findUnique({ where: { id } });
  if (!asset) throw new ApiError(404, "Social media asset not found");

  const lockedUsage = await db.socialPostMedia.findFirst({
    where: {
      assetId: id,
      OR: [
        {
          target: { status: { in: ["APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED"] } },
        },
        {
          target: {
            publications: {
              some: {
                status: {
                  in: ["PENDING", "VALIDATING", "UPLOADING", "PROCESSING", "PUBLISHING", "AWAITING_USER_ACTION", "PUBLISHED"],
                },
              },
            },
          },
        },
      ],
    },
  });
  if (lockedUsage) {
    throw new ApiError(409, "Media is used by a locked or published revision");
  }

  if (asset.deletedAt || asset.status === "DELETED") {
    return sanitizeForResponse(asset);
  }

  const provider = String(asset.storageProvider || "").toUpperCase();
  if ([STORAGE_PROVIDER.LOCAL, STORAGE_PROVIDER.CLOUDINARY].includes(provider)) {
    const adapter = storageAdapter || createMediaStorageAdapter({
      overrides: { provider: provider.toLowerCase() },
    });
    try {
      await adapter.delete({
        storageKey: asset.storageKey,
        publicId: providerMetadataFromAsset(asset).publicId,
        resourceType: resourceTypeFromAsset(asset),
      });
    } catch (error) {
      if (error instanceof MediaStorageError) {
        await writeSafeMediaAudit({
          operation: "SOCIAL_MEDIA_DELETE_FAILED",
          ownerId: asset.ownerId || actorId,
          assetId: asset.id,
          metadata: {
            storageProvider: provider,
            reasonCode: error.code,
            retryable: error.retryable,
          },
          auditWriter,
        });
      }
      mapStorageError(error);
    }
  }

  const deleted = await db.socialMediaAsset.update({
    where: { id },
    data: { status: "DELETED", deletedAt: nowDate() },
  });
  await writeSafeMediaAudit({
    operation: "SOCIAL_MEDIA_DELETED",
    ownerId: deleted.ownerId || actorId,
    assetId: deleted.id,
    metadata: {
      storageProvider: deleted.storageProvider,
      resourceType: resourceTypeFromAsset(deleted),
      checksumSha256: deleted.checksumSha256,
    },
    auditWriter,
  });
  return sanitizeForResponse(deleted);
}

async function restrictedIds({ entityType, ids, db }) {
  if (ids.length === 0) return new Set();
  const rows = await db.socialEscalation.findMany({
    where: { entityType, entityId: { in: ids }, restrictedVisibility: true },
    select: { entityId: true },
  });
  return new Set(rows.map((row) => row.entityId));
}

async function filterRestrictedRows({ rows, entityType, context, db }) {
  if (await canViewRestricted({ adminUser: context.adminUser, db })) return rows;
  const restricted = await restrictedIds({
    entityType,
    ids: rows.map((row) => row.id),
    db,
  });
  return rows.filter((row) => !restricted.has(row.id));
}

async function assertDirectRestrictedAccess({ entityType, id, context, db }) {
  const restricted = await restrictedIds({ entityType, ids: [id], db });
  if (!restricted.has(id)) return;
  await assertRestrictedContentAccess({
    adminUser: context?.adminUser,
    entityType,
    entityId: id,
    db,
  });
}

async function listConversations({ context, db = prisma } = {}) {
  const rows = await db.socialConversation.findMany({
    orderBy: { lastMessageAt: "desc" },
    include: { identity: true, contact: true, tags: { include: { tag: true } } },
  });
  return serializeList(
    await filterRestrictedRows({ rows, entityType: "CONVERSATION", context, db }),
  );
}

async function readConversation({ id, context, db = prisma } = {}) {
  await assertDirectRestrictedAccess({ entityType: "CONVERSATION", id, context, db });
  const rows = await filterRestrictedRows({
    rows: [
      await db.socialConversation.findUniqueOrThrow({
        where: { id },
        include: { identity: true, contact: true, tags: { include: { tag: true } } },
      }),
    ],
    entityType: "CONVERSATION",
    context,
    db,
  });
  if (rows.length === 0) throw new ApiError(404, "Conversation not found");
  return sanitizeForResponse(rows[0]);
}

async function listConversationMessages({ id, context, db = prisma } = {}) {
  await readConversation({ id, context, db });
  return serializeList(
    await db.socialMessage.findMany({
      where: { conversationId: id },
      orderBy: { queuedAt: "asc" },
    }),
  );
}

async function replyConversation({ id, body, context, db = prisma } = {}) {
  const conversation = await db.socialConversation.findUniqueOrThrow({
    where: { id },
    include: { identity: { include: IDENTITY_INCLUDE_CONNECTION } },
  });
  const capabilities = await computeCapabilities(conversation.identity);
  if (capabilities.sendMessage.status !== CAPABILITY_STATUS.AVAILABLE) {
    throw new ApiError(409, "Provider message sending is not currently available", {
      capability: capabilities.sendMessage,
    });
  }
  const message = await db.socialMessage.create({
    data: {
      conversationId: id,
      clientIdempotencyKey: idempotencyKey("conversation-reply", id, body.text),
      direction: "OUTBOUND",
      type: "TEXT",
      content: body.text,
      contentHash: hmacContent(body.text),
      status: "QUEUED",
      sentByAdminId: adminId(context),
    },
  });
  const job = await db.socialActionJob.create({
    data: {
      jobType: "SEND_MESSAGE",
      identityId: conversation.identityId,
      messageId: message.id,
      idempotencyKey: idempotencyKey("send-message", message.id),
      payloadJson: validateActionPayload({ messageId: message.id }),
    },
  });
  return sanitizeForResponse({ messageId: message.id, jobId: job.id });
}

async function assignConversation({ id, body, context, db = prisma } = {}) {
  const updated = await db.socialConversation.update({
    where: { id },
    data: {
      assigneeId: body.assigneeId || null,
      assignedById: adminId(context),
      assignedAt: nowDate(),
    },
  });
  await publishSocialEvent({
    type: SOCIAL_DOMAIN_EVENTS.SOCIAL_ITEM_ASSIGNED,
    payload: { entityType: "CONVERSATION", entityId: id, assigneeId: body.assigneeId },
  });
  return sanitizeForResponse(updated);
}

async function snoozeConversation({ id, body, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialConversation.update({
      where: { id },
      data: {
        state: "SNOOZED",
        snoozedUntil: body?.snoozedUntil ? new Date(body.snoozedUntil) : null,
      },
    }),
  );
}

async function resolveConversation({ id, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialConversation.update({
      where: { id },
      data: { state: "RESOLVED", resolvedAt: nowDate() },
    }),
  );
}

async function createInternalNote({ entityType, entityId, body, context, db = prisma } = {}) {
  const text = body?.text || body?.note || "";
  if (!text.trim()) throw new ApiError(400, "note text is required");
  return sanitizeForResponse(
    await db.socialInternalNote.create({
      data: {
        entityType,
        entityId,
        text,
        contentHash: hmacContent(text),
        restrictedVisibility: Boolean(body?.restrictedVisibility),
        authorId: adminId(context),
      },
    }),
  );
}

async function tagConversation({ id, body, context, db = prisma } = {}) {
  const name = String(body?.name || body?.tag || "").trim();
  if (!name) throw new ApiError(400, "tag name is required");
  const tag = await db.socialTag.upsert({
    where: { name },
    update: {},
    create: { name, color: body?.color || null },
  });
  await db.socialConversationTag.upsert({
    where: { conversationId_tagId: { conversationId: id, tagId: tag.id } },
    update: {},
    create: { conversationId: id, tagId: tag.id, taggedById: adminId(context) },
  });
  return sanitizeForResponse({ conversationId: id, tag });
}

async function listComments({ context, db = prisma } = {}) {
  const rows = await db.socialComment.findMany({
    orderBy: { providerCreatedAt: "desc" },
    include: { identity: true, providerContent: true },
  });
  return serializeList(await filterRestrictedRows({ rows, entityType: "COMMENT", context, db }));
}

async function readComment({ id, context, db = prisma } = {}) {
  await assertDirectRestrictedAccess({ entityType: "COMMENT", id, context, db });
  const rows = await filterRestrictedRows({
    rows: [
      await db.socialComment.findUniqueOrThrow({
        where: { id },
        include: { identity: true, providerContent: true },
      }),
    ],
    entityType: "COMMENT",
    context,
    db,
  });
  if (rows.length === 0) throw new ApiError(404, "Comment not found");
  return sanitizeForResponse(rows[0]);
}

async function replyComment({ id, body, context, db = prisma } = {}) {
  const comment = await db.socialComment.findUniqueOrThrow({
    where: { id },
    include: { identity: { include: IDENTITY_INCLUDE_CONNECTION }, providerContent: true },
  });
  const capabilities = await computeCapabilities(comment.identity);
  if (capabilities.replyToComment.status !== CAPABILITY_STATUS.AVAILABLE) {
    throw new ApiError(409, "Provider comment reply is not currently available", {
      capability: capabilities.replyToComment,
    });
  }
  const reply = await db.socialComment.create({
    data: {
      identityId: comment.identityId,
      providerContentId: comment.providerContentId,
      parentId: comment.id,
      direction: "OUTBOUND",
      text: body.text,
      contentHash: hmacContent(body.text),
      sentByAdminId: adminId(context),
      queuedAt: nowDate(),
    },
  });
  const job = await db.socialActionJob.create({
    data: {
      jobType: "REPLY_COMMENT",
      identityId: comment.identityId,
      providerContentId: comment.providerContentId,
      commentId: reply.id,
      idempotencyKey: idempotencyKey("reply-comment", reply.id),
      payloadJson: validateActionPayload({ commentId: reply.id }),
    },
  });
  return sanitizeForResponse({ commentId: reply.id, jobId: job.id });
}

async function assignComment({ id, body, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialComment.update({
      where: { id },
      data: { assigneeId: body.assigneeId || null },
    }),
  );
}

async function moderateComment({ id, action, context, db = prisma } = {}) {
  const comment = await db.socialComment.findUniqueOrThrow({ where: { id } });
  const jobType = action === "delete" ? "DELETE_COMMENT" : "HIDE_COMMENT";
  const moderationState = action === "delete" ? "DELETED" : "HIDDEN";
  const job = await db.socialActionJob.create({
    data: {
      jobType,
      identityId: comment.identityId,
      providerContentId: comment.providerContentId,
      commentId: comment.id,
      idempotencyKey: idempotencyKey(jobType, comment.id, Date.now()),
      payloadJson: validateActionPayload({ commentId: comment.id, action }),
    },
  });
  await db.socialComment.update({ where: { id }, data: { moderationState } });
  return sanitizeOperationRecord({ job, requestedById: adminId(context) });
}

async function escalateComment({ id, body, context, db = prisma } = {}) {
  const result = await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: id,
    classification: body?.classification || "GENERAL_INQUIRY",
    reasonCodes: body?.reasonCodes || [],
    actorId: adminId(context),
    proposedAssigneeId: body?.assigneeId,
    db,
  });
  return sanitizeForResponse(result.escalation || { tracked: false });
}

async function listSavedReplies({ db = prisma } = {}) {
  return serializeList(
    await db.socialSavedReply.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    }),
  );
}

async function createSavedReply({ body, context, db = prisma } = {}) {
  return sanitizeForResponse(
    await db.socialSavedReply.create({
      data: {
        name: body.name,
        channel: body.channel,
        text: body.text,
        variablesJson: body.variablesJson || {},
        createdById: adminId(context),
      },
    }),
  );
}

async function listOperations({ db = prisma } = {}) {
  const [publishingJobs, actionJobs] = await Promise.all([
    db.socialPublishingJob.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        publication: {
          include: {
            target: { include: { identity: { include: { connection: true } } } },
          },
        },
      },
    }),
    db.socialActionJob.findMany({
      orderBy: { createdAt: "desc" },
      include: { identity: { include: { connection: true } } },
    }),
  ]);

  return [
    ...publishingJobs.map((job) =>
      sanitizeOperationRecord({
        id: job.id,
        jobType: "PUBLISH_POST",
        status: job.status,
        provider: job.publication?.target?.identity?.connection?.provider,
        identityId: job.publication?.target?.identityId,
        entityType: "PUBLICATION",
        entityId: job.publicationId,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        nextAttemptAt: job.nextAttemptAt,
        lastErrorCategory: job.lastErrorCategory,
        lastError: job.lastError,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: job.leaseExpiresAt,
      }),
    ),
    ...actionJobs.map((job) =>
      sanitizeOperationRecord({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        provider: job.identity?.connection?.provider,
        identityId: job.identityId,
        entityType: job.commentId ? "COMMENT" : job.messageId ? "MESSAGE" : "ACTION",
        entityId: job.commentId || job.messageId || job.providerContentId || job.publicationId,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        nextAttemptAt: job.nextAttemptAt,
        lastErrorCategory: job.lastErrorCategory,
        lastError: job.lastError,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: job.leaseExpiresAt,
      }),
    ),
  ];
}

async function operationsHealth({ db = prisma } = {}) {
  return sanitizeOperationRecord(await getSocialOperationsHealth({ db }));
}

async function readOperation({ id, db = prisma } = {}) {
  const [publishingJob, actionJob] = await Promise.all([
    db.socialPublishingJob.findUnique({
      where: { id },
      include: { publication: { include: { target: { include: { identity: true } } } } },
    }),
    db.socialActionJob.findUnique({
      where: { id },
      include: { identity: { include: { connection: true } } },
    }),
  ]);
  if (!publishingJob && !actionJob) throw new ApiError(404, "Operation not found");
  return sanitizeOperationRecord(publishingJob || actionJob);
}

async function retryOperation({ id, db = prisma } = {}) {
  const publishingJob = await db.socialPublishingJob.findUnique({ where: { id } });
  if (publishingJob) {
    assertJobCancellable(publishingJob);
    return sanitizeOperationRecord(
      await db.socialPublishingJob.update({
        where: { id },
        data: { status: "PENDING", nextAttemptAt: null, lastError: null },
      }),
    );
  }
  const actionJob = await db.socialActionJob.findUnique({ where: { id } });
  assertJobCancellable(actionJob);
  return sanitizeOperationRecord(
    await db.socialActionJob.update({
      where: { id },
      data: { status: "PENDING", nextAttemptAt: null, lastError: null },
    }),
  );
}

async function cancelOperation({ id, db = prisma } = {}) {
  const publishingJob = await db.socialPublishingJob.findUnique({ where: { id } });
  if (publishingJob) {
    return sanitizeOperationRecord(
      await db.socialPublishingJob.update({
        where: { id },
        data: { status: "CANCELLED", completedAt: nowDate() },
      }),
    );
  }
  return sanitizeOperationRecord(
    await db.socialActionJob.update({
      where: { id },
      data: { status: "CANCELLED", completedAt: nowDate() },
    }),
  );
}

async function analyticsPosts({ db = prisma } = {}) {
  const [publications, content] = await Promise.all([
    db.socialPublication.groupBy({ by: ["status"], _count: { _all: true } }),
    db.socialProviderContent.count(),
  ]);
  return sanitizeForResponse({ publications, contentCount: content });
}

async function analyticsInbox({ db = prisma } = {}) {
  const [conversations, comments] = await Promise.all([
    db.socialConversation.groupBy({ by: ["state"], _count: { _all: true } }),
    db.socialComment.groupBy({
      by: ["moderationState"],
      where: { sensitiveDataState: { notIn: PRIVATE_STATES } },
      _count: { _all: true },
    }),
  ]);
  return sanitizeForResponse({ conversations, comments });
}

async function analyticsExport({ context, db = prisma } = {}) {
  return sanitizeForResponse({
    generatedAt: nowDate(),
    restrictedIncluded: await canViewRestricted({ adminUser: context.adminUser, db }),
    posts: await analyticsPosts({ db }),
    inbox: await analyticsInbox({ db }),
  });
}

const SETTING_KEY_MAP = Object.freeze({
  selfApprovalAllowed: "social.approvals.allow_self_approval",
  emergencyPublishPolicy: "social.policy.emergency_publish",
  restrictedVisibilityPolicy: "social.policy.restricted_visibility",
  slaThresholds: "social.policy.sla_thresholds",
  blockedProviders: "social.policy.blocked_providers",
  blockedIdentityIds: "social.policy.blocked_identity_ids",
});

async function getSettings({ db = prisma } = {}) {
  const rows = await db.socialOperationsSetting.findMany();
  const mapped = {};
  for (const [publicKey, settingKey] of Object.entries(SETTING_KEY_MAP)) {
    mapped[publicKey] =
      rows.find((row) => row.key === settingKey)?.valueJson ??
      (publicKey === "selfApprovalAllowed" ? false : null);
  }
  return sanitizeForResponse(mapped);
}

async function updateSettings({ body, context, db = prisma } = {}) {
  const updates = [];
  for (const [publicKey, settingKey] of Object.entries(SETTING_KEY_MAP)) {
    if (Object.hasOwn(body, publicKey)) {
      updates.push(
        db.socialOperationsSetting.upsert({
          where: { key: settingKey },
          update: { valueJson: body[publicKey], updatedById: adminId(context) },
          create: {
            key: settingKey,
            valueJson: body[publicKey],
            updatedById: adminId(context),
          },
        }),
      );
    }
  }
  await Promise.all(updates);
  return getSettings({ db });
}

module.exports = {
  connectionList,
  startOAuth,
  verifyOAuthCallback,
  testConnection,
  reauthorizeConnection,
  setConnectionStatus,
  discoverIdentities,
  identityList,
  refreshIdentityCapabilities,
  createPost,
  listPosts,
  readPost,
  updatePost,
  deletePost,
  duplicatePost,
  listPostVersions,
  submitPost,
  decideApproval,
  publishPost,
  schedulePost,
  listPublications,
  readPublication,
  listPostPublications,
  retryPublication,
  cancelPublication,
  enqueueDeleteProviderPost,
  listContent,
  readContent,
  syncContent,
  listContentComments,
  listContentMetrics,
  createMedia,
  listMedia,
  readMedia,
  mediaStatus,
  reprocessMedia,
  mediaUsage,
  deleteMedia,
  listConversations,
  readConversation,
  listConversationMessages,
  replyConversation,
  assignConversation,
  snoozeConversation,
  resolveConversation,
  createInternalNote,
  tagConversation,
  listComments,
  readComment,
  replyComment,
  assignComment,
  moderateComment,
  escalateComment,
  listSavedReplies,
  createSavedReply,
  listOperations,
  operationsHealth,
  readOperation,
  retryOperation,
  cancelOperation,
  analyticsPosts,
  analyticsInbox,
  analyticsExport,
  getSettings,
  updateSettings,
};
