const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  validateAdminDatabaseTarget,
  formatTargetSummary,
} = require("../scripts/social-operations/admin-database-target");
const {
  REQUIRED_PARTIAL_INDEXES,
  validatePartialIndexDefinition,
  normalizePredicate,
  runSchemaAssertions,
} = require("../scripts/social-operations/schema-assertions");
const {
  APPROVED_ADMIN_DATABASE_MIGRATIONS,
  DUPLICATE_PRECHECKS,
  prepareAdminDatabase,
} = require("../scripts/social-operations/prepare-admin-database");

function indexRow(overrides = {}) {
  return {
    schemaName: "public",
    indexName: "social_webhook_subscription_connection_event_unique",
    tableName: "social_webhook_subscriptions",
    isUnique: true,
    isValid: true,
    isReady: true,
    columns: ["connection_id", "event_type"],
    predicate: "(identity_id IS NULL)",
    indexDef:
      "CREATE UNIQUE INDEX social_webhook_subscription_connection_event_unique ON public.social_webhook_subscriptions USING btree (connection_id, event_type) WHERE (identity_id IS NULL)",
    ...overrides,
  };
}

function databaseUrl({ host = "localhost", database = "cosmicforge_admin", schema } = {}) {
  const url = new URL(`postgresql://${host}:5432/${database}`);
  url.username = "user";
  url.password = "password";
  if (schema) url.searchParams.set("schema", schema);
  return url.toString();
}

test("Admin database target guard accepts only cosmicforge_admin public on approved local hosts", () => {
  const target = validateAdminDatabaseTarget({
    connectionString: databaseUrl({ schema: "public" }),
  });
  assert.equal(target.database, "cosmicforge_admin");
  assert.equal(target.schema, "public");
  assert.equal(target.host, "localhost");
  assert.doesNotMatch(formatTargetSummary(target), /secret|postgresql:\/\//);
});

test("Admin database target guard rejects wrong database, wrong schema and production-like CI host", () => {
  assert.throws(
    () => validateAdminDatabaseTarget({ connectionString: databaseUrl({ database: "cosmicforge_test" }) }),
    /cosmicforge_admin/,
  );
  assert.throws(
    () =>
      validateAdminDatabaseTarget({
        connectionString: databaseUrl({ schema: "social" }),
      }),
    /schema target must be public/,
  );
  assert.throws(
    () =>
      validateAdminDatabaseTarget({
        connectionString: databaseUrl({ host: "prod-db.example.com", schema: "public" }),
        ci: true,
      }),
    /approved local CI\/Admin host|production-like/,
  );
});

test("partial index diagnostics classify missing and malformed definitions", () => {
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      null,
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "MISSING",
  );
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      indexRow({ isUnique: false }),
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "NOT_UNIQUE",
  );
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      indexRow({ isValid: false }),
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "INVALID",
  );
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      indexRow({ isReady: false }),
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "NOT_READY",
  );
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      indexRow({ columns: ["event_type", "connection_id"] }),
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "WRONG_COLUMNS",
  );
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      indexRow({ predicate: "(identity_id IS NOT NULL)" }),
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "WRONG_PREDICATE",
  );
  assert.equal(
    validatePartialIndexDefinition(
      "social_webhook_subscription_connection_event_unique",
      indexRow(),
      REQUIRED_PARTIAL_INDEXES.social_webhook_subscription_connection_event_unique,
    ).status,
    "OK",
  );
});

test("predicate normalization accepts harmless PostgreSQL formatting only", () => {
  assert.equal(normalizePredicate('("identity_id" IS NULL)'), normalizePredicate("identity_id is null"));
  assert.notEqual(normalizePredicate("identity_id IS NULL"), normalizePredicate("identity_id IS NOT NULL"));
});

test("Admin preparation applies only the explicitly approved same-database migrations", () => {
  assert.deepEqual(APPROVED_ADMIN_DATABASE_MIGRATIONS, [
    "20260718_ensure_social_operations_partial_indexes.sql",
    "20260721_marketing_intelligence_wp0_corrections.sql",
    "20260722_marketing_intelligence_phase2_section7_schema.sql",
    "20260723_marketing_intelligence_phase2_section8_raw_ingestion.sql",
    "20260724_marketing_intelligence_phase2_section9_scoring_enums.sql",
    "20260725_marketing_intelligence_phase2_sections10_13.sql",
    "20260726_marketing_intelligence_sections10_13_audit_corrections.sql",
    "20260727_marketing_intelligence_sections14_17.sql",
    "20260728_advertising_execution_sections9_10.sql",
    "20260729_advertising_execution_sections18_24.sql",
    "20260730_advertising_execution_sections18_24_remediation.sql",
    "20260731_advertising_execution_sections25_28.sql",
    "20260801_advertising_execution_sections25_28_remediation.sql",
  ]);
  const migrations = APPROVED_ADMIN_DATABASE_MIGRATIONS.map((file) => fs.readFileSync(
    path.join(__dirname, "..", "prisma", "manual-migrations", file), "utf8",
  ));
  for (const migration of migrations) {
    assert.doesNotMatch(migration, /\bCREATE\s+DATABASE\b/i);
    assert.doesNotMatch(migration, /\bDROP\s+DATABASE\b/i);
    assert.doesNotMatch(migration, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  }
  assert.match(migrations[0], /CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_connection_event_unique/);
  assert.match(migrations[0], /CREATE UNIQUE INDEX IF NOT EXISTS social_webhook_subscription_identity_event_unique/);
  assert.match(migrations[0], /CREATE UNIQUE INDEX IF NOT EXISTS social_posts_legacy_source_id_unique/);
});

test("duplicate-data prechecks are aggregate-only and cover all required partial indexes", () => {
  assert.deepEqual(Object.keys(DUPLICATE_PRECHECKS).sort(), Object.keys(REQUIRED_PARTIAL_INDEXES).sort());
  for (const sql of Object.values(DUPLICATE_PRECHECKS)) {
    assert.match(sql, /COUNT\(\*\)::int AS duplicate_groups/);
    assert.doesNotMatch(sql, /SELECT\s+\*/i);
  }
});

test("Admin database preparation is idempotent on the approved local Admin database", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    t.skip("requires local cosmicforge_admin DATABASE_URL");
    return;
  }
  try {
    validateAdminDatabaseTarget({ connectionString: databaseUrl });
  } catch {
    t.skip("requires approved local cosmicforge_admin DATABASE_URL");
    return;
  }

  const first = await prepareAdminDatabase({ connectionString: databaseUrl });
  const second = await prepareAdminDatabase({ connectionString: databaseUrl });
  assert.equal(first.target.database, "cosmicforge_admin");
  assert.equal(first.connectedTarget.database, "cosmicforge_admin");
  assert.equal(second.connectedTarget.database, "cosmicforge_admin");
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, APPROVED_ADMIN_DATABASE_MIGRATIONS.length);
  const assertion = await runSchemaAssertions({ connectionString: databaseUrl });
  assert.equal(assertion.connectedTarget.database, "cosmicforge_admin");
  assert.equal(assertion.connectedTarget.schema, "public");
});
