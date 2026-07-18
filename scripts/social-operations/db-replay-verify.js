const { execFileSync, execSync } = require("child_process");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
  MIGRATION_DIR,
  verifyMigrationManifest,
} = require("./migration-manifest");
const {
  runSchemaAssertions,
} = require("./schema-assertions");

const ROOT = path.resolve(__dirname, "..", "..");

function npxBin() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function maintenanceUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/postgres";
  parsed.search = "";
  return parsed.toString();
}

function withDatabaseName(databaseUrl, name) {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

function maskConnectionString(connectionString) {
  const parsed = new URL(connectionString);
  if (parsed.password) parsed.password = "REDACTED";
  if (parsed.username) parsed.username = parsed.username ? "REDACTED" : "";
  return parsed.toString();
}

function assertDisposableBase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.toLowerCase();
  const ci = process.env.CI === "true";
  if (!ci && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Refusing migration replay because DATABASE_URL is not local");
  }
}

function replayCreateTypeSafely(sql) {
  return sql.replace(
    /^CREATE TYPE\s+([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\s+AS\s+ENUM\s+(\([^\n;]+?\));/gim,
    (_, typeName, enumValues) =>
      `DO $$ BEGIN CREATE TYPE ${typeName} AS ENUM ${enumValues}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  );
}

function runPrisma(args, env) {
  if (process.platform === "win32") {
    const command = [npxBin(), ...args.map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`)].join(" ");
    return execSync(command, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return execFileSync(npxBin(), args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function applyManualMigrations(connectionString, manifest) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const entry of manifest.migrations) {
      const sql = replayCreateTypeSafely(
        fs.readFileSync(path.join(MIGRATION_DIR, entry.file), "utf8"),
      );
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

async function queryPostgresVersion(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query("SELECT version()");
    return result.rows[0].version;
  } finally {
    await client.end();
  }
}

async function createDatabase(baseUrl, dbName) {
  const client = new Client({ connectionString: maintenanceUrl(baseUrl) });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(baseUrl, dbName) {
  const client = new Client({ connectionString: maintenanceUrl(baseUrl) });
  await client.connect();
  try {
    await client.query(
      `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()
      `,
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
  } finally {
    await client.end();
  }
}

async function replayVerify({ keep = false } = {}) {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required for replay verification");
  assertDisposableBase(sourceUrl);
  const manifestResult = verifyMigrationManifest();
  if (manifestResult.failures.length) {
    throw new Error(`migration manifest failed: ${manifestResult.failures.join(",")}`);
  }
  const dbName = `cosmicforge_social_replay_${Date.now()}`;
  const replayUrl = withDatabaseName(sourceUrl, dbName);
  let postgresVersion = null;
  let driftExitCode = 0;
  let driftSummary = "not_run";
  await createDatabase(sourceUrl, dbName);
  try {
    postgresVersion = await queryPostgresVersion(replayUrl);
    runPrisma(["prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
      DATABASE_URL: replayUrl,
    });
    await applyManualMigrations(replayUrl, manifestResult.manifest);
    await runSchemaAssertions({ connectionString: replayUrl });
    try {
      runPrisma(
        [
          "prisma",
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          "prisma/schema.prisma",
          "--exit-code",
        ],
        { DATABASE_URL: replayUrl },
      );
      driftSummary = "none";
    } catch (error) {
      driftExitCode = Number(error.status || error.code || 1);
      driftSummary = driftExitCode === 2 ? "diff_detected" : "diff_check_failed";
    }
    return {
      replayUrl,
      databaseName: dbName,
      postgresVersion,
      migrationCount: manifestResult.count,
      driftSummary,
      driftExitCode,
    };
  } finally {
    if (!keep) await dropDatabase(sourceUrl, dbName);
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  try {
    const result = await replayVerify({ keep });
    console.log(
      `db-replay status=ok database=${result.databaseName} migrations=${result.migrationCount} drift=${result.driftSummary}`,
    );
    console.log(`db-replay postgres_version=${result.postgresVersion}`);
    if (keep) console.log(`db-replay kept_database=${maskConnectionString(result.replayUrl)}`);
  } catch (error) {
    console.log(`db-replay status=failed reason=${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  replayCreateTypeSafely,
  replayVerify,
};
