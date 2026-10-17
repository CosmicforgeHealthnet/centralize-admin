require("dotenv").config();
const { Client } = require("pg");

const REQUIRED_DATABASE = "cosmicforge_admin";
const REQUIRED_SCHEMA = "public";
const LOCAL_CI_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);
const FORBIDDEN_DATABASES = new Set(["postgres", "template0", "template1"]);
const PRODUCTION_HOST_PATTERN =
  /(prod|production|render|railway|neon|supabase|amazonaws|rds|azure|gcp|cloud|db\.cosmicforge)/i;

function normalizeHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function parseDatabaseTarget(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is malformed");
  }
  if (!["postgresql:", "postgres:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use a PostgreSQL protocol");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const schema = parsed.searchParams.get("schema") || REQUIRED_SCHEMA;
  return {
    host: normalizeHost(parsed.hostname),
    port: parsed.port || "5432",
    database,
    schema,
    ci: process.env.CI === "true",
  };
}

function validateAdminDatabaseTarget({
  connectionString = process.env.DATABASE_URL,
  ci = process.env.CI === "true",
  allowRemote = false,
} = {}) {
  const target = parseDatabaseTarget(connectionString);
  target.ci = Boolean(ci);
  if (target.database !== REQUIRED_DATABASE) {
    throw new Error(`database target must be ${REQUIRED_DATABASE}`);
  }
  if (FORBIDDEN_DATABASES.has(target.database)) {
    throw new Error("database target is a PostgreSQL maintenance database");
  }
  if (target.schema !== REQUIRED_SCHEMA) {
    throw new Error(`schema target must be ${REQUIRED_SCHEMA}`);
  }
  if (!LOCAL_CI_HOSTS.has(target.host) && (target.ci || !allowRemote)) {
    throw new Error("database host must be an approved local CI/Admin host");
  }
  if (PRODUCTION_HOST_PATTERN.test(target.host)) {
    throw new Error("database host looks production-like");
  }
  return target;
}

function formatTargetSummary(target) {
  return `host=${target.host} port=${target.port} database=${target.database} schema=${target.schema} ci=${target.ci}`;
}

async function queryConnectedTarget(client) {
  const result = await client.query("SELECT current_database() AS database, current_schema() AS schema");
  return {
    database: result.rows[0].database,
    schema: result.rows[0].schema,
  };
}

async function verifyConnectedDatabaseTarget(client, expectedTarget) {
  const connected = await queryConnectedTarget(client);
  if (connected.database !== REQUIRED_DATABASE) {
    throw new Error(`connected database must be ${REQUIRED_DATABASE}`);
  }
  if (connected.schema !== REQUIRED_SCHEMA) {
    throw new Error(`connected schema must be ${REQUIRED_SCHEMA}`);
  }
  if (expectedTarget && connected.database !== expectedTarget.database) {
    throw new Error("connected database does not match configured target");
  }
  if (expectedTarget && connected.schema !== expectedTarget.schema) {
    throw new Error("connected schema does not match configured target");
  }
  return connected;
}

async function verifyAdminDatabaseTarget({
  connectionString = process.env.DATABASE_URL,
  ci = process.env.CI === "true",
  allowRemote = false,
} = {}) {
  const target = validateAdminDatabaseTarget({ connectionString, ci, allowRemote });
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const connected = await verifyConnectedDatabaseTarget(client, target);
    return { target, connected };
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    const result = await verifyAdminDatabaseTarget();
    console.log(`db-admin-target ${formatTargetSummary(result.target)}`);
    console.log(`db-admin-target connected_database=${result.connected.database} connected_schema=${result.connected.schema}`);
  } catch (error) {
    console.log(`db-admin-target status=failed reason=${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_DATABASE,
  REQUIRED_SCHEMA,
  LOCAL_CI_HOSTS,
  parseDatabaseTarget,
  validateAdminDatabaseTarget,
  verifyAdminDatabaseTarget,
  verifyConnectedDatabaseTarget,
  queryConnectedTarget,
  formatTargetSummary,
};
