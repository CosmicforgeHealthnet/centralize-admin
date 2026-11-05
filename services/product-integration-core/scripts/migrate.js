"use strict";

// Usage: PIC_MIGRATION_DATABASE_URL=... [PIC_RUNTIME_ROLE=pic_runtime] node scripts/migrate.js [--preview]
// Uses the migration credential only. The runtime role must already exist
// (provisioned by an operator); this script never creates roles or
// passwords. --preview is a read-only preflight that changes nothing.

const { Client } = require("pg");
const C = require("../../../packages/admin-contracts");
const { migrate, preview } = require("../src/db/migrate");

async function main() {
  const url = process.env.PIC_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("PIC_MIGRATION_DATABASE_URL is required (migration credential, not the runtime credential)");
  if (process.env.PIC_DATABASE_URL && process.env.PIC_DATABASE_URL === url) throw new Error("migration and runtime credentials must differ");
  const client = new Client({ connectionString: url, application_name: "product-integration-core-migrate" });
  await client.connect();
  try {
    if (process.argv.includes("--preview")) {
      const result = await preview(client, { runtimeRole: process.env.PIC_RUNTIME_ROLE || null });
      console.log(JSON.stringify({ event: "migration_preview", ...result }));
      if (!result.ok) process.exitCode = 2;
      return;
    }
    const results = await migrate(client, { runtimeRole: process.env.PIC_RUNTIME_ROLE || null, log: (e) => console.log(JSON.stringify(e)) });
    console.log(JSON.stringify({ event: "migrations_complete", results }));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "migration_failed", error: C.migrationSafety.redactUrl(err.message) }));
  process.exit(1);
});
