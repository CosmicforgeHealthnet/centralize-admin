"use strict";

// Runs only when KARRYAM_ADMIN_TEST_DATABASE_URL points at a disposable
// PostgreSQL superuser connection. Creates and drops its own uniquely named
// database and roles (prefix ka_test_). Never point this at staging/prod.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { Client, Pool } = require("pg");
const { migrate, listMigrations } = require("../scripts/migrate");
const { pgAudit } = require("../src/audit");
const { pgOperations } = require("../src/db/operations");
const { pgNonceStore } = require("../src/security/nonce-store");
const F = require("./helpers/fixtures");

const ADMIN_URL = process.env.KARRYAM_ADMIN_TEST_DATABASE_URL;

function withDb(base, db, user, password) {
  const url = new URL(base);
  url.pathname = "/" + db;
  if (user) { url.username = user; url.password = password || ""; }
  return url.toString();
}

test("migrations, runtime least privilege and durable stores on disposable PostgreSQL", async (t) => {
  if (!ADMIN_URL) { t.skip("KARRYAM_ADMIN_TEST_DATABASE_URL not set"); return; }
  const suffix = randomBytes(4).toString("hex");
  const db = "ka_test_" + suffix;
  const migrator = "ka_test_migrator_" + suffix;
  const runtime = "ka_test_runtime_" + suffix;
  // Throwaway passwords: CI PostgreSQL uses password (SCRAM) authentication.
  const password = randomBytes(12).toString("hex");
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${migrator}`);
  await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${runtime}`);
  const pools = [];
  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn();
    for (const p of pools) await p.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtime}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${migrator}`).catch(() => {});
    await admin.end();
  });

  const migrationUrl = withDb(ADMIN_URL, db, migrator, password);
  const runtimeUrl = withDb(ADMIN_URL, db, runtime, password);

  // Fresh install, then an idempotent re-run.
  const first = await migrate({ connectionString: migrationUrl, runtimeRole: runtime });
  assert.deepEqual(first.applied, ["001_karryam_admin_foundation"]);
  const again = await migrate({ connectionString: migrationUrl, runtimeRole: runtime });
  assert.deepEqual(again.applied, []);

  // A changed applied migration is refused.
  const tampered = fs.mkdtempSync(path.join(os.tmpdir(), "ka-mig-"));
  cleanups.push(() => fs.rmSync(tampered, { recursive: true, force: true }));
  for (const m of listMigrations()) fs.writeFileSync(path.join(tampered, m.file), m.sql + "\n-- edited\n");
  await assert.rejects(migrate({ connectionString: migrationUrl, dir: tampered }), /APPLIED_MIGRATION_CHANGED:001_karryam_admin_foundation/);
  await assert.rejects(migrate({ connectionString: migrationUrl, runtimeRole: "Bad;Role" }), /RUNTIME_ROLE_INVALID/);

  // Runtime role: insert/select only on audit, no DDL, no mutation.
  const pool = new Pool({ connectionString: runtimeUrl, max: 3 });
  pool.on("error", () => {});
  pools.push(pool);
  const audit = pgAudit(pool);
  await audit.record({ correlation_id: "corr-12345678", endpoint: "manifest", method: "GET", service_id: "hq-product-integration-core", outcome: "ACCESS" });
  const denied = async (sql, code) => {
    await assert.rejects(pool.query(sql), (e) => e.code === code, sql);
  };
  await denied("UPDATE karryam_admin.integration_audit SET outcome = 'X'", "42501");
  await denied("DELETE FROM karryam_admin.integration_audit", "42501");
  await denied("TRUNCATE karryam_admin.integration_audit", "42501");
  await denied("CREATE TABLE karryam_admin.evil (id int)", "42501");
  await denied("DROP TABLE karryam_admin.operation_requests", "42501");
  await denied("UPDATE karryam_admin.operation_requests SET status = 'EXECUTED'", "42501");

  // Even the owner cannot mutate audit rows (trigger), and nothing but REJECTED can be stored.
  const owner = new Client({ connectionString: migrationUrl });
  owner.on("error", () => {});
  await owner.connect();
  cleanups.push(() => owner.end().catch(() => {}));
  await assert.rejects(owner.query("UPDATE karryam_admin.integration_audit SET outcome = 'TAMPERED'"), /append-only/);
  await assert.rejects(owner.query("DELETE FROM karryam_admin.integration_audit"), /append-only/);
  await assert.rejects(owner.query("TRUNCATE karryam_admin.integration_audit"), /append-only/);
  await assert.rejects(owner.query("INSERT INTO karryam_admin.operation_requests(id, service_id, idempotency_key, request_digest, capability_id, staff_ref, status, reason_code) VALUES ($1,'s','idempotency-key-0001','sha256:" + "a".repeat(64) + "','c','st','EXECUTED','r')", [randomUUID()]), (e) => e.code === "23514");

  // Durable replay protection.
  const nonces = pgNonceStore(pool);
  const expires = Date.now() + 60000;
  assert.equal(await nonces.claim("svc:hq-product-integration-core", "0123456789abcdef0123456789abcdef", expires), true);
  assert.equal(await nonces.claim("svc:hq-product-integration-core", "0123456789abcdef0123456789abcdef", expires), false);

  // Durable rejection + audit in one transaction; idempotent replay and conflicts.
  const ops = pgOperations(pool);
  const op = { id: randomUUID(), serviceId: "hq-product-integration-core", idempotencyKey: "idem-" + randomUUID(), requestDigest: "sha256:" + "b".repeat(64), capabilityId: "karryam.wallet.refund", staffRef: "staff-17", reasonCode: "CAPABILITY_DISABLED" };
  const auditRecord = { correlation_id: "corr-12345678", endpoint: "operationSubmit", method: "POST", service_id: op.serviceId, staff_ref: "staff-17", action: "operation.submit", outcome: "OPERATION_REJECTED", reason_code: "CAPABILITY_DISABLED" };
  assert.equal((await ops.recordRejection(op, auditRecord)).kind, "CREATED");
  assert.equal((await ops.recordRejection(op, auditRecord)).kind, "REPLAY");
  assert.equal((await ops.recordRejection({ ...op, requestDigest: "sha256:" + "c".repeat(64) }, auditRecord)).kind, "KEY_CONFLICT");
  assert.equal((await ops.recordRejection({ ...op, idempotencyKey: "idem-" + randomUUID() }, auditRecord)).kind, "COMMAND_CONFLICT");
  assert.equal((await ops.get(op.id)).status, "REJECTED");
  const trail = await audit.listForOperation(op.id);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].outcome, "OPERATION_REJECTED");

  // The full service against the runtime role: access is audited durably.
  const m = F.material();
  cleanups.push(m.cleanup);
  const config = F.loadConfig(F.enabledEnv(m, { KARRYAM_ADMIN_DATABASE_URL: runtimeUrl }));
  const app = await F.startApp(config, { audit, operations: ops, nonceStore: nonces, dbReady: async () => (await pool.query("SELECT 1")).rowCount === 1 });
  cleanups.push(app.close);
  const client = F.hqClient(app.target, m.hqKey);
  const before = (await pool.query("SELECT count(*)::int AS n FROM karryam_admin.integration_audit")).rows[0].n;
  assert.equal((await client.getDatasets()).status, 200);
  const after = (await pool.query("SELECT count(*)::int AS n FROM karryam_admin.integration_audit")).rows[0].n;
  assert.equal(after, before + 1);
  const ready = await F.rawRequest(app.port, { path: "/health/ready" });
  assert.equal(ready.json.database, "OK");
});
