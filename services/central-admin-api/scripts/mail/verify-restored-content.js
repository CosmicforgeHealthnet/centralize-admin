#!/usr/bin/env node
"use strict";

// Restore drill verifier: proves a restored backup is USABLE, not just present.
//
// Against a restored database copy and a restored storage directory it
//   - reads every stored object referenced by the database (message bodies,
//     attachments, archived headers and raw MIME), decrypts it with the keyring
//     and checks the SHA-256 recorded in the database;
//   - decrypts every encrypted column (drafts, snippets, internal notes);
//   - checks the storage directory belongs to the expected environment.
// It only reads. Output: counts per source (never content or key material).
//
//   DATABASE_URL=postgres://.../restore_copy \
//   node scripts/mail/verify-restored-content.js \
//     --storage-dir=/restore/mail-store --keyring-file=/run/secrets/... \
//     --environment=staging [--max-failures-listed=20]

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { readKeyringFile } = require("../../src/modules/mail/security/file-keyring");
const { createMailEncryption } = require("../../src/modules/mail/security/mail-encryption.service");
const { createEncryptedStore, filesystemBackend, STORE_MARKER } = require("../../src/modules/mail/storage/mail-storage");

const OBJECT_SOURCES = [
  { table: "mail_messages", key: "content_object_key", sha: "content_sha256", purpose: "mail-body" },
  { table: "mail_attachments", key: "storage_key", sha: "sha256", purpose: "mail-attachment" },
  { table: "mail_message_archives", key: "headers_object_key", sha: "headers_sha256", purpose: "mail-archive-headers" },
  { table: "mail_message_archives", key: "raw_mime_object_key", sha: "raw_mime_sha256", purpose: "mail-raw-mime" },
];
const COLUMN_SOURCES = [
  { table: "mail_drafts", column: "encrypted_body", purpose: "mail-draft" },
  { table: "mail_messages", column: "encrypted_snippet", purpose: "mail-snippet" },
  { table: "mail_threads", column: "encrypted_snippet", purpose: "mail-snippet" },
  { table: "mail_internal_notes", column: "encrypted_body", purpose: "mail-internal-note" },
];

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown argument ${arg}`);
    options[match[1]] = match[2] === undefined ? true : match[2];
  }
  return options;
}

async function tableExists(client, table) {
  const { rows } = await client.query("SELECT to_regclass($1)::text AS name", [`public.${table}`]);
  return Boolean(rows[0]?.name);
}

async function verifyRestoredContent({ databaseUrl, storageDir, keyringFile, environment, batchSize = 500, maxListed = 20 }) {
  const report = { ok: false, environment, objects: {}, columns: {}, failures: [] };
  const markerPath = path.join(storageDir, STORE_MARKER);
  const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : null;
  report.storeEnvironment = marker?.environment || null;
  if (marker && marker.environment !== environment) throw new Error(`Restored store belongs to ${marker.environment}, not ${environment}`);
  const keyring = readKeyringFile(keyringFile, { environment, strictPermissions: false });
  report.keyVersions = keyring.keys.size;
  const encryption = createMailEncryption({ keyring });
  const store = createEncryptedStore({ encryption, backend: filesystemBackend(storageDir) });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const fail = (source, id, reason) => {
    if (report.failures.length < maxListed) report.failures.push({ source, id, reason });
  };
  try {
    for (const source of OBJECT_SOURCES) {
      const label = `${source.table}.${source.key}`;
      if (!(await tableExists(client, source.table))) continue;
      const counts = (report.objects[label] = { checked: 0, ok: 0, missing: 0, integrity: 0, unavailable: 0 });
      let cursor = "";
      for (;;) {
        const { rows } = await client.query(
          `SELECT DISTINCT "${source.key}" AS key, "${source.sha}" AS sha FROM "${source.table}" WHERE "${source.key}" IS NOT NULL AND "${source.key}" > $1 ORDER BY "${source.key}" LIMIT ${Number(batchSize)}`,
          [cursor],
        );
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.key;
          counts.checked += 1;
          if (!fs.existsSync(path.join(storageDir, row.key))) {
            counts.missing += 1;
            fail(label, row.key, "missing");
            continue;
          }
          try {
            await store.get(row.key, { purpose: source.purpose, sha256: row.sha ? String(row.sha).trim() : undefined });
            counts.ok += 1;
          } catch (error) {
            if (error.code === "MAIL_STORAGE_INTEGRITY") {
              counts.integrity += 1;
              fail(label, row.key, "integrity");
            } else {
              counts.unavailable += 1;
              fail(label, row.key, error.code || "unavailable");
            }
          }
        }
      }
    }
    for (const source of COLUMN_SOURCES) {
      const label = `${source.table}.${source.column}`;
      if (!(await tableExists(client, source.table))) continue;
      const counts = (report.columns[label] = { checked: 0, ok: 0, failed: 0 });
      let cursor = "";
      for (;;) {
        const { rows } = await client.query(
          `SELECT id::text AS id, "${source.column}" AS value FROM "${source.table}" WHERE "${source.column}" IS NOT NULL AND id::text > $1 ORDER BY id::text LIMIT ${Number(batchSize)}`,
          [cursor],
        );
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.id;
          counts.checked += 1;
          try {
            encryption.decrypt(Buffer.from(row.value), source.purpose);
            counts.ok += 1;
          } catch {
            counts.failed += 1;
            fail(label, row.id, "decrypt");
          }
        }
      }
    }
  } finally {
    await client.end();
  }
  const objectProblems = Object.values(report.objects).reduce((sum, c) => sum + c.missing + c.integrity + c.unavailable, 0);
  const columnProblems = Object.values(report.columns).reduce((sum, c) => sum + c.failed, 0);
  report.objectsChecked = Object.values(report.objects).reduce((sum, c) => sum + c.checked, 0);
  report.columnsChecked = Object.values(report.columns).reduce((sum, c) => sum + c.checked, 0);
  report.ok = objectProblems === 0 && columnProblems === 0;
  return report;
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    const report = await verifyRestoredContent({
      databaseUrl: process.env.DATABASE_URL,
      storageDir: options["storage-dir"],
      keyringFile: options["keyring-file"] || process.env.MAIL_ENCRYPTION_KEYRING_FILE,
      environment: options.environment,
      maxListed: Number(options["max-failures-listed"] || 20),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  })().catch((error) => {
    process.stderr.write(`verify-restored-content: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verifyRestoredContent, OBJECT_SOURCES, COLUMN_SOURCES };
