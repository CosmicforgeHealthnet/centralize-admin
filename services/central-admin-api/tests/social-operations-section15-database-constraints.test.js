const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../src/shared/config/database");

const created = {
  adminIds: [],
  connectionIds: [],
  identityIds: [],
  socialPostIds: [],
};

after(async () => {
  if (created.connectionIds.length) {
    await prisma.socialWebhookSubscription.deleteMany({
      where: { connectionId: { in: created.connectionIds } },
    });
  }
  if (created.identityIds.length) {
    await prisma.socialPublishingIdentity.deleteMany({
      where: { id: { in: created.identityIds } },
    });
  }
  if (created.connectionIds.length) {
    await prisma.socialAccountConnection.deleteMany({
      where: { id: { in: created.connectionIds } },
    });
  }
  if (created.socialPostIds.length) {
    await prisma.socialPost.deleteMany({
      where: { id: { in: created.socialPostIds } },
    });
  }
  if (created.adminIds.length) {
    await prisma.adminUser.deleteMany({
      where: { id: { in: created.adminIds } },
    });
  }
  await prisma.$disconnect();
});

async function createAdmin(suffix) {
  const admin = await prisma.adminUser.create({
    data: {
      email: `section15-${suffix}-${Date.now()}@example.com`,
      password: "not-used",
      name: `Section 15 ${suffix}`,
      tier: "ADMIN",
      status: "ACTIVE",
    },
  });
  created.adminIds.push(admin.id);
  return admin;
}

test("webhook partial unique indexes exist with expected predicates", async () => {
  const rows = await prisma.$queryRaw`
    SELECT
      i.relname AS "indexName",
      t.relname AS "tableName",
      ix.indisunique AS "isUnique",
      ix.indisvalid AS "isValid",
      pg_get_indexdef(ix.indexrelid) AS "indexDef",
      pg_get_expr(ix.indpred, ix.indrelid) AS "predicate"
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    WHERE i.relname IN (
      'social_webhook_subscription_connection_event_unique',
      'social_webhook_subscription_identity_event_unique',
      'social_posts_legacy_source_id_unique'
    )
    ORDER BY i.relname
  `;

  const byName = new Map(rows.map((row) => [row.indexName, row]));
  assert.equal(
    byName.get("social_webhook_subscription_connection_event_unique")?.predicate,
    "(identity_id IS NULL)",
  );
  assert.equal(
    byName.get("social_webhook_subscription_identity_event_unique")?.predicate,
    "(identity_id IS NOT NULL)",
  );
  assert.equal(byName.get("social_posts_legacy_source_id_unique")?.predicate, "(legacy_source_id IS NOT NULL)");
  for (const row of rows) {
    assert.equal(row.isUnique, true);
    assert.equal(row.isValid, true);
  }
});

test("webhook subscription partial uniqueness scopes null and non-null identities separately", async () => {
  const admin = await createAdmin("webhook");
  const connection = await prisma.socialAccountConnection.create({
    data: {
      provider: "META",
      providerConnectionId: `mock-conn-${Date.now()}`,
      encryptedCredentials: Buffer.from("mock"),
      scopes: [],
      status: "ACTIVE",
      createdById: admin.id,
    },
  });
  created.connectionIds.push(connection.id);

  const identity = await prisma.socialPublishingIdentity.create({
    data: {
      connectionId: connection.id,
      providerIdentityId: `mock-page-${Date.now()}`,
      type: "FACEBOOK_PAGE",
      name: "Mock Page",
      capabilitiesJson: {},
    },
  });
  created.identityIds.push(identity.id);

  await prisma.socialWebhookSubscription.create({
    data: { connectionId: connection.id, eventType: "comments" },
  });
  await assert.rejects(
    prisma.socialWebhookSubscription.create({
      data: { connectionId: connection.id, eventType: "comments" },
    }),
  );
  await prisma.socialWebhookSubscription.create({
    data: { connectionId: connection.id, eventType: "messages" },
  });

  await prisma.socialWebhookSubscription.create({
    data: {
      connectionId: connection.id,
      identityId: identity.id,
      eventType: "comments",
    },
  });
  await assert.rejects(
    prisma.socialWebhookSubscription.create({
      data: {
        connectionId: connection.id,
        identityId: identity.id,
        eventType: "comments",
      },
    }),
  );
});

test("legacySourceId partial unique index prevents duplicate migrated SocialPosts", async () => {
  const admin = await createAdmin("legacy-source");
  const legacySourceId = `legacy-source-${Date.now()}`;
  const first = await prisma.socialPost.create({
    data: {
      title: "Legacy migrated post",
      status: "DRAFT",
      createdById: admin.id,
      legacySourceId,
    },
  });
  created.socialPostIds.push(first.id);

  await assert.rejects(
    prisma.socialPost.create({
      data: {
        title: "Duplicate legacy migrated post",
        status: "DRAFT",
        createdById: admin.id,
        legacySourceId,
      },
    }),
  );
});
