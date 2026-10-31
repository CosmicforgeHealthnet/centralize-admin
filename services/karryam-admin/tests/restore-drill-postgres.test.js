"use strict";

// Section 9.5.4 backup/restore certification of the Karryam Admin database
// on disposable PostgreSQL: release 002 with data -> pg_dump -> 003 ->
// restore into a fresh database -> equivalence -> re-run -> idempotent.
// Requires pg_dump/pg_restore (PATH or PG_BIN). With PG_TOOLS_REQUIRED=1
// (CI) missing tools fail the test instead of skipping it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");
const { migrate, listMigrations } = require("../scripts/migrate");
const { runRestoreDrill, pgTool } = require("../../../infrastructure/product-admin/db/restore-drill");
const { seedRelease002 } = require("./helpers/seed-release-002");

const ADMIN_URL = process.env.KARRYAM_ADMIN_TEST_DATABASE_URL || "";

async function migrateTo(url, { runtimeRole, upTo }) {
  let dir;
  if (upTo) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ka-drill-mig-"));
    for (const m of listMigrations().slice(0, upTo)) fs.writeFileSync(path.join(dir, m.file), m.sql);
  }
  try { return (await migrate({ connectionString: url, runtimeRole, ...(dir ? { dir } : {}) })).applied; }
  finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}

async function verify(client) {
  const one = async (sql) => (await client.query(sql)).rows[0];
  const checks = {
    // Cursor consistency: nothing committed beyond the cursor; ACK never past it.
    cursor_consistent: (await one(`SELECT bool_and(p.acked_sequence <= p.last_sequence AND NOT EXISTS (SELECT 1 FROM karryam_admin.bridge_event_inbox i WHERE i.partition_key = p.partition_key AND i.delivery = 'FEED' AND i.sequence > p.last_sequence)) AS ok FROM karryam_admin.bridge_feed_partitions p`)).ok,
    // Event integrity: every inbox row keeps a digest; outbox contiguous; ACK within head.
    digests_present: (await one(`SELECT count(*) = 0 AS ok FROM karryam_admin.bridge_event_inbox WHERE event_digest !~ '^sha256:[0-9a-f]{64}$'`)).ok,
    outbox_contiguous: (await one(`SELECT bool_and(h.head_sequence = (SELECT count(*) FROM karryam_admin.hq_outbox o WHERE o.dataset_id = h.dataset_id AND o.partition_key = h.partition_key)) AS ok FROM karryam_admin.hq_outbox_heads h`)).ok,
    acks_within_head: (await one(`SELECT bool_and(a.acked_sequence <= h.head_sequence) AS ok FROM karryam_admin.hq_outbox_acks a JOIN karryam_admin.hq_outbox_heads h USING (dataset_id, partition_key)`)).ok,
    audit_append_only: (await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'integration_audit_no_update_delete' AND tgenabled = 'O'`)).rowCount === 1,
  };
  for (const [k, v] of Object.entries(checks)) assert.equal(v, true, k);
  return checks;
}

test("Section 9.5.4 backup/restore drill: Karryam Admin database", { timeout: 240000 }, async (t) => {
  if (!ADMIN_URL) { t.skip("KARRYAM_ADMIN_TEST_DATABASE_URL not set"); return; }
  if (!pgTool("pg_dump") || !pgTool("pg_restore")) {
    assert.notEqual(process.env.PG_TOOLS_REQUIRED, "1", "pg_dump/pg_restore are required (PG_TOOLS_REQUIRED=1) but not found");
    t.skip("pg_dump/pg_restore not installed (set PG_BIN or PATH)");
    return;
  }
  const reportPath = process.env.RESTORE_DRILL_REPORT_DIR ? path.join(process.env.RESTORE_DRILL_REPORT_DIR, "karryam-admin-restore-drill.json") : undefined;
  const report = await runRestoreDrill({
    Client, adminUrl: ADMIN_URL, schema: "karryam_admin", ledger: "karryam_admin.schema_migrations", prefix: "ka_drill",
    oldCount: 2, migrateTo, seed: (c) => seedRelease002(c), verify, reportPath,
  });
  assert.equal(report.status, "PASSED", JSON.stringify(report, null, 1).slice(0, 2000));
  const steps = Object.fromEntries(report.steps.map((s) => [s.step, s]));
  assert.deepEqual(steps.old_release_seeded.applied, ["001_karryam_admin_foundation", "002_sections_6_8_modules_and_pipeline"]);
  assert.ok(steps.pre_migration_backup.toc_entries > 0);
  assert.deepEqual(steps.forward_migration.applied, listMigrations().slice(2).map((m) => m.version));
  assert.equal(steps.restore_into_fresh_database.schema_equal, true);
  assert.equal(steps.restore_into_fresh_database.rows_equal, true);
  assert.equal(steps.restore_into_fresh_database.ledger_equal, true);
  assert.equal(steps.rerun_migrations_on_restore.schema_equal_to_migrated_source, true);
  assert.deepEqual(steps.idempotent_rerun.applied, []);
});
