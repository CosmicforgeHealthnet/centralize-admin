const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");

process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });

const LOCAL_DB_NAME = "cosmicforge_admin";

class RollbackSection5Test extends Error {
  constructor() {
    super("ROLLBACK_SECTION5_TEST");
  }
}

function isLocalAdminDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return false;

  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, "");

  return (
    database === LOCAL_DB_NAME &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1")
  );
}

function isExpectedConstraintError(error) {
  return (
    error?.code === "P2002" ||
    error?.code === "P2003" ||
    /duplicate key value|foreign key constraint/i.test(error?.message || "")
  );
}

async function expectConstraintError(tx, operation) {
  const savepoint = `section5_sp_${randomUUID().replace(/-/g, "")}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);

  try {
    await operation();
    assert.fail("expected the database constraint to reject the write");
  } catch (error) {
    if (error?.name === "AssertionError") throw error;
    assert.ok(isExpectedConstraintError(error), error?.message);
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  } finally {
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
  }
}

async function assertSocialTablesExist(prisma, t) {
  const tables = await prisma.$queryRaw`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'social_%'
  `;

  if (Number(tables[0]?.count || 0) !== 31) {
    t.skip("Section 5 social tables have not been applied to the local database");
    return false;
  }

  return true;
}

async function withRollback(prisma, work) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await work(tx);
        throw new RollbackSection5Test();
      },
      { maxWait: 10000, timeout: 30000 },
    );
  } catch (error) {
    if (
      error instanceof RollbackSection5Test ||
      error?.message === "ROLLBACK_SECTION5_TEST"
    ) {
      return;
    }
    throw error;
  }
}

test("section 5 social operations schema enforces core database contracts", async (t) => {
  if (!isLocalAdminDatabase()) {
    t.skip("requires local cosmicforge_admin DATABASE_URL");
    return;
  }

  const { prisma } = require("../../../../shared/config/database");

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    t.skip(`local database is unavailable: ${error.message}`);
    return;
  }

  if (!(await assertSocialTablesExist(prisma, t))) return;

  await withRollback(prisma, async (tx) => {
    const suffix = randomUUID();
    const admin = await tx.adminUser.create({
      data: {
        email: `section5-${suffix}@example.com`,
        password: "not-a-real-password-hash",
        name: "Section 5 Test Admin",
        tier: "SUPER",
        status: "ACTIVE",
        mustChangePassword: false,
      },
    });
    const campaign = await tx.marketing_campaigns.create({
      data: {
        title: `Section 5 Campaign ${suffix}`,
        type: "Social",
      },
    });
    const task = await tx.task.create({
      data: {
        title: `Section 5 Escalation ${suffix}`,
        dueDate: new Date(Date.now() + 86400000),
        assignerId: admin.id,
        assigneeId: admin.id,
      },
    });

    const connection = await tx.socialAccountConnection.create({
      data: {
        provider: "META",
        providerConnectionId: `conn-${suffix}`,
        encryptedCredentials: Buffer.from("encrypted"),
        scopes: ["pages_manage_posts"],
        createdById: admin.id,
      },
    });
    const identity = await tx.socialPublishingIdentity.create({
      data: {
        connectionId: connection.id,
        providerIdentityId: `identity-${suffix}`,
        type: "FACEBOOK_PAGE",
        name: "Section 5 Page",
        capabilitiesJson: { publish: true, inbox: true },
      },
    });
    await tx.socialOAuthState.create({
      data: {
        stateHash: `state-${suffix}`,
        provider: "META",
        adminUserId: admin.id,
        connectionContextJson: { flow: "section5" },
        encryptedVerifier: Buffer.from("verifier"),
        expiresAt: new Date(Date.now() + 600000),
      },
    });

    const post = await tx.socialPost.create({
      data: {
        title: "Section 5 Post",
        campaignId: campaign.id,
        createdById: admin.id,
      },
    });
    const revision = await tx.socialPostRevision.create({
      data: {
        postId: post.id,
        version: 1,
        baseText: "Hello from Section 5",
        snapshotJson: { text: "Hello from Section 5" },
        createdById: admin.id,
      },
    });
    const target = await tx.socialPostTarget.create({
      data: {
        postId: post.id,
        identityId: identity.id,
        text: "Hello from Section 5",
      },
    });
    await tx.socialPostApproval.create({
      data: {
        postId: post.id,
        revisionId: revision.id,
        targetId: target.id,
        submittedById: admin.id,
      },
    });

    const publication = await tx.socialPublication.create({
      data: {
        targetId: target.id,
        postVersion: 1,
        requestedById: admin.id,
        idempotencyKey: `publication-${suffix}`,
      },
    });
    await tx.socialPublicationAttempt.create({
      data: {
        publicationId: publication.id,
        attemptNo: 1,
      },
    });
    await tx.socialPublishingJob.create({
      data: {
        publicationId: publication.id,
        scheduledForUtc: new Date(Date.now() + 60000),
      },
    });

    const asset = await tx.socialMediaAsset.create({
      data: {
        ownerId: admin.id,
        storageKey: `section5/${suffix}.jpg`,
        url: "https://example.test/section5.jpg",
        secureUrl: "https://example.test/section5.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234n,
        checksumSha256: `sha-${suffix}`,
        status: "READY",
      },
    });
    await tx.socialPostMedia.create({
      data: {
        targetId: target.id,
        assetId: asset.id,
        position: 1,
      },
    });

    const contact = await tx.socialContact.create({
      data: {
        identityId: identity.id,
        providerUserId: `contact-${suffix}`,
        displayName: "Section 5 Contact",
        linkedSubjectType: "user",
        linkedSubjectId: `main:user:${suffix}`,
        linkedSubjectSource: "main",
        linkedById: admin.id,
      },
    });
    const conversation = await tx.socialConversation.create({
      data: {
        identityId: identity.id,
        providerConversationId: `conversation-${suffix}`,
        contactId: contact.id,
        assigneeId: admin.id,
        assignedById: admin.id,
      },
    });
    const message = await tx.socialMessage.create({
      data: {
        conversationId: conversation.id,
        providerMessageId: `message-${suffix}`,
        clientIdempotencyKey: `message-key-${suffix}`,
        direction: "OUTBOUND",
        type: "TEXT",
        content: "A synthetic Section 5 message",
        sentByAdminId: admin.id,
      },
    });
    const tag = await tx.socialTag.create({
      data: { name: `section5-${suffix}`, color: "#2f6fed" },
    });
    await tx.socialConversationTag.create({
      data: {
        conversationId: conversation.id,
        tagId: tag.id,
        taggedById: admin.id,
      },
    });

    const providerContent = await tx.socialProviderContent.create({
      data: {
        identityId: identity.id,
        providerContentId: `content-${suffix}`,
        source: "ADMIN_PUBLISHED",
        contentType: "TEXT",
        publicationId: publication.id,
      },
    });
    const comment = await tx.socialComment.create({
      data: {
        identityId: identity.id,
        providerContentId: providerContent.id,
        providerCommentId: `comment-${suffix}`,
        authorContactId: contact.id,
        text: "A synthetic comment",
        assigneeId: admin.id,
      },
    });
    await tx.socialEngagementEvent.create({
      data: {
        identityId: identity.id,
        type: "MENTION",
        providerEventId: `event-${suffix}`,
        occurredAt: new Date(),
        payloadJson: { source: "section5-test" },
      },
    });
    const escalation = await tx.socialEscalation.create({
      data: {
        entityType: "comment",
        entityId: comment.id,
        classification: "GENERAL_INQUIRY",
        taskId: task.id,
      },
    });

    await tx.socialWebhookSubscription.create({
      data: {
        connectionId: connection.id,
        eventType: "messages",
      },
    });
    await expectConstraintError(tx, () =>
      tx.socialWebhookSubscription.create({
        data: {
          connectionId: connection.id,
          eventType: "messages",
        },
      }),
    );
    await tx.socialWebhookSubscription.create({
      data: {
        connectionId: connection.id,
        identityId: identity.id,
        eventType: "messages",
      },
    });
    await expectConstraintError(tx, () =>
      tx.socialWebhookSubscription.create({
        data: {
          connectionId: connection.id,
          identityId: identity.id,
          eventType: "messages",
        },
      }),
    );
    await tx.socialWebhookEvent.create({
      data: {
        provider: "META",
        eventId: `webhook-${suffix}`,
        payloadHash: `payload-${suffix}`,
        signatureValid: true,
        encryptedRawPayload: Buffer.from("payload"),
      },
    });

    await tx.socialIdentityMetricSnapshot.create({
      data: {
        identityId: identity.id,
        date: new Date(Date.UTC(2026, 0, 1)),
        impressions: 10,
        rawJson: { impressions: 10 },
      },
    });
    await tx.socialProviderContentMetricSnapshot.create({
      data: {
        providerContentId: providerContent.id,
        date: new Date(Date.UTC(2026, 0, 1)),
        views: 20,
        watchTimeMs: 3000n,
        rawJson: { views: 20 },
      },
    });
    await tx.socialIdentitySyncState.create({
      data: { identityId: identity.id, contentCursor: "cursor-1" },
    });
    const actionJob = await tx.socialActionJob.create({
      data: {
        jobType: "SEND_MESSAGE",
        identityId: identity.id,
        messageId: message.id,
        idempotencyKey: `action-${suffix}`,
      },
    });
    await tx.socialActionAttempt.create({
      data: {
        jobId: actionJob.id,
        attemptNo: 1,
      },
    });
    await expectConstraintError(tx, () =>
      tx.socialActionAttempt.create({
        data: {
          jobId: actionJob.id,
          attemptNo: 1,
        },
      }),
    );
    await tx.socialInternalNote.create({
      data: {
        entityType: "conversation",
        entityId: conversation.id,
        text: "Internal note",
        authorId: admin.id,
      },
    });
    await tx.socialSavedReply.create({
      data: {
        name: `Section 5 ${suffix}`,
        channel: "comments",
        text: "Thanks for reaching out.",
        createdById: admin.id,
      },
    });
    await tx.socialOperationsSetting.create({
      data: {
        key: `section5.${suffix}`,
        valueJson: { enabled: true },
        updatedById: admin.id,
      },
    });

    const cascadePost = await tx.socialPost.create({
      data: {
        title: "Section 5 Cascade Post",
        createdById: admin.id,
      },
    });
    await tx.socialPostRevision.create({
      data: {
        postId: cascadePost.id,
        version: 1,
        baseText: "Cascade revision",
        snapshotJson: { text: "Cascade revision" },
        createdById: admin.id,
      },
    });
    await tx.socialPost.delete({ where: { id: cascadePost.id } });
    assert.equal(
      await tx.socialPostRevision.count({ where: { postId: cascadePost.id } }),
      0,
    );

    await tx.task.delete({ where: { id: task.id } });
    const tasklessEscalation = await tx.socialEscalation.findUniqueOrThrow({
      where: { id: escalation.id },
    });
    assert.equal(tasklessEscalation.taskId, null);

    await expectConstraintError(tx, () =>
      tx.adminUser.delete({ where: { id: admin.id } }),
    );
  });
});
