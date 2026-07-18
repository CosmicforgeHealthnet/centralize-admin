require("dotenv").config();
const { Client } = require("pg");

const SOCIAL_TABLES = [
  "social_account_connections",
  "social_publishing_identities",
  "social_oauth_states",
  "social_posts",
  "social_post_revisions",
  "social_post_targets",
  "social_post_approvals",
  "social_publications",
  "social_publication_attempts",
  "social_publishing_jobs",
  "social_media_assets",
  "social_post_media",
  "social_contacts",
  "social_conversations",
  "social_messages",
  "social_tags",
  "social_conversation_tags",
  "social_provider_content",
  "social_comments",
  "social_engagement_events",
  "social_escalations",
  "social_webhook_subscriptions",
  "social_webhook_events",
  "social_identity_metric_snapshots",
  "social_provider_content_metric_snapshots",
  "social_identity_sync_state",
  "social_action_jobs",
  "social_action_attempts",
  "social_internal_notes",
  "social_saved_replies",
  "social_operations_settings",
];

const REQUIRED_INDEXES = {
  social_webhook_subscription_connection_event_unique: "identity_id IS NULL",
  social_webhook_subscription_identity_event_unique: "identity_id IS NOT NULL",
  social_posts_legacy_source_id_unique: "legacy_source_id IS NOT NULL",
};

function normalizePredicate(text) {
  return String(text || "")
    .replace(/[()"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function runSchemaAssertions({ connectionString = process.env.DATABASE_URL } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required for schema assertions");
  const client = new Client({ connectionString });
  await client.connect();
  const results = {
    socialTables: null,
    partialIndexes: {},
    taskAssigneeNullable: null,
    foreignKeyTypes: {},
  };
  try {
    const tableRows = await client.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      `,
      [SOCIAL_TABLES],
    );
    const present = new Set(tableRows.rows.map((row) => row.table_name));
    const missing = SOCIAL_TABLES.filter((table) => !present.has(table));
    results.socialTables = {
      expected: SOCIAL_TABLES.length,
      present: present.size,
      missing,
    };

    const indexRows = await client.query(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1)
      `,
      [Object.keys(REQUIRED_INDEXES)],
    );
    const indexes = new Map(indexRows.rows.map((row) => [row.indexname, row.indexdef]));
    for (const [name, expectedPredicate] of Object.entries(REQUIRED_INDEXES)) {
      const indexdef = indexes.get(name) || "";
      results.partialIndexes[name] = {
        present: Boolean(indexdef),
        predicateMatched: normalizePredicate(indexdef).includes(normalizePredicate(expectedPredicate)),
      };
    }

    const taskColumn = await client.query(
      `
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tasks'
        AND column_name = 'assigneeId'
      `,
    );
    results.taskAssigneeNullable = taskColumn.rows[0]?.is_nullable === "YES";

    const typeRows = await client.query(
      `
      SELECT table_name, column_name, udt_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('admin_users', 'id'),
          ('social_account_connections', 'created_by_id'),
          ('social_oauth_states', 'admin_user_id'),
          ('social_media_assets', 'owner_id'),
          ('marketing_campaigns', 'id'),
          ('social_posts', 'campaign_id'),
          ('tasks', 'id'),
          ('social_escalations', 'task_id')
        )
      `,
    );
    const types = Object.fromEntries(
      typeRows.rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        row.udt_name || row.data_type,
      ]),
    );
    results.foreignKeyTypes = {
      adminUserId: {
        referenced: types["admin_users.id"],
        socialColumns: {
          "social_account_connections.created_by_id": types["social_account_connections.created_by_id"],
          "social_oauth_states.admin_user_id": types["social_oauth_states.admin_user_id"],
          "social_media_assets.owner_id": types["social_media_assets.owner_id"],
        },
      },
      marketingCampaignId: {
        referenced: types["marketing_campaigns.id"],
        socialColumns: {
          "social_posts.campaign_id": types["social_posts.campaign_id"],
        },
      },
      taskId: {
        referenced: types["tasks.id"],
        socialColumns: {
          "social_escalations.task_id": types["social_escalations.task_id"],
        },
      },
    };
  } finally {
    await client.end();
  }

  const failures = [];
  if (results.socialTables.missing.length) {
    failures.push(`missing social tables: ${results.socialTables.missing.join(",")}`);
  }
  for (const [name, index] of Object.entries(results.partialIndexes)) {
    if (!index.present || !index.predicateMatched) failures.push(`partial index invalid: ${name}`);
  }
  if (!results.taskAssigneeNullable) failures.push("tasks.assigneeId is not nullable");
  for (const group of Object.values(results.foreignKeyTypes)) {
    for (const [column, type] of Object.entries(group.socialColumns)) {
      if (type !== group.referenced) failures.push(`type mismatch: ${column}`);
    }
  }
  if (failures.length) {
    const error = new Error("Social Operations schema assertions failed");
    error.failures = failures;
    error.results = results;
    throw error;
  }
  return results;
}

async function main() {
  try {
    const results = await runSchemaAssertions();
    console.log(
      `db-schema-assert social_tables=${results.socialTables.present}/${results.socialTables.expected} partial_indexes=ok task_assignee_nullable=${results.taskAssigneeNullable}`,
    );
    console.log(`db-schema-assert fk_types=${JSON.stringify(results.foreignKeyTypes)}`);
  } catch (error) {
    console.log(`db-schema-assert status=failed failures=${(error.failures || [error.message]).join(";")}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SOCIAL_TABLES,
  REQUIRED_INDEXES,
  runSchemaAssertions,
};
