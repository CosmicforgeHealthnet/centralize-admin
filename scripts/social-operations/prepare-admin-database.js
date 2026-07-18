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
];

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
  const sql = fs.readFileSync(path.join(MIGRATION_DIR, entry.file), "utf8");
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
  DUPLICATE_PRECHECKS,
  ensureLedger,
  getLedgerEntry,
  checkDuplicateData,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  ensureExistingIndexesAreCompatible,
  prepareAdminDatabase,
};
