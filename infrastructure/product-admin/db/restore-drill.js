"use strict";

// Disposable backup / restore certification drill (Section 9.5.4).
//
// Never point this at staging or production: it creates and drops its own
// uniquely named databases on the server given by `adminUrl` (a superuser
// connection on a throwaway cluster: CI service container or a local
// scratch cluster). It proves restorability, not just that pg_dump exited:
//
//   1. source database at the OLD release (first `oldCount` migrations);
//   2. representative synthetic data (seed callback);
//   3. pre-migration backup with pg_dump (custom format), archive listed
//      with pg_restore --list and checksummed;
//   4. NEW migrations applied to the source; invariants verified;
//   5. backup restored into a FRESH database; schema fingerprint, ledger and
//      row counts must equal the source as it was before the migration;
//   6. NEW migrations re-applied to the restored copy; its schema must equal
//      the migrated source; invariants verified again;
//   7. a further run applies nothing (idempotent);
//   8. an evidence report (JSON) is returned and optionally written.
//
// Callers pass the `pg` Client class and their own migrate/seed/verify
// functions, so the drill has no dependencies of its own.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");

function pgTool(name, pgBin = process.env.PG_BIN) {
  const exe = process.platform === "win32" ? name + ".exe" : name;
  const candidates = [pgBin && path.join(pgBin, exe), exe].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ["--version"], { stdio: "pipe" }); return c; } catch { /* try next */ }
  }
  return null;
}

function withDb(base, db, user, password) {
  const u = new URL(base);
  u.pathname = "/" + db;
  if (user) { u.username = user; u.password = password || ""; }
  return u.toString();
}

// Deterministic description of every object in one schema.
async function schemaFingerprint(client, schema) {
  const parts = {};
  parts.columns = (await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default, is_generated, generation_expression FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1, 2`, [schema])).rows;
  parts.constraints = (await client.query(
    `SELECT c.conrelid::regclass::text AS rel, c.conname, pg_get_constraintdef(c.oid) AS def, c.convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 ORDER BY 1, 2`, [schema])).rows;
  // A restored CHECK over an AND chain can come back with different (but
  // equivalent) nesting parentheses; compare CHECK bodies without them.
  for (const c of parts.constraints) if (c.def.startsWith("CHECK ")) c.def = c.def.replace(/[()]/g, "").replace(/\s+/g, " ");
  parts.indexes = (await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`, [schema])).rows;
  parts.triggers = (await client.query(
    `SELECT t.tgrelid::regclass::text AS rel, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1, 2`, [schema])).rows;
  parts.functions = (await client.query(
    `SELECT p.proname, md5(pg_get_functiondef(p.oid)) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY 1`, [schema])).rows;
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return { digest, parts, objects: { columns: parts.columns.length, constraints: parts.constraints.length, indexes: parts.indexes.length, triggers: parts.triggers.length, functions: parts.functions.length } };
}

// Entries present in one fingerprint but not the other (for evidence).
function fingerprintDiff(a, b) {
  const out = {};
  for (const k of Object.keys(a.parts)) {
    const as = new Set(a.parts[k].map((x) => JSON.stringify(x)));
    const bs = new Set(b.parts[k].map((x) => JSON.stringify(x)));
    const only = (x, y) => [...x].filter((v) => !y.has(v)).slice(0, 5);
    const left = only(as, bs);
    const right = only(bs, as);
    if (left.length || right.length) out[k] = { expected_only: left, actual_only: right };
  }
  return out;
}

