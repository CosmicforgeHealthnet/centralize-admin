#!/usr/bin/env node
"use strict";

// CosmicForge Mail rollback drill on a DISPOSABLE replay database.
//
//   1. Builds a fresh replay database from the committed baseline plus every
//      manual migration (db-replay-verify, kept).
//   2. Seeds one row into representative M7-M10 tables.
//   3. Runs docs/sql/cosmicforge-mail-m7-m10-rollback.sql.
//   4. Verifies every M7-M10 table and type (and the later preferences and
//      gap-closure tables) is gone, M1-M6 tables are intact
//      and their rows untouched.
//   5. Re-applies migrations 29+ in manifest order (roll-forward) and checks
//      there is no schema drift against prisma/schema.prisma.
//   6. Drops the replay database (unless --keep) and prints a JSON report.
//
// Never point this at a shared database: DATABASE_URL must be a disposable
// local server (enforced by db-replay-verify). Usage:
//   npm run mail:rollback:drill   (DATABASE_URL must point at a local disposable server)

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { replayVerify, dropDatabase, replayCreateTypeSafely } = require("../social-operations/db-replay-verify");
const { verifyMigrationManifest, MIGRATION_DIR } = require("../social-operations/migration-manifest");

const ROOT = path.resolve(__dirname, "..", "..");
const ROLLBACK_SQL = path.resolve(ROOT, "..", "..", "docs", "sql", "cosmicforge-mail-m7-m10-rollback.sql");
const FIRST_ROLLED_BACK = "20261026_mail_step_up_session_binding.sql";
// Rollbacks for migrations ordered after M10, newest first. They run before
// the M7-M10 rollback (later migrations may depend on M7-M10 objects) and are
// re-applied by the same roll-forward.
const LATER_ROLLBACKS = ["cosmicforge-mail-user-preferences-rollback.sql", "cosmicforge-mail-gap-closure-rollback.sql", "account-setup-tokens-rollback.sql"].map((file) => path.resolve(ROOT, "..", "..", "docs", "sql", file));
const REMOVED_TABLES = [
  "marketing_brand_settings", "marketing_broadcast_dispatches", "marketing_broadcast_recipients", "marketing_automations", "marketing_automation_versions",
  "marketing_automation_enrollments", "marketing_automation_step_runs", "marketing_trigger_events", "marketing_campaign_approved_contacts",
  "mail_product_integrations", "mail_product_sender_authorizations", "mail_product_integration_events", "mail_product_delivery_events",
  "mail_retention_runs", "mail_usage_daily", "mail_quota_limits", "mail_ops_alerts",
  "mail_rollout_cohorts", "mail_rollout_cohort_members", "mail_rollout_rules", "mail_emergency_stops",
];
const KEPT_TABLES = ["mail_organizations", "mail_mailboxes", "mail_messages", "mail_retention_policies", "mail_legal_holds", "mail_step_up_verifications", "marketing_email_campaigns", "admin_sessions"];

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function exists(client, table) {
  return (await client.query("SELECT to_regclass($1) AS oid", [`public.${table}`])).rows[0].oid !== null;
}

async function main() {
  const keep = process.argv.includes("--keep");
  const report = { ok: false };
  const replay = await replayVerify({ keep: true });
  report.database = replay.databaseName;
  try {
    await withClient(replay.replayUrl, async (client) => {
      const org = (await client.query(`INSERT INTO mail_organizations (id, slug, name, kind, created_by, created_at, updated_at) VALUES (gen_random_uuid(), 'drill', 'Drill', 'BRAND', 'drill', now(), now()) RETURNING id`)).rows[0].id;
      await client.query(`INSERT INTO mail_usage_daily (organization_id, purpose, day, accepted) VALUES ($1, 'STAFF_MAIL', current_date, 1)`, [org]);
      await client.query(`INSERT INTO mail_rollout_cohorts (id, key, name, created_by, created_at) VALUES (gen_random_uuid(), 'drill', 'Drill', 'drill', now())`);
      await client.query(`INSERT INTO mail_emergency_stops (id, environment, scope, reason, activated_by, activated_at) VALUES (gen_random_uuid(), 'test', 'ALL', 'drill stop', 'drill', now())`);
      await client.query(`INSERT INTO mail_product_integrations (id, product, organization_id, service_name, created_by, updated_by, created_at, updated_at) VALUES (gen_random_uuid(), 'drill', $1, 'drill-service', 'drill', 'drill', now(), now())`, [org]);
      // Migration 36: a preferences row (references admin_users, which is kept).
      const drillUser = (await client.query(`INSERT INTO admin_users (id, email, password, name, "updatedAt") VALUES (gen_random_uuid()::text, 'drill@drill.invalid', 'x', 'Drill', now()) RETURNING id`)).rows[0].id;
      await client.query(`INSERT INTO mail_user_preferences (admin_user_id, notifications_enabled) VALUES ($1, false)`, [drillUser]);
      report.seeded = true;
      for (const file of LATER_ROLLBACKS) await client.query(fs.readFileSync(file, "utf8"));
      report.laterRollbacks = LATER_ROLLBACKS.map((file) => path.basename(file));
      await client.query(fs.readFileSync(ROLLBACK_SQL, "utf8"));
      const leftovers = [];
      for (const table of REMOVED_TABLES) if (await exists(client, table)) leftovers.push(table);
      if (await exists(client, "mail_user_preferences")) leftovers.push("mail_user_preferences");
      const missing = [];
      for (const table of KEPT_TABLES) if (!(await exists(client, table))) missing.push(table);
      const types = (await client.query(`SELECT typname FROM pg_type WHERE typname IN ('MailRetentionRunMode', 'MailRetentionRunStatus', 'MailProductIntegrationStatus', 'MarketingBroadcastStatus', 'MarketingAutomationStatus')`)).rows.map((row) => row.typname);
      const stepUpSession = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'mail_step_up_verifications' AND column_name = 'session_id'`)).rowCount;
      const orgKept = (await client.query("SELECT count(*)::int AS n FROM mail_organizations WHERE slug = 'drill'")).rows[0].n;
      report.rollback = { leftoverTables: leftovers, missingKeptTables: missing, leftoverTypes: types, stepUpSessionColumn: Boolean(stepUpSession), m1Rows: orgKept };
      // Roll forward again: re-apply every migration from the first rolled-back one.
      const manifest = verifyMigrationManifest().manifest;
      const start = manifest.migrations.findIndex((entry) => entry.file === FIRST_ROLLED_BACK);
      for (const entry of manifest.migrations.slice(start)) await client.query(replayCreateTypeSafely(fs.readFileSync(path.join(MIGRATION_DIR, entry.file), "utf8")));
      report.reapplied = manifest.migrations.length - start;
    });
    let drift = "none";
    try {
      execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: replay.replayUrl }, stdio: ["ignore", "ignore", "ignore"] });
    } catch (error) {
      drift = Number(error.status) === 2 ? "diff_detected" : "diff_check_failed";
    }
    report.rollForwardDrift = drift;
    const r = report.rollback;
    report.ok = !r.leftoverTables.length && !r.missingKeptTables.length && !r.leftoverTypes.length && !r.stepUpSessionColumn && r.m1Rows === 1 && drift === "none";
  } finally {
    if (!keep) await dropDatabase(process.env.DATABASE_URL, replay.databaseName).catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`mail-rollback-drill failed: ${error.message}\n`);
  process.exitCode = 1;
});
