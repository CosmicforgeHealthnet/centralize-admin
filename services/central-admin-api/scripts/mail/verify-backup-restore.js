#!/usr/bin/env node
"use strict";

// CosmicForge Mail backup/restore validation for DISPOSABLE environments.
//
// What it does:
//   1. pg_dump (custom format) of every mail_* and marketing_* table from the
//      source database into a temp file.
//   2. Creates a fresh database next to it and pg_restores the dump.
//   3. Compares, per table, the row count and an order-independent checksum of
//      every row (md5 over the sorted row text), plus the presence of the
//      append-only guard triggers and CHECK constraints.
//   4. Optionally (--storage-dir) checks that every content/attachment object
//      key referenced by the restored rows exists in a filesystem storage
//      backend (S3 parity must be checked with provider tooling).
//   5. Drops the restore database (unless --keep) and prints a JSON report.
//
// Safety: it refuses to run unless the source is on localhost AND its name
// looks disposable (replay/test/ci/disposable/restore/scratch), or the
// operator passes --confirm-disposable=<exact database name>. It never writes
// to the source database. It must never be pointed at production.
//
// Usage:
//   node scripts/mail/verify-backup-restore.js --source-url=postgres://... \
//     [--confirm-disposable=<db>] [--storage-dir=/path] [--keep]

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("pg");

function args(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match) out[match[1]] = match[2] === undefined ? true : match[2];
  }
  return out;
}

const DISPOSABLE = /(replay|test|ci|disposable|restore|scratch)/i;

function assertDisposable(url, confirm) {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (confirm && confirm === name) return name;
  if (local && DISPOSABLE.test(name)) return name;
  throw new Error(`Refusing to run against "${name}" on ${parsed.hostname}: not a recognised disposable database. Pass --confirm-disposable=${name} only for a disposable copy.`);
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function query(url, sql, params = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function tableFingerprints(url) {
  const tables = (await query(url, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'mail\\_%' OR tablename LIKE 'marketing\\_%') ORDER BY tablename")).map((row) => row.tablename);
  const result = {};
  for (const table of tables) {
    const ident = `"${table.replace(/"/g, '""')}"`;
    const [row] = await query(url, `SELECT count(*)::bigint AS rows, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS checksum FROM ${ident} t`);
    result[table] = { rows: Number(row.rows), checksum: row.checksum };
  }
  return result;
}

async function guards(url) {
  const triggers = await query(url, "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'TRG_mail_%' ORDER BY tgname");
  const checks = await query(url, "SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'CHK_mail_%' ORDER BY conname");
  return { triggers: triggers.map((row) => row.tgname), checks: checks.map((row) => row.conname) };
}

async function storageReferences(url, storageDir) {
  if (!storageDir) return null;
  const rows = await query(url, `
    SELECT content_object_key AS key FROM mail_messages WHERE content_object_key IS NOT NULL
    UNION ALL SELECT raw_mime_object_key FROM mail_messages WHERE raw_mime_object_key IS NOT NULL
    UNION ALL SELECT storage_key FROM mail_attachments WHERE storage_key IS NOT NULL`);
  const missing = rows.filter((row) => !fs.existsSync(path.join(storageDir, row.key)));
  return { referenced: rows.length, missing: missing.length };
}

async function main() {
  const options = args(process.argv.slice(2));
  const source = options["source-url"] || process.env.DATABASE_URL;
  if (!source) throw new Error("--source-url or DATABASE_URL is required");
  const sourceName = assertDisposable(source, options["confirm-disposable"]);
  const restoreName = `${sourceName.slice(0, 40)}_restore_${crypto.randomBytes(4).toString("hex")}`;
  const restoreUrl = withDatabase(source, restoreName);
  const dumpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mail-backup-")), "mail.dump");
  const started = Date.now();
  const report = { source: sourceName, restore: restoreName, ok: false };
  try {
    execFileSync("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--table=mail_*", "--table=marketing_*", `--file=${dumpFile}`, `--dbname=${source}`], { stdio: ["ignore", "ignore", "inherit"] });
    report.dumpBytes = fs.statSync(dumpFile).size;
    await query(withDatabase(source, "postgres"), `CREATE DATABASE "${restoreName.replace(/"/g, '""')}"`);
    // Enum types live outside the tables: restore the schema first from the
    // full schema-only dump of the source, then the mail data.
    const schemaFile = `${dumpFile}.schema`;
    execFileSync("pg_dump", ["--format=custom", "--schema-only", "--no-owner", "--no-privileges", `--file=${schemaFile}`, `--dbname=${source}`], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${restoreUrl}`, schemaFile], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--data-only", "--disable-triggers", "--exit-on-error", `--dbname=${restoreUrl}`, dumpFile], { stdio: ["ignore", "ignore", "inherit"] });
    const [before, after, guardsBefore, guardsAfter] = await Promise.all([tableFingerprints(source), tableFingerprints(restoreUrl), guards(source), guards(restoreUrl)]);
    const mismatches = Object.keys({ ...before, ...after }).filter((table) => JSON.stringify(before[table]) !== JSON.stringify(after[table]));
    report.tables = Object.keys(before).length;
    report.rows = Object.values(before).reduce((sum, entry) => sum + entry.rows, 0);
    report.mismatches = mismatches;
    report.guards = { triggers: guardsAfter.triggers.length, checks: guardsAfter.checks.length, matches: JSON.stringify(guardsBefore) === JSON.stringify(guardsAfter) };
    report.storage = await storageReferences(restoreUrl, options["storage-dir"]);
    report.ok = !mismatches.length && report.guards.matches && (!report.storage || report.storage.missing === 0);
  } finally {
    if (!options.keep) await query(withDatabase(source, "postgres"), `DROP DATABASE IF EXISTS "${restoreName.replace(/"/g, '""')}" WITH (FORCE)`).catch(() => {});
    fs.rmSync(path.dirname(dumpFile), { recursive: true, force: true });
    report.durationMs = Date.now() - started;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`mail-backup-restore failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertDisposable, DISPOSABLE };