async function rowCounts(client, schema) {
  const { rows } = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`, [schema]);
  const out = {};
  for (const r of rows) out[r.relname] = Number((await client.query(`SELECT count(*) AS n FROM ${schema}.${r.relname}`)).rows[0].n);
  return out;
}

/**
 * opts: { Client, adminUrl, schema, ledger, prefix, migrateTo(url, { runtimeRole, upTo }) -> applied[],
 *         seed(client), verify(client, phase) -> object, pgBin?, reportPath? }
 */
async function runRestoreDrill(opts) {
  const { Client, adminUrl, schema, ledger, prefix, migrateTo, seed, verify, oldCount } = opts;
  const pgDump = pgTool("pg_dump", opts.pgBin);
  const pgRestore = pgTool("pg_restore", opts.pgBin);
  if (!pgDump || !pgRestore) return { status: "TOOLS_UNAVAILABLE" };
  const suffix = randomBytes(4).toString("hex");
  const password = randomBytes(12).toString("hex");
  const names = { source: `${prefix}_src_${suffix}`, target: `${prefix}_rst_${suffix}`, migrator: `${prefix}_dmig_${suffix}`, runtime: `${prefix}_drt_${suffix}` };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-drill-"));
  const dumpFile = path.join(work, "pre-migration.dump");
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const clients = [];
  const open = async (db) => { const c = new Client({ connectionString: withDb(adminUrl, db, names.migrator, password) }); await c.connect(); clients.push(c); return c; };
  const report = { drill: "disposable-backup-restore", schema, started_at: new Date().toISOString(), server_version: null, tools: { pg_dump: execFileSync(pgDump, ["--version"]).toString().trim(), pg_restore: execFileSync(pgRestore, ["--version"]).toString().trim() }, steps: [] };
  const step = (name, detail) => report.steps.push({ step: name, ...detail });
  try {
    report.server_version = (await admin.query("SHOW server_version")).rows[0].server_version;
    await admin.query(`CREATE ROLE ${names.migrator} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${names.runtime} LOGIN PASSWORD '${password}'`);
    for (const db of [names.source, names.target]) {
      await admin.query(`CREATE DATABASE ${db} OWNER ${names.migrator}`);
      await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${names.runtime}`);
    }
    const sourceUrl = withDb(adminUrl, names.source, names.migrator, password);
    const targetUrl = withDb(adminUrl, names.target, names.migrator, password);

    // 1-2. Old release with representative data.
    const oldApplied = await migrateTo(sourceUrl, { runtimeRole: names.runtime, upTo: oldCount });
    const src = await open(names.source);
    await seed(src);
    const beforeFingerprint = await schemaFingerprint(src, schema);
    const beforeCounts = await rowCounts(src, schema);
    const beforeLedger = (await src.query(`SELECT version, checksum FROM ${ledger} ORDER BY version`)).rows;
    step("old_release_seeded", { applied: oldApplied, schema_digest: beforeFingerprint.digest, objects: beforeFingerprint.objects, rows: beforeCounts });

    // 3. Pre-migration backup, verified as a readable archive.
    execFileSync(pgDump, ["--format=custom", "--schema=" + schema, "--no-owner", "--no-privileges", "--file", dumpFile, sourceUrl], { stdio: "pipe" });
    const listing = execFileSync(pgRestore, ["--list", dumpFile]).toString();
    const archive = { bytes: fs.statSync(dumpFile).size, sha256: createHash("sha256").update(fs.readFileSync(dumpFile)).digest("hex"), toc_entries: listing.split("\n").filter((l) => /^\d+;/.test(l)).length };
    if (archive.toc_entries === 0) throw new Error("BACKUP_ARCHIVE_EMPTY");
    step("pre_migration_backup", archive);

    // 4. Forward migration on the source.
    const newApplied = await migrateTo(sourceUrl, { runtimeRole: names.runtime });
    const migratedFingerprint = await schemaFingerprint(src, schema);
    const migratedCounts = await rowCounts(src, schema);
    const sourceChecks = await verify(src, "migrated_source");
    step("forward_migration", { applied: newApplied, schema_digest: migratedFingerprint.digest, objects: migratedFingerprint.objects, checks: sourceChecks });
    for (const [table, n] of Object.entries(beforeCounts)) {
      if (table === ledger.split(".")[1]) continue;
      if (migratedCounts[table] < n) throw new Error("ROWS_LOST_BY_MIGRATION:" + table);
    }

    // 5. Restore the pre-migration backup into a fresh database.
    execFileSync(pgRestore, ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", "--dbname", targetUrl, dumpFile], { stdio: "pipe" });
    const tgt = await open(names.target);
    const restoredFingerprint = await schemaFingerprint(tgt, schema);
    const restoredCounts = await rowCounts(tgt, schema);
    const restoredLedger = (await tgt.query(`SELECT version, checksum FROM ${ledger} ORDER BY version`)).rows;
    const restoreEquivalent = restoredFingerprint.digest === beforeFingerprint.digest && JSON.stringify(restoredCounts) === JSON.stringify(beforeCounts) && JSON.stringify(restoredLedger) === JSON.stringify(beforeLedger);
    step("restore_into_fresh_database", { schema_digest: restoredFingerprint.digest, schema_equal: restoredFingerprint.digest === beforeFingerprint.digest, rows_equal: JSON.stringify(restoredCounts) === JSON.stringify(beforeCounts), ledger_equal: JSON.stringify(restoredLedger) === JSON.stringify(beforeLedger), schema_diff: fingerprintDiff(beforeFingerprint, restoredFingerprint), checks: await verify(tgt, "restored") });
    if (!restoreEquivalent) throw new Error("RESTORE_NOT_EQUIVALENT");

    // 6. Re-apply the forward migrations to the restored copy.
    const reapplied = await migrateTo(targetUrl, { runtimeRole: names.runtime });
    const reFingerprint = await schemaFingerprint(tgt, schema);
    const restoredChecks = await verify(tgt, "restored_migrated");
    step("rerun_migrations_on_restore", { applied: reapplied, schema_digest: reFingerprint.digest, schema_equal_to_migrated_source: reFingerprint.digest === migratedFingerprint.digest, checks: restoredChecks });
    if (reFingerprint.digest !== migratedFingerprint.digest) throw new Error("RESTORED_SCHEMA_DIVERGES_AFTER_MIGRATION");

    // 7. Idempotent.
    const again = await migrateTo(targetUrl, { runtimeRole: names.runtime });
    step("idempotent_rerun", { applied: again });
    if (again.length !== 0) throw new Error("RERUN_NOT_IDEMPOTENT");

    report.status = "PASSED";
  } catch (err) {
    report.status = "FAILED";
    report.error = String(err && err.message ? err.message : err).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-url]").slice(0, 300);
  } finally {
    report.finished_at = new Date().toISOString();
    for (const c of clients) await c.end().catch(() => {});
    for (const db of [names.source, names.target]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    for (const r of [names.runtime, names.migrator]) await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    await admin.end().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (opts.reportPath) {
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

module.exports = { runRestoreDrill, schemaFingerprint, pgTool };
