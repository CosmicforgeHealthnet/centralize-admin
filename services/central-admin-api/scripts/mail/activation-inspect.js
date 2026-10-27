#!/usr/bin/env node
"use strict";

// Read-only inspection of a deployment before CosmicForge Mail is activated.
//
// Run by .github/workflows/mail-activation-staging.yml inside the running
// staging `app` container (piped to `node -`), or locally against a test
// database. It changes nothing:
//   - the database session is opened read-only (default_transaction_read_only)
//     and only reads information_schema, the migration ledger and row counts;
//   - storage and KMS are NOT called with credentials (the S3 health check
//     writes a canary object, so it belongs to a later, approved phase);
//     only a TCP connection to the configured endpoint is attempted;
//   - the scanner gets a clamd PING;
//   - Resend is never contacted.
//
// Output is states, counts, booleans and setting NAMES only. No secret,
// key, URL, hostname, bucket name or address is printed.
//
//   INSPECT_APP_ROOT=/app node - < scripts/mail/activation-inspect.js
//   node scripts/mail/activation-inspect.js            (local, from the API dir)

const path = require("node:path");
const net = require("node:net");

const APP = process.env.INSPECT_APP_ROOT || path.resolve(__dirname, "..", "..");
const from = (relative) => require(path.join(APP, relative));

const SECRET_NAMES = [
  "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "MAIL_ENCRYPTION_KEYS", "MAIL_ENCRYPTION_ACTIVE_KEY",
  "MAIL_S3_ACCESS_KEY_ID", "MAIL_S3_SECRET_ACCESS_KEY", "MAIL_KMS_ACCESS_KEY_ID", "MAIL_KMS_SECRET_ACCESS_KEY",
  "MAIL_METRICS_TOKEN",
];
const VARIABLE_NAMES = [
  "MAIL_DEPLOYMENT_ENV", "MAIL_PROVIDER", "MAIL_DOMAIN_ALLOWLIST", "MAIL_RESERVED_SENDER_ADDRESSES",
  "MAIL_TEST_RECIPIENT_ALLOWLIST", "MAIL_INBOUND_ACTIVE_ENVIRONMENT", "MAIL_UNKNOWN_RECIPIENT_POLICY",
  "MAIL_MIXED_RECIPIENT_MODE", "MAIL_STORAGE_PROVIDER", "MAIL_S3_BUCKET", "MAIL_S3_REGION", "MAIL_S3_ENDPOINT",
  "MAIL_S3_SSE", "MAIL_S3_SSE_KMS_KEY_ID", "MAIL_KMS_PROVIDER", "MAIL_KMS_KEY_ID", "MAIL_KMS_REGION",
  "MAIL_SCANNER_PROVIDER", "MAIL_CLAMD_HOST", "MAIL_CLAMD_PORT", "MAIL_PUBLIC_API_URL", "MAIL_PUBLIC_APP_URL",
  "MAIL_WORKER_QUEUES",
];
const FLAG_NAMES = [
  "MAIL_ENABLED", "MAIL_SENDING_ENABLED", "MAIL_RECEIVING_ENABLED", "MAIL_WORKER_ENABLED", "MAIL_MARKETING_ENABLED",
  "MAIL_RECONCILIATION_ENABLED", "MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED",
];
// Row counts reported when the table exists (counts only, never contents).
const COUNT_TABLES = ["mail_organizations", "mail_domains", "mail_mailboxes", "mail_addresses", "mail_memberships", "mail_messages", "mail_outbox_jobs", "mail_webhook_events"];

const present = (name) => Boolean(String(process.env[name] || "").trim());
const isTrue = (name) => ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());

function hostClass(host) {
  if (!host) return "none";
  if (/^(127\.\d+\.\d+\.\d+|localhost|::1)$/i.test(host)) return "loopback";
  if (net.isIP(host)) return "ip-address";
  return host.includes(".") ? "dns-name" : "internal-name";
}

function tcpProbe(host, port, timeoutMs = 5000) {
  if (!host || !port) return Promise.resolve("NOT_CONFIGURED");
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (state) => { socket.destroy(); resolve(state); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("REACHABLE"));
    socket.once("timeout", () => done("TIMEOUT"));
    socket.once("error", (error) => done(`UNREACHABLE_${String(error.code || "ERROR").replace(/[^A-Z0-9_]/g, "")}`));
  });
}

function endpointOf(url, fallbackHost, defaultPort = 443) {
  try {
    const parsed = new URL(url || `https://${fallbackHost}`);
    return { host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === "http:" ? 80 : defaultPort)), https: parsed.protocol === "https:", hostClass: hostClass(parsed.hostname) };
  } catch {
    return { host: "", port: 0, https: false, hostClass: "invalid" };
  }
}

