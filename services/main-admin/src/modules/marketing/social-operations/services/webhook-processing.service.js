const { prisma } = require("../../../../shared/config/database");
const { getConnector } = require("../connectors/connector.registry");
const {
  validateNormalizedWebhookEvent,
} = require("../connectors/connector.validators");
const { decryptWebhookPayload } = require("./webhook-crypto.service");
const {
  publishSocialEvent,
  SOCIAL_DOMAIN_EVENTS,
} = require("./social-domain-events.service");
const {
  PUBLICATION_STATUS_TRANSITION_SOURCES,
  transitionPublicationStatus,
} = require("./publication-status-transition.service");
const {
  classifyInboundContent,
} = require("../safety/inbound-classification.service");
const {
  createOrReuseEscalation,
} = require("../safety/escalation.service");
const { hmacContent } = require("../security/content-hash.service");

const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 6;

function retryAt(attemptCount) {
  const delayMs = Math.min(60 * 60 * 1000, 2 ** Math.max(0, attemptCount) * 60 * 1000);
  return new Date(Date.now() + delayMs);
}

function parseEncryptedPayload(event) {
  const raw = decryptWebhookPayload(event.encryptedRawPayload).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function findIdentity({ provider, identityProviderId, db }) {
  if (!identityProviderId) return null;
  return db.socialPublishingIdentity.findFirst({
    where: {
      providerIdentityId: identityProviderId,
      connection: { provider },
    },
    include: { connection: true },
  });
}

async function upsertMessage({ identity, normalized, db }) {
  const data = normalized.data;
  if (!identity || !data.providerMessageId || !data.providerConversationId) {
    return null;
  }

  const providerUserId = data.providerUserId || "unknown";
  const contact = await db.socialContact.upsert({
    where: {
      identityId_providerUserId: {
        identityId: identity.id,
        providerUserId,
      },
    },
    update: {
      displayName: data.displayName || undefined,
      username: data.username || undefined,
    },
    create: {
      identityId: identity.id,
      providerUserId,
      displayName: data.displayName || null,
      username: data.username || null,
    },
  });

  const conversation = await db.socialConversation.upsert({
    where: {
      identityId_providerConversationId: {
        identityId: identity.id,
        providerConversationId: data.providerConversationId,
      },
    },
    update: {
      lastMessageAt: data.providerCreatedAt ? new Date(data.providerCreatedAt) : new Date(),
      lastInboundAt:
        data.direction === "INBOUND"
          ? data.providerCreatedAt
            ? new Date(data.providerCreatedAt)
            : new Date()
          : undefined,
    },
    create: {
      identityId: identity.id,
      providerConversationId: data.providerConversationId,
      contactId: contact.id,
      lastMessageAt: data.providerCreatedAt ? new Date(data.providerCreatedAt) : new Date(),
      lastInboundAt:
        data.direction === "INBOUND"
          ? data.providerCreatedAt
            ? new Date(data.providerCreatedAt)
            : new Date()
          : null,
    },
  });

  const classification = classifyInboundContent({
    text: data.text || "",
    sourceType: "MESSAGE",
  });
  const message = await db.socialMessage.upsert({
    where: {
      conversationId_providerMessageId: {
        conversationId: conversation.id,
        providerMessageId: data.providerMessageId,
      },
    },
    update: {
      status: data.status || undefined,
      providerCreatedAt: data.providerCreatedAt ? new Date(data.providerCreatedAt) : undefined,
    },
    create: {
      conversationId: conversation.id,
      providerMessageId: data.providerMessageId,
      direction: data.direction || "INBOUND",
      type: data.type || "TEXT",
      content: data.text || null,
      contentHash: data.contentHash || (data.text ? hmacContent(data.text) : null),
      sensitiveDataState: classification.sensitiveDataState,
      status: data.status || "DELIVERED",
      providerCreatedAt: data.providerCreatedAt ? new Date(data.providerCreatedAt) : null,
    },
  });
  if ((data.direction || "INBOUND") === "INBOUND" && classification.requiresEscalation) {
    await createOrReuseEscalation({
      entityType: "CONVERSATION",
      entityId: conversation.id,
      sourceMessageId: message.id,
      classification: classification.classification,
      reasonCodes: classification.reasonCodes,
      db,
    });
  }
  return message;
}

async function upsertComment({ identity, normalized, db }) {
  const data = normalized.data;
  if (!identity || !data.providerCommentId || !data.providerContentId) return null;

  const content = await db.socialProviderContent.upsert({
    where: {
      identityId_providerContentId: {
        identityId: identity.id,
        providerContentId: data.providerContentId,
      },
    },
    update: {},
    create: {
      identityId: identity.id,
      providerContentId: data.providerContentId,
      source: "PROVIDER_IMPORTED",
      contentType: data.contentType || "OTHER",
      text: null,
      metadataJson: {},
    },
  });

  const classification = classifyInboundContent({
    text: data.text || "",
    sourceType: "COMMENT",
  });
  const comment = await db.socialComment.upsert({
    where: {
      identityId_providerCommentId: {
        identityId: identity.id,
        providerCommentId: data.providerCommentId,
      },
    },
    update: {
      moderationState: data.moderationState || undefined,
      providerCreatedAt: data.providerCreatedAt ? new Date(data.providerCreatedAt) : undefined,
    },
    create: {
      identityId: identity.id,
      providerContentId: content.id,
      providerCommentId: data.providerCommentId,
      direction: data.direction || "INBOUND",
      text: data.text || null,
      contentHash: data.contentHash || (data.text ? hmacContent(data.text) : null),
      sensitiveDataState: classification.sensitiveDataState,
      providerCreatedAt: data.providerCreatedAt ? new Date(data.providerCreatedAt) : null,
    },
  });
  if ((data.direction || "INBOUND") === "INBOUND" && classification.requiresEscalation) {
    await createOrReuseEscalation({
      entityType: "COMMENT",
      entityId: comment.id,
      classification: classification.classification,
      reasonCodes: classification.reasonCodes,
      db,
    });
  }
  return comment;
}

async function upsertEngagement({ identity, normalized, db }) {
  const data = normalized.data;
  if (!identity || !data.providerEventId) return null;
  return db.socialEngagementEvent.upsert({
    where: {
      identityId_providerEventId: {
        identityId: identity.id,
        providerEventId: data.providerEventId,
      },
    },
    update: { payloadJson: data.payload || data },
    create: {
      identityId: identity.id,
      providerEventId: data.providerEventId,
      type: data.type || normalized.kind || "OTHER",
      occurredAt: data.occurredAt ? new Date(data.occurredAt) : new Date(),
      payloadJson: data.payload || data,
    },
  });
}

async function upsertPublicationStatus({ normalized, db, publisher }) {
  const data = normalized.data;
  const providerPostId = data.providerPublicationId || data.providerPostId;
  if (!providerPostId || !db.socialPublication?.findMany) return null;
  const publications = await db.socialPublication.findMany({
    where: { providerPostId },
    include: { target: { include: { identity: { include: { connection: true } } } } },
  });
  const results = [];
  for (const publication of publications) {
    results.push(
      await transitionPublicationStatus({
        publicationId: publication.id,
        publication,
        nextStatus: data.status,
        providerPostId,
        url: data.url || data.providerUrl || publication.url,
        postingMode: data.postingMode || publication.postingMode,
        providerTimestamp: data.publishedAt || data.providerTimestamp || data.providerPublishedAt,
        source: PUBLICATION_STATUS_TRANSITION_SOURCES.WEBHOOK,
        identityId: publication.target?.identityId || publication.target?.identity?.id,
        db,
        publisher,
      }),
    );
  }
  return results;
}

async function applyNormalizedWebhookEvent({
  provider,
  normalized,
  db = prisma,
  publisher,
} = {}) {
  const identity = await findIdentity({
    provider,
    identityProviderId: normalized.identityProviderId,
    db,
  });

  if (normalized.kind === "MESSAGE") {
    const message = await upsertMessage({ identity, normalized, db });
    await publishSocialEvent({
      type: SOCIAL_DOMAIN_EVENTS.SOCIAL_MESSAGE_RECEIVED,
      payload: { messageId: message?.id, identityId: identity?.id },
      publisher,
    });
    return { message };
  }

  if (normalized.kind === "COMMENT") {
    const comment = await upsertComment({ identity, normalized, db });
    await publishSocialEvent({
      type: SOCIAL_DOMAIN_EVENTS.SOCIAL_COMMENT_RECEIVED,
      payload: { commentId: comment?.id, identityId: identity?.id },
      publisher,
    });
    return { comment };
  }

  if (["REACTION", "MENTION"].includes(normalized.kind)) {
    return { engagement: await upsertEngagement({ identity, normalized, db }) };
  }

  if (normalized.kind === "PUBLICATION_STATUS") {
    return { publication: await upsertPublicationStatus({ normalized, db, publisher }) };
  }

  return { ignored: true };
}

async function processWebhookEvent({
  eventId,
  db = prisma,
  connectorResolver = getConnector,
  publisher,
} = {}) {
  const event = await db.socialWebhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error("Social webhook event not found");
  if (event.processedAt) return { processed: false, alreadyProcessed: true, event };

  await db.socialWebhookEvent.update({
    where: { id: event.id },
    data: { status: "PROCESSING", processingStartedAt: new Date() },
  });

  try {
    const payload = parseEncryptedPayload(event);
    const connector = connectorResolver(event.provider);
    const normalized = validateNormalizedWebhookEvent(
      connector.normalizeWebhookEvent({ payload }),
    );
    const result = await applyNormalizedWebhookEvent({
      provider: event.provider,
      normalized,
      db,
      publisher,
    });
    const updated = await db.socialWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        lastError: null,
        nextAttemptAt: null,
      },
    });
    return { processed: true, event: updated, result };
  } catch (error) {
    const nextAttemptCount = event.attemptCount + 1;
    const exhausted = nextAttemptCount >= DEFAULT_MAX_WEBHOOK_ATTEMPTS;
    const updated = await db.socialWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "FAILED",
        attemptCount: { increment: 1 },
        nextAttemptAt: exhausted ? null : retryAt(nextAttemptCount),
        lastError: error?.name || "WebhookProcessingError",
      },
    });
    return {
      processed: false,
      retryable: !exhausted,
      event: updated,
      error,
    };
  }
}

async function processDueWebhookEvents({ db = prisma, limit = 25 } = {}) {
  const due = await db.socialWebhookEvent.findMany({
    where: {
      status: { in: ["RECEIVED", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      processedAt: null,
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });

  const results = [];
  for (const event of due) {
    results.push(await processWebhookEvent({ eventId: event.id, db }));
  }
  return results;
}

module.exports = {
  DEFAULT_MAX_WEBHOOK_ATTEMPTS,
  parseEncryptedPayload,
  applyNormalizedWebhookEvent,
  processWebhookEvent,
  processDueWebhookEvents,
};
