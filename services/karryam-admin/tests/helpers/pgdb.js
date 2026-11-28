"use strict";

// Disposable PostgreSQL databases and roles for Karryam Admin tests.
// KARRYAM_ADMIN_TEST_DATABASE_URL must point at a superuser connection on a
// throwaway server (CI service container or a local scratch cluster). Every
// database and role is uniquely named (prefix ka_t9_) and dropped after use.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { listMigrations } = require("../../scripts/migrate");

const ADMIN_URL = process.env.KARRYAM_ADMIN_TEST_DATABASE_URL || "";

function withDb(base, db, user, password) {
  const url = new URL(base);
  url.pathname = "/" + db;
  if (user) { url.username = user; url.password = password || ""; }
  return url.toString();
}

async function adminQuery(sql, params) {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

/** Creates a database owned by a non-superuser migrator, plus a runtime role. */
async function createDisposable(prefix = "ka_t9") {
  const suffix = randomBytes(4).toString("hex");
  const db = `${prefix}_${suffix}`;
  const migrator = `${prefix}_mig_${suffix}`;
  const runtime = `${prefix}_rt_${suffix}`;
  const password = randomBytes(12).toString("hex");
  await adminQuery(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}'`);
  await adminQuery(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await adminQuery(`CREATE DATABASE ${db} OWNER ${migrator}`);
  await adminQuery(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await adminQuery(`GRANT CONNECT ON DATABASE ${db} TO ${runtime}`);
  const migrationUrl = withDb(ADMIN_URL, db, migrator, password);
  const runtimeUrl = withDb(ADMIN_URL, db, runtime, password);
  const pools = [];
  const extraRoles = [];
  const extraDbs = [];
  const tmpDirs = [];
  return {
    db, migrator, runtime, password, migrationUrl, runtimeUrl,
    pool(url = runtimeUrl, max = 4) { const p = new Pool({ connectionString: url, max }); p.on("error", () => {}); pools.push(p); return p; },
    async owner() { const c = new Client({ connectionString: migrationUrl }); c.on("error", () => {}); await c.connect(); pools.push({ end: () => c.end() }); return c; },
    url(dbName = db, user = runtime) { return withDb(ADMIN_URL, dbName, user, password); },
    async role(name, attrs = "") { await adminQuery(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' ${attrs}`); extraRoles.push(name); return name; },
    async database(name, owner = migrator) { await adminQuery(`CREATE DATABASE ${name} OWNER ${owner}`); await adminQuery(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`); extraDbs.push(name); return name; },
    /** A directory holding only the first `count` migrations (an older release). */
    migrationsUpTo(count) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ka-mig-"));
      tmpDirs.push(dir);
      for (const m of listMigrations().slice(0, count)) fs.writeFileSync(path.join(dir, m.file), m.sql);
      return dir;
    },
    async drop() {
      for (const p of pools) await p.end().catch(() => {});
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
      for (const name of [db, ...extraDbs]) await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      for (const r of [runtime, migrator, ...extraRoles]) await adminQuery(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    },
  };
}

module.exports = { ADMIN_URL, withDb, adminQuery, createDisposable };
