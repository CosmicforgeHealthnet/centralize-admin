"use strict";

// Disposable PostgreSQL databases for tests. Requires PIC_TEST_DATABASE_URL
// pointing at a superuser connection on a throwaway server (CI service
// container or a local scratch cluster). Never point it at staging.

const { randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { migrate } = require("../../src/db/migrate");

const ADMIN_URL = process.env.PIC_TEST_DATABASE_URL || "";

function available() {
  return Boolean(ADMIN_URL);
}

function withDatabase(url, database, user, password) {
  const u = new URL(url);
  u.pathname = "/" + database;
  if (user) { u.username = user; u.password = password || ""; }
  return u.toString();
}

async function createDisposableDatabase({ migrateNow = true } = {}) {
  const suffix = randomBytes(5).toString("hex");
  const database = "pic_test_" + suffix;
  const migrator = "pic_mig_" + suffix;
  const runtime = "pic_rt_" + suffix;
  const password = randomBytes(12).toString("hex");
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${migrator}`);
  await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtime}`);
  await admin.end();

  const migrationUrl = withDatabase(ADMIN_URL, database, migrator, password);
  const runtimeUrl = withDatabase(ADMIN_URL, database, runtime, password);
  // The migrator owns the database but is not a superuser.
  const migClient = new Client({ connectionString: migrationUrl });
  await migClient.connect();
  await migClient.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  if (migrateNow) await migrate(migClient, { runtimeRole: runtime });
  const pool = new Pool({ connectionString: runtimeUrl, max: 8 });

  async function drop() {
    await pool.end().catch(() => {});
    await migClient.end().catch(() => {});
    const c = new Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [database]);
    await c.query(`DROP DATABASE IF EXISTS ${database}`);
    await c.query(`DROP ROLE IF EXISTS ${runtime}`);
    await c.query(`DROP ROLE IF EXISTS ${migrator}`);
    await c.end();
  }

  return { database, pool, migClient, runtimeRole: runtime, migrationUrl, runtimeUrl, drop };
}

module.exports = { available, createDisposableDatabase, ADMIN_URL };
