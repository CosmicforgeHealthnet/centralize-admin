"use strict";

// Forward-only migration runner for the HQ integration schema.
//  - each file runs in its own transaction under an advisory lock, in
//    file-name order;
//  - applied files are recorded with their SHA-256 and a changed or missing
//    file is refused (corrections must be new migrations); the ledger is
//    append-only (003);
//  - runtime grants are applied atomically to an operator-provisioned role
//    that must not be privileged (superuser, CREATEROLE, CREATEDB, BYPASSRLS,
//    schema owner, the migration role itself). It ends with exactly the
//    documented privileges: no DDL, no DELETE (except expired replay nonces)
//    and no UPDATE on append-only tables.
// Runs only with the migration credential, never the runtime credential.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");

const MS = C.migrationSafety;
const SCHEMA = "hq_integration";
const LEDGER_TABLE = "hq_product_admin_schema_migrations";
const LEDGER = SCHEMA + "." + LEDGER_TABLE;
const LOCK_KEY = 7340117001; // stable advisory lock id for this schema
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

const GRANT_SETS = Object.freeze([
  { privileges: "SELECT, INSERT, UPDATE", tables: ["hq_product_admins", "hq_product_admin_contracts", "hq_product_admin_grants", "hq_product_admin_datasets", "hq_product_admin_subscriptions",
    "hq_product_admin_sync_cursors", "hq_product_admin_metrics", "hq_product_admin_sync_runs", "hq_product_admin_quarantine", "hq_product_admin_event_inbox", "hq_product_admin_legal_holds"] },
  { privileges: "SELECT, INSERT", tables: ["hq_product_admin_lineage", "hq_product_admin_onboarding_approvals", "hq_product_admin_security_audit"] },
  { privileges: "SELECT, INSERT, DELETE", tables: ["hq_product_admin_replay_nonces"] },
  { privileges: "SELECT", tables: [LEDGER_TABLE] },
]);

// Before 003 the inbox was strictly append-only (no UPDATE grant).
const PRE_003_INSERT_ONLY = new Set(["hq_product_admin_event_inbox"]);

function expectedRuntimePrivileges(existing, { inboxUpdatable = true } = {}) {
  const out = {};
  for (const set of GRANT_SETS) {
    for (const t of set.tables) {
      if (existing && !existing.has(t)) continue;
      const privileges = !inboxUpdatable && PRE_003_INSERT_ONLY.has(t) ? ["INSERT", "SELECT"] : set.privileges.split(", ").sort();
      out[t] = privileges;
    }
  }
  return out;
}

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort().map((file) => {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    return { version: file.replace(/\.sql$/, ""), file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

async function existingTables(client) {
  const { rows } = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [SCHEMA]);
  return new Set(rows.map((r) => r.relname));
}

async function applyRuntimeGrants(client, role) {
  const problems = await MS.runtimeRoleProblems(client, role, { schema: SCHEMA });
  if (problems.length) throw new Error("runtime_role_rejected:" + problems[0]);
  const tables = await existingTables(client);
  const guarded = (await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'hq_product_admin_event_inbox_guard'`)).rowCount === 1;
  const quoted = `"${role}"`;
  await client.query("BEGIN");
  try {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${quoted}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM ${quoted}`);
    await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM ${quoted}`);
    await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${quoted}`);
    for (const set of GRANT_SETS) {
      for (const t of set.tables.filter((x) => tables.has(x))) {
        // The inbox becomes updatable only once its payload-clearing guard exists.
        const privileges = !guarded && PRE_003_INSERT_ONLY.has(t) ? "SELECT, INSERT" : set.privileges;
        await client.query(`GRANT ${privileges} ON ${SCHEMA}.${t} TO ${quoted}`);
      }
    }
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${quoted}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function migrate(client, { runtimeRole = null, dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  if (runtimeRole !== null && !ROLE.test(runtimeRole)) throw new Error("runtime_role_invalid");
  const migrations = listMigrations(dir);
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    if (runtimeRole) {
      const { rows: [me] } = await client.query("SELECT current_user AS u");
      if (me.u === runtimeRole) throw new Error("runtime_role_rejected:RUNTIME_ROLE_IS_MIGRATION_ROLE");
    }
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
      log({ event: "migration_applied", version: m.version, checksum: m.checksum });
      results.push({ version: m.version, status: "APPLIED" });
    }
    if (runtimeRole) {
      await applyRuntimeGrants(client, runtimeRole);
      log({ event: "runtime_grants_applied", role: runtimeRole });
    }
    return results;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

/** Read-only preflight in a READ ONLY transaction that is rolled back. */
async function preview(client, { runtimeRole = null, dir = MIGRATIONS_DIR } = {}) {
  const migrations = listMigrations(dir);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const { rows: [server] } = await client.query("SELECT current_setting('server_version_num')::int AS version, current_user AS role");
    const ledgerExists = (await client.query("SELECT to_regclass($1) AS t", [LEDGER])).rows[0].t !== null;
    const recorded = ledgerExists ? (await client.query(`SELECT version, checksum, applied_at FROM ${LEDGER} ORDER BY version`)).rows : [];
    const byVersion = new Map(recorded.map((r) => [r.version, r]));
    const errors = [];
    const warnings = [];
    for (const r of recorded) if (!migrations.some((m) => m.version === r.version)) errors.push("APPLIED_MIGRATION_MISSING:" + r.version);
    const changed = migrations.filter((m) => byVersion.has(m.version) && byVersion.get(m.version).checksum !== m.checksum).map((m) => m.version);
    for (const v of changed) errors.push("APPLIED_MIGRATION_CHANGED:" + v);
    const pending = migrations.filter((m) => !byVersion.has(m.version)).map((m) => ({ version: m.version, checksum: m.checksum, ...MS.summarize(MS.analyzeSql(m.sql)) }));
    for (const p of pending) for (const b of p.blocking) errors.push("BLOCKING_STATEMENT:" + p.version + ":" + b.kind);
    const estimates = {};
    for (const t of [...new Set(pending.flatMap((p) => p.locked_tables))]) {
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
        errors.push(...problems);
        runtime = { role: runtimeRole, problems, current_privileges: problems.includes("RUNTIME_ROLE_NOT_FOUND") ? null : await MS.tablePrivileges(client, runtimeRole, SCHEMA), privileges_after_run: expectedRuntimePrivileges(null) };
      }
    }
    return {
      schema: SCHEMA, server_version_num: server.version, migration_role: server.role,
      applied: recorded.map((r) => ({ version: r.version, checksum: r.checksum, applied_at: r.applied_at.toISOString() })),
      pending, changed, row_estimates: estimates, required_extensions: [], runtime,
      backup_required: pending.length > 0,
      requirements: pending.length ? ["PRE_MIGRATION_BACKUP_VERIFIED_RESTORABLE", "RUN_WITH_MIGRATION_CREDENTIAL_ONLY", "APPLICATION_IMAGE_COMPATIBLE_WITH_BOTH_SCHEMAS"] : [],
      errors, warnings, ok: errors.length === 0,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

module.exports = { migrate, preview, listMigrations, expectedRuntimePrivileges, SCHEMA, LEDGER, GRANT_SETS, LOCK_KEY };
