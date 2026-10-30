"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const db = require("./helpers/db");
const { migrate, listMigrations } = require("../src/db/migrate");

const skip = !db.available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";

const TABLES = [
  "hq_product_admins", "hq_product_admin_contracts", "hq_product_admin_grants", "hq_product_admin_datasets",
  "hq_product_admin_subscriptions", "hq_product_admin_event_inbox", "hq_product_admin_sync_cursors",
  "hq_product_admin_metrics", "hq_product_admin_lineage", "hq_product_admin_sync_runs",
  "hq_product_admin_quarantine", "hq_product_admin_onboarding_approvals", "hq_product_admin_security_audit",
];

async function expectDenied(promise, pattern) {
  await assert.rejects(promise, (err) => (pattern ? pattern.test(err.message) : true));
}

test("fresh migration creates the isolated registry schema and is idempotent", { skip }, async () => {
  const ctx = await db.createDisposableDatabase();
  try {
    const { rows } = await ctx.migClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'hq_integration' ORDER BY 1");
    const names = rows.map((r) => r.table_name);
    for (const table of TABLES) assert.ok(names.includes(table), table);
    const again = await migrate(ctx.migClient, { runtimeRole: ctx.runtimeRole });
    assert.ok(again.every((r) => r.status === "ALREADY_APPLIED"));
    // Nothing outside the dedicated schema was created.
    const pub = await ctx.migClient.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    assert.equal(pub.rows[0].n, 0);
    const legacy = await ctx.migClient.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'admin_ops_service_registry'");
    assert.equal(legacy.rows[0].n, 0);
  } finally { await ctx.drop(); }
});

