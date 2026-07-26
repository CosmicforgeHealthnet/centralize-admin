require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
  MIGRATION_DIR,
  verifyMigrationManifest,
} = require("./migration-manifest");
const {
  validateAdminDatabaseTarget,
  verifyConnectedDatabaseTarget,
  formatTargetSummary,
} = require("./admin-database-target");
const {
  REQUIRED_PARTIAL_INDEXES,
  inspectRequiredPartialIndexes,
} = require("./schema-assertions");

const LEDGER_TABLE = "social_manual_migrations";
const LOCK_KEY = "social_operations_admin_database_prepare";
const APPROVED_ADMIN_DATABASE_MIGRATIONS = [
  "20260718_ensure_social_operations_partial_indexes.sql",
  // The configured local Admin schema predates Marketing Intelligence Phase 2.
  // These additive prerequisites must precede Advertising Execution foreign keys.
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
];

function requiredSqlRange(sql, startMarker, endMarker = null) {
  const start = sql.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`unable to locate PostgreSQL-only artifact marker: ${startMarker}`);
  }

  const end = endMarker ? sql.indexOf(endMarker, start) : sql.length;
  if (endMarker && end === -1) {
    throw new Error(`unable to locate PostgreSQL-only artifact end marker: ${endMarker}`);
  }

  return sql.slice(start, end).trim();
}

function requiredSqlMatch(sql, pattern, label) {
  const match = sql.match(pattern);
  if (!match) {
    throw new Error(`unable to extract PostgreSQL-only artifact: ${label}`);
  }
  return match[0].trim();
}

function postPrismaArtifactSql(file, migrationSql) {
  const sql = migrationSql.replace(/\r\n/g, "\n");

  switch (file) {
    case "20260728_advertising_execution_sections9_10.sql":
      return requiredSqlRange(
        sql,
        "-- Prisma cannot represent PostgreSQL partial unique indexes.",
        "-- AddForeignKey",
      );

    case "20260729_advertising_execution_sections18_24.sql":
      return requiredSqlMatch(
        sql,
        /ALTER TABLE "marketing_execution_jobs"\s+ADD CONSTRAINT "CHK_marketing_execution_jobs_account_external_id"\s+CHECK \(length\(btrim\("account_external_id"\)\) BETWEEN 1 AND 255\);/,
        "Sections 18-24 account identifier check",
      );

    case "20260730_advertising_execution_sections18_24_remediation.sql":
      return [
        requiredSqlMatch(
          sql,
          /DROP INDEX IF EXISTS "UQ_marketing_execution_plans_source_recommendation";\s*CREATE UNIQUE INDEX "UQ_marketing_execution_plans_active_source_recommendation"[\s\S]*?;/,
          "active recommendation-plan partial index",
        ),
        requiredSqlMatch(
          sql,
          /DROP INDEX IF EXISTS "UQ_marketing_execution_jobs_active_connection";\s*CREATE UNIQUE INDEX "UQ_marketing_execution_jobs_active_account"[\s\S]*?;/,
          "active provider-account partial index",
        ),
      ].join("\n\n");

    case "20260731_advertising_execution_sections25_28.sql":
      return requiredSqlRange(
        sql,
        "CREATE OR REPLACE FUNCTION prevent_marketing_execution_evidence_mutation()",
      );

    case "20260801_advertising_execution_sections25_28_remediation.sql":
      return [
        `
ALTER TABLE "marketing_execution_emergency_overrides"
  ADD CONSTRAINT "CHK_marketing_execution_overrides_duration"
    CHECK ("expires_at" > "starts_at" AND "expires_at" <= "starts_at" + INTERVAL '2 hours'),
  ADD CONSTRAINT "CHK_marketing_execution_overrides_scope"
    CHECK ("scope_type" IN ('CONNECTION','ACCOUNT','PLAN','RUN','OPERATION')),
  ADD CONSTRAINT "CHK_marketing_execution_overrides_status"
    CHECK ("status" IN ('ACTIVE','EXPIRED','REVOKED')),
  ADD CONSTRAINT "CHK_marketing_execution_overrides_use_count"
    CHECK ("use_count" >= 0);
        `.trim(),
        requiredSqlRange(
          sql,
          "-- The shared application exposes AuditLog insertion and reads only.",
        ),
      ].join("\n\n");

    default:
      return migrationSql;
  }
}

const DUPLICATE_PRECHECKS = {
  social_webhook_subscription_connection_event_unique: `
    SELECT COUNT(*)::int AS duplicate_groups
    FROM (
      SELECT connection_id, event_type
      FROM public.social_webhook_subscriptions
      WHERE identity_id IS NULL
      GROUP BY connection_id, event_type
      HAVING COUNT(*) > 1
    ) duplicate_keys
  `,
  social_webhook_subscription_identity_event_unique: `
    SELECT COUNT(*)::int AS duplicate_groups
    FROM (
      SELECT connection_id, identity_id, event_type
      FROM public.social_webhook_subscriptions
      WHERE identity_id IS NOT NULL
      GROUP BY connection_id, identity_id, event_type
      HAVING COUNT(*) > 1
    ) duplicate_keys
  `,
  social_posts_legacy_source_id_unique: `
    SELECT COUNT(*)::int AS duplicate_groups
    FROM (
      SELECT legacy_source_id
      FROM public.social_posts
      WHERE legacy_source_id IS NOT NULL
      GROUP BY legacy_source_id
      HAVING COUNT(*) > 1
    ) duplicate_keys
  `,
};

