"use strict";

// Forward-only migration runner for the HQ integration schema.
//  - each file runs in its own transaction under an advisory lock;
//  - applied files are recorded with their SHA-256 and a changed file is
//    refused (corrections must be new migrations);
//  - runtime grants are applied to an operator-provisioned role that has no
//    DDL, no DELETE (except replay nonces) and no UPDATE on append-only tables.
// Runs only with the migration credential, never the runtime credential.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const SCHEMA = "hq_integration";
const LEDGER = SCHEMA + ".hq_product_admin_schema_migrations";
const LOCK_KEY = 7340117001; // stable advisory lock id for this schema
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

const RUNTIME_GRANTS = [
  `GRANT USAGE ON SCHEMA ${SCHEMA} TO {role}`,
  `GRANT SELECT, INSERT, UPDATE ON ${SCHEMA}.hq_product_admins, ${SCHEMA}.hq_product_admin_contracts, ${SCHEMA}.hq_product_admin_grants, ${SCHEMA}.hq_product_admin_datasets, ${SCHEMA}.hq_product_admin_subscriptions, ${SCHEMA}.hq_product_admin_sync_cursors, ${SCHEMA}.hq_product_admin_metrics, ${SCHEMA}.hq_product_admin_sync_runs, ${SCHEMA}.hq_product_admin_quarantine TO {role}`,
  `GRANT SELECT, INSERT ON ${SCHEMA}.hq_product_admin_event_inbox, ${SCHEMA}.hq_product_admin_lineage, ${SCHEMA}.hq_product_admin_onboarding_approvals, ${SCHEMA}.hq_product_admin_security_audit TO {role}`,
  `GRANT SELECT, INSERT, DELETE ON ${SCHEMA}.hq_product_admin_replay_nonces TO {role}`,
  `GRANT SELECT ON ${LEDGER} TO {role}`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO {role}`,
];

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort().map((file) => {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    return { version: file.replace(/\.sql$/, ""), file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

async function migrate(client, { runtimeRole = null, dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  if (runtimeRole !== null && !ROLE.test(runtimeRole)) throw new Error("runtime_role_invalid");
  const migrations = listMigrations(dir);
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query(`SELECT version, checksum FROM ${LEDGER}`);
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const known of applied.keys()) {
      if (!migrations.some((m) => m.version === known)) throw new Error("applied_migration_missing:" + known);
    }
    const results = [];
    for (const m of migrations) {
      if (applied.has(m.version)) {
        if (applied.get(m.version) !== m.checksum) throw new Error("migration_checksum_mismatch:" + m.version);
        results.push({ version: m.version, status: "ALREADY_APPLIED" });
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(`INSERT INTO ${LEDGER} (version, checksum) VALUES ($1, $2)`, [m.version, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      log({ event: "migration_applied", version: m.version });
      results.push({ version: m.version, status: "APPLIED" });
    }
    if (runtimeRole) {
      for (const statement of RUNTIME_GRANTS) await client.query(statement.replaceAll("{role}", `"${runtimeRole}"`));
      log({ event: "runtime_grants_applied", role: runtimeRole });
    }
    return results;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

module.exports = { migrate, listMigrations, SCHEMA, LEDGER, RUNTIME_GRANTS };