test("a modified applied migration is refused", { skip }, async () => {
  const ctx = await db.createDisposableDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-mig-"));
  try {
    for (const m of listMigrations()) fs.writeFileSync(path.join(dir, m.file), m.sql + "\n-- tampered\n");
    await assert.rejects(migrate(ctx.migClient, { dir }), /migration_checksum_mismatch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await ctx.drop(); }
});

test("runtime role has DML only: no DDL, no deletes, append-only audit", { skip }, async () => {
  const ctx = await db.createDisposableDatabase();
  try {
    const rt = ctx.pool;
    await expectDenied(rt.query("CREATE TABLE hq_integration.rogue (id int)"), /permission denied/);
    await expectDenied(rt.query("CREATE TABLE public.rogue (id int)"), /permission denied/);
    await rt.query("INSERT INTO hq_integration.hq_product_admin_security_audit (actor_type, actor_id, action, outcome) VALUES ('SYSTEM','test','x','RECORDED')");
    await expectDenied(rt.query("UPDATE hq_integration.hq_product_admin_security_audit SET action = 'y'"));
    await expectDenied(rt.query("DELETE FROM hq_integration.hq_product_admin_security_audit"));
    await expectDenied(rt.query("TRUNCATE hq_integration.hq_product_admin_security_audit"));
    // Even the owner cannot rewrite audit history: triggers enforce append-only.
    await expectDenied(ctx.migClient.query("UPDATE hq_integration.hq_product_admin_security_audit SET action = 'y'"), /append-only/);
    await expectDenied(ctx.migClient.query("TRUNCATE hq_integration.hq_product_admin_security_audit"), /append-only/);
    await expectDenied(rt.query("DELETE FROM hq_integration.hq_product_admins"));
    await expectDenied(rt.query("DROP TABLE hq_integration.hq_product_admins"));
  } finally { await ctx.drop(); }
});

test("registry constraints: uniqueness, immutability, terminal revocation, restricted data", { skip }, async () => {
  const ctx = await db.createDisposableDatabase();
  const q = (sql, params) => ctx.pool.query(sql, params);
  try {
    const insert = (id, product, instance, status = "REQUESTED") => q(
      `INSERT INTO hq_integration.hq_product_admins (id, product_id, display_name, service_instance_id, environment, endpoint_ref, workload_identity, approved_signer_kid, lifecycle_status, requested_by)
       VALUES ($1,$2,'Product',$3,'test','ep-1','cf://test/product-admin/x','kid-1',$4,'staff-a')`, [id, product, instance, status]);
    const a = randomUUID();
    await insert(a, "synthetic-third", "synthetic-third-1");
    await expectDenied(insert(randomUUID(), "synthetic-third", "synthetic-third-2"), /hq_product_admins_live_product_uq/);
    await expectDenied(insert(randomUUID(), "other-product", "synthetic-third-1"), /service_instance_uq/);
    await expectDenied(q("UPDATE hq_integration.hq_product_admins SET endpoint_ref = 'ep-evil' WHERE id = $1", [a]), /immutable/);
    await expectDenied(q("UPDATE hq_integration.hq_product_admins SET approved_signer_kid = 'kid-evil' WHERE id = $1", [a]), /immutable/);
    await expectDenied(q("UPDATE hq_integration.hq_product_admins SET lifecycle_status = 'IDENTITY_VERIFIED' WHERE id = $1", [a]), /revision/);
    await expectDenied(q("UPDATE hq_integration.hq_product_admins SET lifecycle_status = 'ENABLED', revision = revision + 1 WHERE id = $1", [a]), /enabled_requirements/);
    await q("UPDATE hq_integration.hq_product_admins SET lifecycle_status = 'REVOKED', revision = revision + 1, revoked_at = now(), revoked_by = 'staff-b', revocation_reason = 'TEST' WHERE id = $1", [a]);
    await expectDenied(q("UPDATE hq_integration.hq_product_admins SET lifecycle_status = 'REQUESTED', revision = revision + 1 WHERE id = $1", [a]), /terminal/);
    // A new registration for the same product is allowed only as a new record.
    await insert(randomUUID(), "synthetic-third", "synthetic-third-3");

    // Grants: no wildcards, no self-grants, one-time revocation.
    const grant = (scope, staff = "staff-x", by = "staff-y") => q(
      `INSERT INTO hq_integration.hq_product_admin_grants (id, grant_kind, product_id, staff_id, effect, actions, scope, granted_by) VALUES ($1,'PRODUCT','synthetic-third',$2,'ALLOW',ARRAY['product.view'],$3,$4)`,
      [randomUUID(), staff, JSON.stringify(scope), by]);
    await expectDenied(grant({ market: ["*"] }), /check/i);
    await expectDenied(grant({ market: ["NG"] }, "staff-x", "staff-x"), /no_self_grant/);
    await grant({ market: ["NG"], organization: ["cf"] });
  } finally { await ctx.drop(); }
});

test("backup and restore of the registry schema preserves data, ledger and append-only guards", { skip }, async (t) => {
  const { execFileSync } = require("node:child_process");
  const { Client } = require("pg");
  let version;
  try { version = execFileSync("pg_dump", ["--version"]).toString(); } catch { t.skip("pg_dump not installed"); return; }
  const source = await db.createDisposableDatabase();
  const target = await db.createDisposableDatabase({ migrateNow: false });
  const dumpFile = path.join(os.tmpdir(), "pic-restore-" + process.pid + ".dump");
  try {
    const id = randomUUID();
    await source.pool.query(`INSERT INTO hq_integration.hq_product_admins (id, product_id, display_name, service_instance_id, environment, endpoint_ref, workload_identity, approved_signer_kid, lifecycle_status, requested_by) VALUES ($1,'restore-check','Restore','restore-check-1','test','ep-1','cf://test/product-admin/restore-check','kid-1','REQUESTED','staff-a')`, [id]);
    await source.pool.query("INSERT INTO hq_integration.hq_product_admin_security_audit (actor_type, actor_id, action, outcome) VALUES ('SYSTEM','restore','backup.check','RECORDED')");
    try {
      execFileSync("pg_dump", ["--format=custom", "--schema=hq_integration", "--no-owner", "--no-privileges", "--file", dumpFile, source.migrationUrl], { stdio: "pipe" });
    } catch (err) {
      t.skip("pg_dump incompatible with server (" + version.trim() + "): " + String(err.stderr).slice(0, 120));
      return;
    }
    execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", target.migrationUrl, dumpFile], { stdio: "pipe" });
    // The ledger came back, so the runner sees the schema as current and only re-applies grants.
    const results = await migrate(target.migClient, { runtimeRole: target.runtimeRole });
    assert.ok(results.every((r) => r.status === "ALREADY_APPLIED"));
    const restored = await target.pool.query("SELECT product_id, lifecycle_status FROM hq_integration.hq_product_admins WHERE id = $1", [id]);
    assert.deepEqual(restored.rows[0], { product_id: "restore-check", lifecycle_status: "REQUESTED" });
    await expectDenied(target.migClient.query("DELETE FROM hq_integration.hq_product_admin_security_audit"), /append-only/);
    await expectDenied(target.pool.query("UPDATE hq_integration.hq_product_admins SET endpoint_ref = 'other' WHERE id = $1", [id]), /immutable/);
    void Client;
  } finally {
    fs.rmSync(dumpFile, { force: true });
    await source.drop();
    await target.drop();
  }
});