function assertManifestOk(manifestResult) {
  if (manifestResult.failures.length) {
    throw new Error(`migration manifest failed: ${manifestResult.failures.join(",")}`);
  }
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${LEDGER_TABLE} (
      file TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getLedgerEntry(client, file) {
  const result = await client.query(
    `SELECT file, sha256, applied_at FROM public.${LEDGER_TABLE} WHERE file = $1`,
    [file],
  );
  return result.rows[0] || null;
}

async function recordLedgerEntry(client, entry) {
  await client.query(
    `
    INSERT INTO public.${LEDGER_TABLE} (file, sha256)
    VALUES ($1, $2)
    `,
    [entry.file, entry.sha256],
  );
}

function ensureExistingIndexesAreCompatible(indexes, { allowMissing = true } = {}) {
  for (const [name, index] of Object.entries(indexes)) {
    if (index.status === "OK") continue;
    if (allowMissing && index.status === "MISSING") continue;
    throw new Error(`required partial index ${name} is ${index.status}`);
  }
}

async function checkDuplicateData(client) {
  const results = {};
  for (const name of Object.keys(REQUIRED_PARTIAL_INDEXES)) {
    const result = await client.query(DUPLICATE_PRECHECKS[name]);
    const duplicateGroups = Number(result.rows[0]?.duplicate_groups || 0);
    results[name] = { duplicateGroups };
    if (duplicateGroups > 0) {
      throw new Error(`duplicate data prevents ${name}: duplicate_groups=${duplicateGroups}`);
    }
  }
  return results;
}

async function acquireAdvisoryLock(client) {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
}

async function releaseAdvisoryLock(client) {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
}

function manifestEntryByFile(manifest) {
  return new Map(manifest.migrations.map((entry) => [entry.file, entry]));
}

async function applyMigration(client, entry) {
  const migrationSql = fs.readFileSync(path.join(MIGRATION_DIR, entry.file), "utf8");
  const sql = postPrismaArtifactSql(entry.file, migrationSql);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    const indexes = await inspectRequiredPartialIndexes(client);
    ensureExistingIndexesAreCompatible(indexes, { allowMissing: false });
    await recordLedgerEntry(client, entry);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function prepareAdminDatabase({ connectionString = process.env.DATABASE_URL } = {}) {
  const target = validateAdminDatabaseTarget({ connectionString });
  const manifestResult = verifyMigrationManifest();
  assertManifestOk(manifestResult);
  const entries = manifestEntryByFile(manifestResult.manifest);
  const client = new Client({ connectionString });
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  let locked = false;
  const result = {
    target,
    connectedTarget: null,
    manifestCount: manifestResult.count,
    approvedMigrations: APPROVED_ADMIN_DATABASE_MIGRATIONS.length,
    applied: [],
    skipped: [],
    duplicatePrechecks: {},
    ledgerTable: LEDGER_TABLE,
    advisoryLock: "acquired",
  };
  try {
    result.connectedTarget = await verifyConnectedDatabaseTarget(client, target);
    await acquireAdvisoryLock(client);
    locked = true;
    await ensureLedger(client);
    const initialIndexes = await inspectRequiredPartialIndexes(client);
    ensureExistingIndexesAreCompatible(initialIndexes, { allowMissing: true });
    result.duplicatePrechecks = await checkDuplicateData(client);

    for (const file of APPROVED_ADMIN_DATABASE_MIGRATIONS) {
      const entry = entries.get(file);
      if (!entry) throw new Error(`approved migration missing from manifest: ${file}`);
      const ledgerEntry = await getLedgerEntry(client, file);
      if (ledgerEntry) {
        if (ledgerEntry.sha256 !== entry.sha256) {
          throw new Error(`applied migration checksum mismatch: ${file}`);
        }
        const indexes = await inspectRequiredPartialIndexes(client);
        ensureExistingIndexesAreCompatible(indexes, { allowMissing: false });
        result.skipped.push(file);
        continue;
      }
      await applyMigration(client, entry);
      result.applied.push(file);
    }
  } finally {
    if (locked) await releaseAdvisoryLock(client);
    await client.end();
  }
  return result;
}

async function main() {
  try {
    const result = await prepareAdminDatabase();
    console.log(`db-admin-prepare target ${formatTargetSummary(result.target)}`);
    console.log(
      `db-admin-prepare connected_database=${result.connectedTarget.database} connected_schema=${result.connectedTarget.schema}`,
    );
    console.log(`db-admin-prepare manifest migrations=${result.manifestCount}`);
    console.log(
      `db-admin-prepare ledger_table=${result.ledgerTable} advisory_lock=${result.advisoryLock} applied=${result.applied.length} skipped=${result.skipped.length}`,
    );
    console.log("db-admin-prepare duplicate_precheck=ok partial_indexes=ok");
  } catch (error) {
    console.log(`db-admin-prepare status=failed reason=${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  LEDGER_TABLE,
  LOCK_KEY,
  APPROVED_ADMIN_DATABASE_MIGRATIONS,
  postPrismaArtifactSql,
  DUPLICATE_PRECHECKS,
  ensureLedger,
  getLedgerEntry,
  checkDuplicateData,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  ensureExistingIndexesAreCompatible,
  prepareAdminDatabase,
};
