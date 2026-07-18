const { prisma } = require("../../../../shared/config/database");
const {
  validatePublishResult,
  mapProviderPublishResult,
} = require("../connectors/publish-result.mapper");
const { mapTikTokPublishResult } = require("../connectors/tiktok-publish-result.mapper");
const {
  publishSocialEvent,
  SOCIAL_DOMAIN_EVENTS,
} = require("./social-domain-events.service");
const {
  validateActionPayload,
} = require("../security/sensitive-payload.validator");

const PUBLICATION_STATUS_TRANSITION_SOURCES = Object.freeze({
  PUBLISH_RESPONSE: "PUBLISH_RESPONSE",
  POLL: "POLL",
  WEBHOOK: "WEBHOOK",
  RECONCILIATION: "RECONCILIATION",
});

const POLLABLE_PUBLICATION_STATUSES = Object.freeze([
  "PROCESSING",
  "AWAITING_USER_ACTION",
  "FAILED_RETRYABLE",
]);

function pollPublicationIdempotencyKey(publicationId) {
  return `poll-publication:${publicationId}`;
}

function parseProviderTimestamp(value, fallback = new Date()) {
  if (!value) return fallback;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizePublicationStatusResult({ provider, result = {} } = {}) {
  if (provider === "TIKTOK" && result.postingMode) {
    return mapTikTokPublishResult(result);
  }
  return mapProviderPublishResult(result);
}

async function loadPublicationForTransition({ publicationId, publication, db }) {
  if (publication) return publication;
  return db.socialPublication.findUnique({
    where: { id: publicationId },
    include: { target: { include: { identity: { include: { connection: true } } } } },
  });
}

function publicationIdentityId(publication, explicitIdentityId) {
  return explicitIdentityId || publication?.target?.identityId || publication?.target?.identity?.id || null;
}

function isPublicationPollableStatus(status) {
  return POLLABLE_PUBLICATION_STATUSES.includes(status);
}

function transitionUpdateData({
  current,
  nextStatus,
  providerPostId,
  url,
  postingMode,
  providerTimestamp,
  now,
}) {
  const data = {
    status: nextStatus,
    lastError: null,
    lastErrorCategory: null,
  };
  if (providerPostId !== undefined && providerPostId !== null) {
    data.providerPostId = providerPostId;
  }
  if (url !== undefined) {
    data.url = url;
  }
  if (postingMode !== undefined && postingMode !== null) {
    data.postingMode = postingMode;
  }
  if (nextStatus === "PUBLISHED") {
    data.publishedAt = current?.publishedAt || parseProviderTimestamp(providerTimestamp, now);
  } else if (["PROCESSING", "AWAITING_USER_ACTION"].includes(nextStatus)) {
    data.publishedAt = null;
  }
  return data;
}

async function ensurePublicationPollJob({
  publication,
  identityId,
  source,
  db = prisma,
  nextAttemptAt = null,
} = {}) {
  if (!publication?.id || !db.socialActionJob) return null;
  const resolvedIdentityId = publicationIdentityId(publication, identityId);
  if (!resolvedIdentityId) return null;

  const idempotencyKey = pollPublicationIdempotencyKey(publication.id);
  const payloadJson = validateActionPayload({
    publicationId: publication.id,
    source,
    confirmation: "publication-status",
  });

  const existing = db.socialActionJob.findUnique
    ? await db.socialActionJob.findUnique({ where: { idempotencyKey } })
    : null;
  if (existing) {
    if (["CLAIMED", "RUNNING"].includes(existing.status)) return existing;
    return db.socialActionJob.update({
      where: { id: existing.id },
      data: {
        status: "PENDING",
        identityId: resolvedIdentityId,
        publicationId: publication.id,
        nextAttemptAt,
        completedAt: null,
        lastError: null,
        lastErrorCategory: null,
        payloadJson,
      },
    });
  }

  if (db.socialActionJob.upsert && !db.socialActionJob.create) {
    return db.socialActionJob.upsert({
      where: { idempotencyKey },
      update: {
        status: "PENDING",
        identityId: resolvedIdentityId,
        publicationId: publication.id,
        nextAttemptAt,
        completedAt: null,
        lastError: null,
        lastErrorCategory: null,
        payloadJson,
      },
      create: {
        jobType: "POLL_PUBLICATION",
        status: "PENDING",
        identityId: resolvedIdentityId,
        publicationId: publication.id,
        idempotencyKey,
        payloadJson,
      },
    });
  }

  return db.socialActionJob.create({
    data: {
      jobType: "POLL_PUBLICATION",
      status: "PENDING",
      identityId: resolvedIdentityId,
      publicationId: publication.id,
      idempotencyKey,
      payloadJson,
    },
  });
}

async function cancelPendingPublicationPollJob({
  publicationId,
  db = prisma,
  now = new Date(),
} = {}) {
  if (!publicationId || !db.socialActionJob?.updateMany) return null;
  return db.socialActionJob.updateMany({
    where: {
      publicationId,
      jobType: "POLL_PUBLICATION",
      status: { in: ["PENDING", "RETRY_SCHEDULED"] },
    },
    data: {
      status: "CANCELLED",
      completedAt: now,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    },
  });
}

async function updatePublicationStatus({ publication, data, db }) {
  if (db.socialPublication.update) {
    return db.socialPublication.update({
      where: { id: publication.id },
      data,
    });
  }
  Object.assign(publication, data);
  return publication;
}

async function transitionPublicationStatus({
  publicationId,
  publication,
  nextStatus,
  providerPostId,
  url,
  postingMode,
  providerTimestamp,
  source = PUBLICATION_STATUS_TRANSITION_SOURCES.PUBLISH_RESPONSE,
  identityId,
  db = prisma,
  publisher,
  ensurePoll = true,
  now = new Date(),
} = {}) {
  const normalized = validatePublishResult({
    providerPostId: providerPostId ?? publication?.providerPostId ?? null,
    url: url ?? publication?.url ?? null,
    status: nextStatus,
    postingMode,
    confirmed: nextStatus === "PUBLISHED" ? true : false,
  });
  const current = await loadPublicationForTransition({
    publicationId: publicationId || publication?.id,
    publication,
    db,
  });
  if (!current) return { publication: null, transitionedToPublished: false, pollJob: null };

  const updateData = transitionUpdateData({
    current,
    nextStatus: normalized.status,
    providerPostId: normalized.providerPostId,
    url: normalized.url,
    postingMode: normalized.postingMode,
    providerTimestamp,
    now,
  });

  let transitionedToPublished = false;
  let updatedPublication = current;

  if (normalized.status === "PUBLISHED") {
    if (current.status !== "PUBLISHED") {
      if (db.socialPublication.updateMany) {
        const result = await db.socialPublication.updateMany({
          where: { id: current.id, status: { not: "PUBLISHED" } },
          data: updateData,
        });
        transitionedToPublished = Number(result?.count || 0) === 1;
        updatedPublication = { ...current, ...updateData };
      } else {
        updatedPublication = await updatePublicationStatus({ publication: current, data: updateData, db });
        transitionedToPublished = true;
      }
    }
    await cancelPendingPublicationPollJob({ publicationId: current.id, db, now });
  } else if (current.status !== "PUBLISHED") {
    updatedPublication = await updatePublicationStatus({ publication: current, data: updateData, db });
  }

  let pollJob = null;
  if (ensurePoll && current.status !== "PUBLISHED" && isPublicationPollableStatus(normalized.status)) {
    pollJob = await ensurePublicationPollJob({
      publication: { ...current, ...updatedPublication, status: normalized.status },
      identityId,
      source,
      db,
    });
  }

  if (transitionedToPublished) {
    await publishSocialEvent({
      type: SOCIAL_DOMAIN_EVENTS.SOCIAL_PUBLICATION_SUCCEEDED,
      payload: {
        publicationId: current.id,
        providerPostId: normalized.providerPostId || current.providerPostId,
      },
      publisher,
    });
  }

  return {
    publication: updatedPublication,
    transitionedToPublished,
    pollJob,
  };
}

module.exports = {
  PUBLICATION_STATUS_TRANSITION_SOURCES,
  POLLABLE_PUBLICATION_STATUSES,
  pollPublicationIdempotencyKey,
  normalizePublicationStatusResult,
  isPublicationPollableStatus,
  ensurePublicationPollJob,
  cancelPendingPublicationPollJob,
  transitionPublicationStatus,
};
