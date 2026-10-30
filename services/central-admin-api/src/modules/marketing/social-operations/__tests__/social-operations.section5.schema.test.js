const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../../../../../");
const schemaPath = path.join(repoRoot, "prisma/schema.prisma");
const migrationPath = path.join(
  repoRoot,
  "prisma/manual-migrations/20260716_add_social_operations_section_5.sql",
);

const SOCIAL_MODELS = {
  SocialAccountConnection: "social_account_connections",
  SocialPublishingIdentity: "social_publishing_identities",
  SocialOAuthState: "social_oauth_states",
  SocialPost: "social_posts",
  SocialPostRevision: "social_post_revisions",
  SocialPostTarget: "social_post_targets",
  SocialPostApproval: "social_post_approvals",
  SocialPublication: "social_publications",
  SocialPublicationAttempt: "social_publication_attempts",
  SocialPublishingJob: "social_publishing_jobs",
  SocialMediaAsset: "social_media_assets",
  SocialPostMedia: "social_post_media",
  SocialContact: "social_contacts",
  SocialConversation: "social_conversations",
  SocialMessage: "social_messages",
  SocialTag: "social_tags",
  SocialConversationTag: "social_conversation_tags",
  SocialProviderContent: "social_provider_content",
  SocialComment: "social_comments",
  SocialEngagementEvent: "social_engagement_events",
  SocialEscalation: "social_escalations",
  SocialWebhookSubscription: "social_webhook_subscriptions",
  SocialWebhookEvent: "social_webhook_events",
  SocialIdentityMetricSnapshot: "social_identity_metric_snapshots",
  SocialProviderContentMetricSnapshot:
    "social_provider_content_metric_snapshots",
  SocialIdentitySyncState: "social_identity_sync_state",
  SocialActionJob: "social_action_jobs",
  SocialActionAttempt: "social_action_attempts",
  SocialInternalNote: "social_internal_notes",
  SocialSavedReply: "social_saved_replies",
  SocialOperationsSetting: "social_operations_settings",
};

const ADMIN_INVERSE_FIELDS = [
  "socialAccountConnections",
  "socialOAuthStates",
  "socialPostsCreated",
  "socialPostRevisionsCreated",
  "socialApprovalsSubmitted",
  "socialApprovalsDecided",
  "socialPublicationsRequested",
  "socialPublicationsApproved",
  "socialMediaAssets",
  "socialContactsLinked",
  "socialConversationsAssigned",
  "socialConversationAssignments",
  "socialMessagesSent",
  "socialConversationTagsAdded",
  "socialCommentsAssigned",
  "socialCommentsSent",
  "socialEscalationsConfirmed",
  "socialInternalNotesAuthored",
  "socialSavedRepliesCreated",
  "socialSettingsUpdated",
];

function modelBlock(schema, modelName) {
  const match = schema.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `${modelName} model is missing`);
  return match[1];
}

function isRelationField(fieldType, line) {
  const baseType = fieldType.replace(/[?\[\]]/g, "");
  const relationTypes = new Set([
    ...Object.keys(SOCIAL_MODELS),
    "AdminUser",
    "marketing_campaigns",
    "Task",
  ]);

  return (
    relationTypes.has(baseType) &&
    (line.includes("@relation") || fieldType.endsWith("[]") || fieldType.endsWith("?"))
  );
}

test("section 5 social operations models are fully mapped to social tables", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const socialModelNames = [...schema.matchAll(/^model (Social\w+) \{/gm)].map(
    (match) => match[1],
  );

  assert.equal(socialModelNames.length, 31);
  assert.deepEqual(socialModelNames.sort(), Object.keys(SOCIAL_MODELS).sort());

  for (const [modelName, tableName] of Object.entries(SOCIAL_MODELS)) {
    const block = modelBlock(schema, modelName);
    assert.match(block, new RegExp(`@@map\\("${tableName}"\\)`));
  }
});

test("section 5 camelCase scalar fields have explicit snake-case column maps", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");

  for (const modelName of Object.keys(SOCIAL_MODELS)) {
    const block = modelBlock(schema, modelName);
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      const field = line.match(/^(\w+)\s+([A-Za-z_]\w*(?:\?|\[\])?)/);
      if (!field) continue;

      const [, fieldName, fieldType] = field;
      if (!/[A-Z]/.test(fieldName)) continue;
      if (isRelationField(fieldType, line)) continue;

      assert.match(
        line,
        /@map\("[a-z0-9_]+?"\)/,
        `${modelName}.${fieldName} must map to a snake_case column`,
      );
    }
  }
});

test("section 5 uses text references for existing text-id parents only", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");

  assert.match(
    modelBlock(schema, "SocialPost"),
    /campaignId\s+String\?\s+@map\("campaign_id"\)/,
  );
  assert.match(
    modelBlock(schema, "SocialEscalation"),
    /taskId\s+String\?\s+@map\("task_id"\)/,
  );
  assert.match(
    modelBlock(schema, "SocialAccountConnection"),
    /createdById\s+String\s+@map\("created_by_id"\)/,
  );
  assert.doesNotMatch(
    modelBlock(schema, "SocialContact"),
    /linkedSubject.*@relation/,
  );
});

test("section 5 inverse relations and webhook partial unique migration are present", () => {
  const schema = fs.readFileSync(schemaPath, "utf8");
  const migration = fs.readFileSync(migrationPath, "utf8");
  const adminBlock = modelBlock(schema, "AdminUser");
  const campaignBlock = modelBlock(schema, "marketing_campaigns");
  const taskBlock = modelBlock(schema, "Task");

  for (const fieldName of ADMIN_INVERSE_FIELDS) {
    assert.match(adminBlock, new RegExp(`\\b${fieldName}\\b`));
  }
  assert.match(campaignBlock, /\bsocialPosts\s+SocialPost\[\]/);
  assert.match(taskBlock, /\bsocialEscalations\s+SocialEscalation\[\]/);

  assert.doesNotMatch(
    modelBlock(schema, "SocialWebhookSubscription"),
    /@@unique\(\[connectionId,\s*identityId,\s*eventType\]\)/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_connection_event_unique[\s\S]*WHERE "identity_id" IS NULL;/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_identity_event_unique[\s\S]*WHERE "identity_id" IS NOT NULL;/,
  );
  assert.doesNotMatch(migration, /ALTER TABLE "marketing_|DROP TABLE|DROP TYPE/);
});
