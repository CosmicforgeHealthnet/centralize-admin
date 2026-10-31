"use strict";

// Forward-only migration runner for the dedicated Karryam Admin database.
//
//   KARRYAM_ADMIN_MIGRATION_DATABASE_URL=... [KARRYAM_ADMIN_RUNTIME_ROLE=karryam_admin_runtime] npm run migrate
//   ... npm run migrate -- --preview      (read-only preflight; changes nothing)
//
// - Uses ONLY the migration credential; the server never reads it, and the
//   runner refuses to run when the runtime credential is the same.
// - Each file runs in its own transaction under a session advisory lock, in
//   file-name order. Applied files are checksummed (SHA-256); a changed or
//   missing applied file stops the run. The ledger is append-only (003).
// - Never creates roles or passwords. If KARRYAM_ADMIN_RUNTIME_ROLE is set,
//   that existing role must not be privileged (superuser, CREATEROLE,
//   CREATEDB, BYPASSRLS, schema owner, the migration role itself) and gets
//   exactly the least-privilege grants below, applied atomically.
// Rollback: restore the pre-migration backup (see docs/product-admin/
// migration-runbook.md); there are no down-migrations.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Client } = require("pg");
const { contracts } = require("../src/packages");

const MS = contracts.migrationSafety;
const SCHEMA = "karryam_admin";
const LEDGER = SCHEMA + ".schema_migrations";
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

// Least privilege. Append-only tables get SELECT/INSERT; tables whose
// changes are guarded by triggers get UPDATE; reference tables are
// read-only. Nothing gets DDL, TRUNCATE or DELETE except replay nonces
// (expired rows only, enforced by trigger).
const GRANT_SETS = Object.freeze([
  { privileges: "SELECT, INSERT", tables: ["integration_audit", "sensitive_access_log", "projection_lineage", "hq_outbox", "bridge_contract_revisions", "capability_snapshots"] },
  { privileges: "SELECT, INSERT, DELETE", tables: ["request_nonces"] },
  { privileges: "SELECT, INSERT, UPDATE", tables: ["operation_requests", "approval_references", "bridge_feed_partitions", "bridge_event_inbox", "entity_projections",
    "entity_version_gaps", "event_quarantine", "source_coverage", "sync_runs", "metric_snapshots", "hq_outbox_heads", "hq_outbox_acks", "legal_holds"] },
  { privileges: "SELECT", tables: ["schema_migrations", "retention_policies", "high_risk_certifications"] },
]);

/** Exact privileges the runtime role holds after grants: { table: [PRIV...] }. */
function expectedRuntimePrivileges(existing) {
  const out = {};
  for (const set of GRANT_SETS) {
    for (const t of set.tables) if (!existing || existing.has(t)) out[t] = set.privileges.split(", ").sort();
  }
  return out;
}

async function existingTables(client) {
  const { rows } = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [SCHEMA]);
  return new Set(rows.map((r) => r.relname));
}

