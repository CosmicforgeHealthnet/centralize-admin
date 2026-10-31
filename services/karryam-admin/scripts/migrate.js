"use strict";

// Forward-only migration runner for the dedicated Karryam Admin database.
//
//   KARRYAM_ADMIN_MIGRATION_DATABASE_URL=... [KARRYAM_ADMIN_RUNTIME_ROLE=karryam_admin_runtime] npm run migrate
//
// - Uses ONLY the migration credential; the server never reads it.
// - Each file runs in its own transaction under a session advisory lock.
// - Applied files are checksummed; a changed applied file stops the run.
// - Never creates roles or passwords. If KARRYAM_ADMIN_RUNTIME_ROLE is set,
//   grants that existing role least-privilege DML (no UPDATE/DELETE on the
//   audit table, no DDL).
// Rollback: restore the pre-migration backup (see README); there are no
// down-migrations.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Client } = require("pg");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const LOCK_KEY = 728_411_003; // stable advisory lock id for karryam_admin migrations
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const FILE = /^[0-9]{3}_[a-z0-9_]+\.sql$/;

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => FILE.test(f)).sort().map((file) => {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    return { version: file.replace(/\.sql$/, ""), file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

// Least privilege: append-only tables get SELECT/INSERT only; tables with
// guarded state transitions get UPDATE (the triggers enforce the allowed
// changes); nothing gets DDL, TRUNCATE or DELETE except replay nonces.
const RUNTIME_GRANTS = (role) => [
  `GRANT USAGE ON SCHEMA karryam_admin TO ${role}`,
  `GRANT SELECT, INSERT ON karryam_admin.integration_audit TO ${role}`,
  `GRANT SELECT, INSERT, DELETE ON karryam_admin.request_nonces TO ${role}`,
  ...["operation_requests", "approval_references", "bridge_feed_partitions", "bridge_event_inbox", "entity_projections",
    "entity_version_gaps", "event_quarantine", "source_coverage", "sync_runs", "metric_snapshots", "hq_outbox_heads", "hq_outbox_acks"]
    .map((t) => `GRANT SELECT, INSERT, UPDATE ON karryam_admin.${t} TO ${role}`),
  ...["sensitive_access_log", "projection_lineage", "hq_outbox", "bridge_contract_revisions"].map((t) => `GRANT SELECT, INSERT ON karryam_admin.${t} TO ${role}`),
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA karryam_admin TO ${role}`,
  `REVOKE CREATE ON SCHEMA karryam_admin FROM ${role}`,
];

async function migrate({ connectionString, runtimeRole = null, dir = MIGRATIONS_DIR, log = () => {} }) {
  if (!connectionString) throw new Error("KARRYAM_ADMIN_MIGRATION_DATABASE_URL_REQUIRED");
  if (runtimeRole !== null && !ROLE.test(runtimeRole)) throw new Error("KARRYAM_ADMIN_RUNTIME_ROLE_INVALID");
  const migrations = listMigrations(dir);
  const client = new Client({ connectionString, application_name: "karryam-admin-migrate" });
  await client.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("CREATE SCHEMA IF NOT EXISTS karryam_admin");
    await client.query("CREATE TABLE IF NOT EXISTS karryam_admin.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const existing = new Map((await client.query("SELECT version, checksum FROM karryam_admin.schema_migrations")).rows.map((r) => [r.version, r.checksum]));
    for (const known of existing.keys()) {
      if (!migrations.some((m) => m.version === known)) throw new Error("APPLIED_MIGRATION_MISSING:" + known);
    }
    for (const m of migrations) {
      if (existing.has(m.version)) {
        if (existing.get(m.version) !== m.checksum) throw new Error("APPLIED_MIGRATION_CHANGED:" + m.version);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO karryam_admin.schema_migrations(version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error("MIGRATION_FAILED:" + m.version + ":" + (err.code || "ERROR"));
      }
      applied.push(m.version);
      log({ event: "migration_applied", version: m.version });
    }
    if (runtimeRole) {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtimeRole]);
      if (exists.rowCount !== 1) throw new Error("KARRYAM_ADMIN_RUNTIME_ROLE_NOT_FOUND");
      for (const statement of RUNTIME_GRANTS(runtimeRole)) await client.query(statement);
      await client.query(`GRANT SELECT ON karryam_admin.schema_migrations TO ${runtimeRole}`);
      log({ event: "runtime_grants_applied" });
    }
    return { applied, total: migrations.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  const log = (entry) => process.stdout.write(JSON.stringify({ service: "karryam-admin-migrate", ...entry }) + "\n");
  migrate({ connectionString: process.env.KARRYAM_ADMIN_MIGRATION_DATABASE_URL, runtimeRole: process.env.KARRYAM_ADMIN_RUNTIME_ROLE || null, log })
    .then((r) => log({ event: "done", applied: r.applied.length, total: r.total }))
    .catch((err) => { log({ event: "failed", reason: err.message }); process.exit(1); });
}

module.exports = { migrate, listMigrations, RUNTIME_GRANTS };