async function inspectDatabase(report, blockers) {
  const { Client } = from("node_modules/pg");
  const { MAIL_SCHEMA_REQUIREMENTS, MAIL_FEATURE_REQUIREMENTS, MAIL_PREFERENCES_REQUIREMENTS, MAIL_FINAL_GAP_REQUIREMENTS } = from("src/modules/mail/schema-readiness.js");
  const { loadMigrationManifest } = from("scripts/social-operations/migration-manifest.js");
  const database = { configured: present("DATABASE_URL") };
  report.database = database;
  if (!database.configured) { blockers.push("DATABASE_URL is not set"); return; }

  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 15000, options: "-c default_transaction_read_only=on" });
  try {
    await client.connect();
  } catch (error) {
    database.connect = `FAILED_${String(error.code || error.name || "ERROR").replace(/[^A-Za-z0-9_]/g, "")}`;
    blockers.push("database connection failed");
    return;
  }
  try {
    const identity = await client.query("SELECT current_database() AS db, current_schema() AS schema, current_setting('transaction_read_only') AS ro, current_setting('server_version_num') AS v");
    const row = identity.rows[0];
    database.connect = "OK";
    database.isAdminDatabase = row.db === "cosmicforge_admin";
    database.schema = row.schema;
    database.sessionReadOnly = row.ro === "on";
    database.serverVersionNum = Number(row.v);
    if (!database.isAdminDatabase) blockers.push("connected database is not cosmicforge_admin");
    if (!database.sessionReadOnly) throw new Error("read-only session was not established; stopping");

    const tables = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()")).rows.map((r) => r.table_name));
    const columns = new Set((await client.query("SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()")).rows.map((r) => r.c));
    const groups = { core: MAIL_SCHEMA_REQUIREMENTS, gapClosure35: MAIL_FEATURE_REQUIREMENTS, preferences36: MAIL_PREFERENCES_REQUIREMENTS, finalGap37: MAIL_FINAL_GAP_REQUIREMENTS };
    database.mailSchema = {};
    for (const [name, requirements] of Object.entries(groups)) {
      const result = requirements.map((requirement) => {
        const missingTables = (requirement.tables || []).filter((table) => !tables.has(table));
        const missingColumns = (requirement.columns || []).filter(([table, column]) => !columns.has(`${table}.${column}`)).map(([table, column]) => `${table}.${column}`);
        return { migration: requirement.migration, complete: !missingTables.length && !missingColumns.length, missingTables: missingTables.length, missingColumns: missingColumns.length };
      });
      database.mailSchema[name] = { complete: result.every((r) => r.complete), migrations: result };
    }

    const manifest = loadMigrationManifest();
    const ledger = { table: "social_manual_migrations", exists: tables.has("social_manual_migrations") };
    database.ledger = ledger;
    if (ledger.exists) {
      const applied = new Map((await client.query("SELECT file, sha256 FROM public.social_manual_migrations")).rows.map((r) => [r.file, r.sha256]));
      ledger.manifestMigrations = manifest.migrations.length;
      ledger.appliedCount = manifest.migrations.filter((m) => applied.has(m.file)).length;
      ledger.checksumMismatches = manifest.migrations.filter((m) => applied.has(m.file) && applied.get(m.file) !== m.sha256).map((m) => m.order);
      ledger.missingOrders = manifest.migrations.filter((m) => !applied.has(m.file)).map((m) => m.order);
      ledger.mailOrders27to37Applied = manifest.migrations.filter((m) => m.order >= 27 && m.order <= 37).every((m) => applied.has(m.file));
      if (ledger.checksumMismatches.length) blockers.push(`ledger checksum mismatch for manifest orders ${ledger.checksumMismatches.join(",")}`);
    }
    if (!database.mailSchema.core.complete) blockers.push("core Mail schema is not applied (migrations required; not run by this inspection)");

    database.rowCounts = {};
    for (const table of COUNT_TABLES) {
      if (!tables.has(table)) continue;
      database.rowCounts[table] = Number((await client.query(`SELECT count(*)::bigint AS n FROM public."${table}"`)).rows[0].n);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const { loadMailConfig, publicStatus, infrastructureViolations, addressPolicyViolations, providerConfigured } = from("src/modules/mail/mail.config.js");
  const { parseKeyringEntries } = from("src/modules/mail/security/kms-keyring.js");
  const { createAttachmentScanner } = from("src/modules/mail/scanning/attachment-scanner.js");

  const env = process.env;
  const config = loadMailConfig(env);
  const blockers = [];
  const report = { inspectedAt: new Date().toISOString(), node: process.version, nodeEnv: env.NODE_ENV || null, readOnly: true };

  report.flags = Object.fromEntries(FLAG_NAMES.map((name) => [name, isTrue(name)]));
  report.effective = { enabled: config.enabled, sending: config.sendingEnabled, receiving: config.receivingEnabled, worker: config.workerEnabled, marketing: config.marketingEnabled };
  report.allMailFlagsOff = Object.values(report.flags).every((value) => value === false);
  report.secretsPresent = Object.fromEntries(SECRET_NAMES.map((name) => [name, present(name)]));
  report.variablesPresent = Object.fromEntries(VARIABLE_NAMES.map((name) => [name, present(name)]));
  report.status = publicStatus(config);
  report.currentViolations = [...infrastructureViolations(config), ...addressPolicyViolations(config)];

  // What would block activation: the same rules, evaluated as if every
  // activation flag were on. Nothing is switched on; this is a dry evaluation.
  const activated = loadMailConfig({ ...env, MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_WORKER_ENABLED: "true" });
  report.activationViolations = [...infrastructureViolations(activated), ...addressPolicyViolations(activated)];
  report.providerKeyPresent = providerConfigured(activated);
  if (!report.providerKeyPresent) blockers.push("Resend API key not present");
  if (!report.secretsPresent.RESEND_WEBHOOK_SECRET) blockers.push("webhook signing secret not present");

  // Encryption: the keyring is parsed for structure only. No key is unwrapped,
  // decrypted or used, and no value is printed.
  const entries = parseKeyringEntries(config.encryption.keys);
  report.encryption = {
    kmsProvider: config.kms.provider,
    keyringEntries: entries.length,
    wrappedEntries: entries.filter((entry) => entry.wrapped).length,
    rawEntries: entries.filter((entry) => entry.raw).length,
    rawEntriesWellFormed: entries.filter((entry) => entry.raw).every((entry) => entry.raw.length === 32),
    activeKeySet: Boolean(config.encryption.activeKey),
    activeKeyInKeyring: entries.some((entry) => entry.version === config.encryption.activeKey),
  };
  if (!report.encryption.keyringEntries || !report.encryption.activeKeyInKeyring) blockers.push("encryption keyring missing or active key not in keyring");

  const s3 = endpointOf(config.storage.s3.endpoint, `s3.${config.storage.s3.region}.amazonaws.com`);
  report.storage = {
    provider: config.storage.provider,
    bucketSet: Boolean(config.storage.s3.bucket),
    bucketNameMarksStaging: /(staging|stg)/i.test(config.storage.s3.bucket),
    credentialsPresent: Boolean(config.storage.s3.accessKeyId && config.storage.s3.secretAccessKey),
    endpointHttps: s3.https,
    endpointHostClass: s3.hostClass,
    sse: config.storage.s3.sse || null,
    endpointTcp: config.storage.provider === "s3" ? await tcpProbe(s3.host, s3.port) : "NOT_CHECKED",
    liveReadWrite: "NOT_CHECKED_REQUIRES_APPROVED_PHASE",
  };
  if (config.storage.provider !== "s3") blockers.push("storage provider is not s3");

  const kms = endpointOf(config.kms.endpoint, `kms.${config.kms.region}.amazonaws.com`);
  report.kms = {
    provider: config.kms.provider,
    keyIdSet: Boolean(config.kms.keyId),
    keyEnvironment: config.kms.keyEnvironment || null,
    credentialsPresent: Boolean(config.kms.accessKeyId && config.kms.secretAccessKey),
    endpointHttps: kms.https,
    endpointTcp: config.kms.provider === "aws-kms" ? await tcpProbe(kms.host, kms.port) : "NOT_CHECKED",
    liveDecrypt: "NOT_CHECKED_REQUIRES_APPROVED_PHASE",
  };

  const scanner = createAttachmentScanner({ config });
  let scannerHealth = "NOT_CONFIGURED";
  if (scanner.available) {
    try { scannerHealth = (await scanner.health()).ok ? "PONG" : "UNAVAILABLE"; } catch { scannerHealth = "UNAVAILABLE"; }
  }
  report.scanner = { provider: config.scanning.provider, hostClass: hostClass(config.scanning.clamdHost), health: scannerHealth };
  if (scannerHealth !== "PONG") blockers.push("virus scanner (clamd) not answering PING");

  try {
    await inspectDatabase(report, blockers);
  } catch (error) {
    report.database = { ...(report.database || {}), error: String(error.message || error).slice(0, 200) };
    blockers.push("database inspection failed");
  }

  if (!report.allMailFlagsOff) blockers.push("a Mail flag is already on (expected all off before approval)");
  report.blockers = blockers;
  report.readyForMigrationReview = !blockers.some((b) => !/schema is not applied/.test(b));
  process.stdout.write(`MAIL_ACTIVATION_INSPECTION ${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stdout.write(`MAIL_ACTIVATION_INSPECTION_FAILED ${JSON.stringify({ error: String(error.message || error).slice(0, 300) })}\n`);
  process.exitCode = 1;
});