async function applyRuntimeGrants(client, role) {
  const problems = await MS.runtimeRoleProblems(client, role, { schema: SCHEMA });
  if (problems.length) throw new Error("KARRYAM_ADMIN_" + problems[0]);
  const tables = await existingTables(client);
  await client.query("BEGIN");
  try {
    // Revoke first so the role ends with exactly the documented set.
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`);
    for (const set of GRANT_SETS) {
      const present = set.tables.filter((t) => tables.has(t));
      if (present.length) await client.query(`GRANT ${set.privileges} ON ${present.map((t) => SCHEMA + "." + t).join(", ")} TO ${role}`);
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${role}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function migrate({ connectionString, runtimeRole = null, runtimeConnectionString = null, dir = MIGRATIONS_DIR, log = () => {} }) {
  if (!connectionString) throw new Error("KARRYAM_ADMIN_MIGRATION_DATABASE_URL_REQUIRED");
  if (runtimeConnectionString && runtimeConnectionString === connectionString) throw new Error("RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER");
  if (runtimeRole !== null && !ROLE.test(runtimeRole)) throw new Error("KARRYAM_ADMIN_RUNTIME_ROLE_INVALID");
  const migrations = listMigrations(dir);
  const client = new Client({ connectionString, application_name: "karryam-admin-migrate" });
  await client.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    if (runtimeRole) {
      const { rows: [me] } = await client.query("SELECT current_user AS u");
      if (me.u === runtimeRole) throw new Error("KARRYAM_ADMIN_RUNTIME_ROLE_IS_MIGRATION_ROLE");
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const existing = new Map((await client.query(`SELECT version, checksum FROM ${LEDGER}`)).rows.map((r) => [r.version, r.checksum]));
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
        await client.query(`INSERT INTO ${LEDGER}(version, checksum) VALUES ($1, $2)`, [m.version, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error("MIGRATION_FAILED:" + m.version + ":" + (err.code || "ERROR"));
      }
      applied.push(m.version);
      log({ event: "migration_applied", version: m.version, checksum: m.checksum });
    }
    if (runtimeRole) {
      await applyRuntimeGrants(client, runtimeRole);
      log({ event: "runtime_grants_applied" });
    }
    return { applied, total: migrations.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * Read-only preflight: what a run would do, without changing anything. The
 * whole inspection runs in a READ ONLY transaction that is rolled back.
 */
async function preview({ connectionString, runtimeRole = null, dir = MIGRATIONS_DIR }) {
  if (!connectionString) throw new Error("KARRYAM_ADMIN_MIGRATION_DATABASE_URL_REQUIRED");
  const migrations = listMigrations(dir);
  const client = new Client({ connectionString, application_name: "karryam-admin-migrate-preview" });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [server] } = await client.query("SELECT current_setting('server_version_num')::int AS version, current_user AS role");
    const ledgerExists = (await client.query("SELECT to_regclass($1) AS t", [LEDGER])).rows[0].t !== null;
    const recorded = ledgerExists ? (await client.query(`SELECT version, checksum, applied_at FROM ${LEDGER} ORDER BY version`)).rows : [];
    const byVersion = new Map(recorded.map((r) => [r.version, r]));
    const errors = [];
    const warnings = [];
    for (const r of recorded) if (!migrations.some((m) => m.version === r.version)) errors.push("APPLIED_MIGRATION_MISSING:" + r.version);
    const changed = migrations.filter((m) => byVersion.has(m.version) && byVersion.get(m.version).checksum !== m.checksum).map((m) => m.version);
    for (const v of changed) errors.push("APPLIED_MIGRATION_CHANGED:" + v);
    const pending = migrations.filter((m) => !byVersion.has(m.version));
    const analysis = pending.map((m) => ({ version: m.version, checksum: m.checksum, ...MS.summarize(MS.analyzeSql(m.sql)) }));
    for (const a of analysis) for (const b of a.blocking) errors.push("BLOCKING_STATEMENT:" + a.version + ":" + b.kind);
    // Row estimates for tables a pending migration locks or rewrites.
    const touched = [...new Set(analysis.flatMap((a) => a.locked_tables))];
    const estimates = {};
    for (const t of touched) {
      const { rows: [r] } = await client.query("SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE (SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass($1)) END AS n", [t]);
      estimates[t] = r.n === null ? "NEW" : Math.max(0, Number(r.n));
    }
    const me = await MS.roleAttributes(client, server.role);
    if (me && me.rolsuper) warnings.push("MIGRATION_ROLE_IS_SUPERUSER_NOT_REQUIRED");
    let runtime = null;
    if (runtimeRole) {
      if (!ROLE.test(runtimeRole)) errors.push("RUNTIME_ROLE_INVALID");
      else {
        const problems = await MS.runtimeRoleProblems(client, runtimeRole, { schema: SCHEMA });
        for (const p of problems) errors.push(p);
        runtime = { role: runtimeRole, problems, current_privileges: problems.includes("RUNTIME_ROLE_NOT_FOUND") ? null : await MS.tablePrivileges(client, runtimeRole, SCHEMA), privileges_after_run: expectedRuntimePrivileges(null) };
      }
    }
    const { rows: ext } = await client.query("SELECT extname FROM pg_extension ORDER BY 1");
    await client.query("ROLLBACK");
    return {
      schema: SCHEMA, server_version_num: server.version, migration_role: server.role,
      applied: recorded.map((r) => ({ version: r.version, checksum: r.checksum, applied_at: r.applied_at.toISOString() })),
      pending: analysis, changed, row_estimates: estimates,
      required_extensions: [], installed_extensions: ext.map((e) => e.extname),
      runtime,
      backup_required: pending.length > 0,
      requirements: pending.length ? ["PRE_MIGRATION_BACKUP_VERIFIED_RESTORABLE", "RUN_WITH_MIGRATION_CREDENTIAL_ONLY", "APPLICATION_IMAGE_COMPATIBLE_WITH_BOTH_SCHEMAS"] : [],
      errors, warnings, ok: errors.length === 0,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  const log = (entry) => process.stdout.write(JSON.stringify({ service: "karryam-admin-migrate", ...entry }) + "\n");
  const url = process.env.KARRYAM_ADMIN_MIGRATION_DATABASE_URL;
  const role = process.env.KARRYAM_ADMIN_RUNTIME_ROLE || null;
  const run = process.argv.includes("--preview")
    ? preview({ connectionString: url, runtimeRole: role }).then((r) => { log({ event: "preview", ...r }); if (!r.ok) process.exitCode = 2; })
    : migrate({ connectionString: url, runtimeRole: role, runtimeConnectionString: process.env.KARRYAM_ADMIN_DATABASE_URL || null, log })
      .then((r) => log({ event: "done", applied: r.applied.length, total: r.total }));
  run.catch((err) => { log({ event: "failed", reason: MS.redactUrl(err.message) }); process.exit(1); });
}

module.exports = { migrate, preview, listMigrations, GRANT_SETS, expectedRuntimePrivileges, LOCK_KEY };
