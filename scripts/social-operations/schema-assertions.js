require("dotenv").config();
const { Client } = require("pg");
const {
  validateAdminDatabaseTarget,
  verifyConnectedDatabaseTarget,
  parseDatabaseTarget,
  queryConnectedTarget,
  LOCAL_CI_HOSTS,
  formatTargetSummary,
} = require("./admin-database-target");

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

const REQUIRED_PARTIAL_INDEXES = {
  social_webhook_subscription_connection_event_unique: {
    schema: "public",
    table: "social_webhook_subscriptions",
    columns: ["connection_id", "event_type"],
    predicate: "identity_id IS NULL",
  },
  social_webhook_subscription_identity_event_unique: {
    schema: "public",
    table: "social_webhook_subscriptions",
    columns: ["connection_id", "identity_id", "event_type"],
    predicate: "identity_id IS NOT NULL",
  },
  social_posts_legacy_source_id_unique: {
    schema: "public",
    table: "social_posts",
    columns: ["legacy_source_id"],
    predicate: "legacy_source_id IS NOT NULL",
  },
};

const REQUIRED_INDEXES = Object.fromEntries(
  Object.entries(REQUIRED_PARTIAL_INDEXES).map(([name, spec]) => [name, spec.predicate]),
);

function normalizePredicate(text) {
  return String(text || "")
    .replace(/[()"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeColumn(text) {
  return String(text || "")
    .replace(/"/g, "")
    .trim()
    .toLowerCase();
}

function compareArrays(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function loadPartialIndexCatalog(client, indexNames = Object.keys(REQUIRED_PARTIAL_INDEXES)) {
  const result = await client.query(
    `
    SELECT
      n.nspname AS "schemaName",
      i.relname AS "indexName",
      t.relname AS "tableName",
      ix.indisunique AS "isUnique",
      ix.indisvalid AS "isValid",
      ix.indisready AS "isReady",
      pg_get_indexdef(ix.indexrelid) AS "indexDef",
      pg_get_expr(ix.indpred, ix.indrelid) AS "predicate",
      ARRAY(
        SELECT pg_get_indexdef(ix.indexrelid, key_position, true)
        FROM generate_series(1, ix.indnkeyatts) AS key_position
        ORDER BY key_position
      ) AS "columns"
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE i.relname = ANY($1)
    ORDER BY i.relname
    `,
    [indexNames],
  );
  return new Map(result.rows.map((row) => [row.indexName, row]));
}

function validatePartialIndexDefinition(name, row, spec = REQUIRED_PARTIAL_INDEXES[name]) {
  if (!row) return { present: false, status: "MISSING", predicateMatched: false };
  if (row.schemaName !== spec.schema) return { present: true, status: "WRONG_SCHEMA", row };
  if (row.tableName !== spec.table) return { present: true, status: "WRONG_TABLE", row };
  if (row.isUnique !== true) return { present: true, status: "NOT_UNIQUE", row };
  if (row.isValid !== true) return { present: true, status: "INVALID", row };
  if (row.isReady !== true) return { present: true, status: "NOT_READY", row };
  const actualColumns = (row.columns || []).map(normalizeColumn);
  const expectedColumns = spec.columns.map(normalizeColumn);
  if (!compareArrays(actualColumns, expectedColumns)) {
    return {
      present: true,
      status: "WRONG_COLUMNS",
      row,
      actualColumns,
      expectedColumns,
    };
  }
  const predicateMatched = normalizePredicate(row.predicate) === normalizePredicate(spec.predicate);
  if (!predicateMatched) {
    return {
      present: true,
      status: "WRONG_PREDICATE",
      row,
      predicateMatched,
      actualPredicate: row.predicate,
      expectedPredicate: spec.predicate,
    };
  }
  return {
    present: true,
    status: "OK",
    predicateMatched: true,
    row,
    schema: row.schemaName,
    table: row.tableName,
    columns: actualColumns,
    predicate: row.predicate,
    definition: row.indexDef,
    unique: row.isUnique,
    valid: row.isValid,
    ready: row.isReady,
  };
}

async function inspectRequiredPartialIndexes(client) {
  const catalog = await loadPartialIndexCatalog(client);
  return Object.fromEntries(
    Object.entries(REQUIRED_PARTIAL_INDEXES).map(([name, spec]) => [
      name,
      validatePartialIndexDefinition(name, catalog.get(name), spec),
    ]),
  );
}

async function runSchemaAssertions({ connectionString = process.env.DATABASE_URL, allowDisposableReplay = false } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required for schema assertions");
  const target = allowDisposableReplay
    ? parseDatabaseTarget(connectionString)
    : validateAdminDatabaseTarget({ connectionString });
  if (allowDisposableReplay) {
    if (!LOCAL_CI_HOSTS.has(target.host)) throw new Error("replay database host must be local");
    if (!/^cosmicforge_social_replay_\d+$/.test(target.database)) throw new Error("invalid disposable replay database target");
    if (target.schema !== "public") throw new Error("replay schema target must be public");
  }
  const client = new Client({ connectionString });
  await client.connect();
  const results = {
    databaseTarget: target,
    connectedTarget: null,
    socialTables: null,
    partialIndexes: {},
    taskAssigneeNullable: null,
    foreignKeyTypes: {},
  };
  try {
    if (allowDisposableReplay) {
      results.connectedTarget = await queryConnectedTarget(client);
      if (results.connectedTarget.database !== target.database || results.connectedTarget.schema !== target.schema) {
        throw new Error("connected replay database does not match configured target");
      }
    } else {
      results.connectedTarget = await verifyConnectedDatabaseTarget(client, target);
    }
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

    results.partialIndexes = await inspectRequiredPartialIndexes(client);

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
    if (index.status !== "OK") failures.push(`partial index invalid: ${name}:${index.status}`);
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
    console.log(`db-schema-assert target ${formatTargetSummary(results.databaseTarget)}`);
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
  REQUIRED_PARTIAL_INDEXES,
  normalizePredicate,
  normalizeColumn,
  loadPartialIndexCatalog,
  validatePartialIndexDefinition,
  inspectRequiredPartialIndexes,
  runSchemaAssertions,
};
