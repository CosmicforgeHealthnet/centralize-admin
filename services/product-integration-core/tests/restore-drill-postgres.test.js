"use strict";

// Section 9.5.4 backup/restore certification of the HQ integration schema on
// disposable PostgreSQL: release 002 with rows in all 13 table families ->
// pg_dump -> 003 -> restore into a fresh database -> equivalence -> re-run.
// Requires pg_dump/pg_restore (PATH or PG_BIN); PG_TOOLS_REQUIRED=1 (CI)
// turns missing tools into a failure.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { migrate, listMigrations } = require("../src/db/migrate");
const { runRestoreDrill, pgTool } = require("../../../infrastructure/product-admin/db/restore-drill");

const ADMIN_URL = process.env.PIC_TEST_DATABASE_URL || "";
const T = "hq_integration.";
const D = (c) => "sha256:" + c.repeat(64);

async function migrateTo(url, { runtimeRole, upTo }) {
  let dir;
  if (upTo) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-drill-mig-"));
    for (const m of listMigrations().slice(0, upTo)) fs.writeFileSync(path.join(dir, m.file), m.sql);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return (await migrate(client, { runtimeRole, ...(dir ? { dir } : {}) })).filter((r) => r.status === "APPLIED").map((r) => r.version); }
  finally { await client.end(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
}

async function seed(c) {
  const pa = randomUUID();
  const contract = randomUUID();
  const dataset = randomUUID();
  const sub = randomUUID();
  const metric = randomUUID();
  await c.query("BEGIN");
  await c.query(`INSERT INTO ${T}hq_product_admins (id, product_id, display_name, service_instance_id, environment, endpoint_ref, workload_identity, approved_signer_kid, lifecycle_status, requested_by, allowed_scope)
    VALUES ($1,'drill-product','Drill','drill-product-1','test','ep-drill','cf://test/product-admin/drill','kid-1','REQUESTED','staff-a','{"market":["NG"],"organization":["cf"]}')`, [pa]);
  await c.query(`INSERT INTO ${T}hq_product_admin_contracts (id, product_admin_id, revision, protocol_major, protocol_minor, manifest_revision, manifest_digest, catalog_digest, build_sha, catalog, status, validated_by)
    VALUES ($1,$2,1,1,1,1,$3,$4,'abcdef1','{"datasets":[]}','VALIDATED','staff-a')`, [contract, pa, D("1"), D("2")]);
  await c.query(`INSERT INTO ${T}hq_product_admin_datasets (id, product_admin_id, contract_id, dataset_id, version, schema_id, schema_digest, privacy_class, scope_dimensions, authorized_departments, semantic_grain, units, freshness_target_seconds, lineage, allowed_fields, metrics, retention_days, approval_status)
    VALUES ($1,$2,$3,'drill.orders','1.0.0','drill.orders',$4,'INTERNAL','{market}','{analytics}','DAY','{count}',3600,'{}','[]','[]',30,'PROPOSED')`, [dataset, pa, contract, D("3")]);
  await c.query(`INSERT INTO ${T}hq_product_admin_subscriptions (id, product_admin_id, dataset_row_id, consumer_department, schema_revision, schema_digest, allowed_scope, freshness_target_seconds, poll_interval_seconds, created_by)
    VALUES ($1,$2,$3,'analytics','1.0.0',$4,'{"market":["NG"]}',3600,60,'staff-a')`, [sub, pa, dataset, D("3")]);
  await c.query(`INSERT INTO ${T}hq_product_admin_sync_cursors (id, subscription_id, partition_key, last_sequence, acked_sequence, head_sequence) VALUES ($1,$2,'NG',2,2,3)`, [randomUUID(), sub]);
  for (const seq of [1, 2]) {
    await c.query(`INSERT INTO ${T}hq_product_admin_event_inbox (product_admin_id, subscription_id, contract_id, event_id, event_digest, payload_digest, family, schema_id, schema_version, dataset_id, partition_key, sequence, entity_type, entity_id, entity_version, scope, classification, payload, occurred_at, emitted_at, application)
      VALUES ($1,$2,$3,$4,$5,$6,'drill.orders.metric_observation','cosmicforge.metric-observation','1.0.0','drill.orders','NG',$7,'metric_observation','m1',$7,'{"market":"NG"}','INTERNAL','{"value":1}',now(),now(),'APPLIED')`, [pa, sub, contract, randomUUID(), D("4"), D("5"), seq]);
  }
  await c.query(`INSERT INTO ${T}hq_product_admin_metrics (id, product_admin_id, product_id, subscription_id, contract_id, dataset_id, metric_id, definition_version, definition_digest, scope_key, scope, window_start, window_end, grain, unit, value, value_state, source_observed_at, freshness, coverage, source_entity_version)
    VALUES ($1,$2,'drill-product',$3,$4,'drill.orders','drill.orders.count','1.0.0',$5,'market=NG','{"market":"NG"}','2026-10-01','2026-10-02','DAY','count',7,'OBSERVED',now(),'FRESH','COMPLETE',2)`, [metric, pa, sub, contract, D("6")]);
  await c.query(`INSERT INTO ${T}hq_product_admin_lineage (product_admin_id, metric_row_id, inbox_id, contract_id, dataset_id, operation, source_sequence, source_entity_version) SELECT $1, $2, min(id), $3, 'drill.orders', 'APPLY_EVENT', 2, 2 FROM ${T}hq_product_admin_event_inbox`, [pa, metric, contract]);
  await c.query(`INSERT INTO ${T}hq_product_admin_sync_runs (id, product_admin_id, subscription_id, partition_key, run_kind, worker_id, correlation_id, status, finished_at, events_received, events_applied) VALUES ($1,$2,$3,'NG','EVENTS','w1','corr-1','SUCCEEDED',now(),2,2)`, [randomUUID(), pa, sub]);
  await c.query(`INSERT INTO ${T}hq_product_admin_quarantine (id, product_admin_id, subscription_id, reason_code, event_digest) VALUES ($1,$2,$3,'SCHEMA_INVALID',$4)`, [randomUUID(), pa, sub, D("7")]);
  await c.query(`INSERT INTO ${T}hq_product_admin_grants (id, grant_kind, product_id, staff_id, role, effect, actions, datasets, scope, granted_by) VALUES ($1,'PRODUCT','drill-product','staff-b','drill.viewer','ALLOW','{metric.read}','{drill.orders}','{"market":["NG"],"organization":["cf"]}','staff-a')`, [randomUUID()]);
  await c.query(`INSERT INTO ${T}hq_product_admin_onboarding_approvals (product_admin_id, decision, from_status, to_status, actor_id) VALUES ($1,'TRANSITION','DRAFT','REQUESTED','staff-a')`, [pa]);
  await c.query(`INSERT INTO ${T}hq_product_admin_security_audit (actor_type, actor_id, product_id, product_admin_id, action, outcome) VALUES ('STAFF','staff-a','drill-product',$1,'integration.request','RECORDED')`, [pa]);
  await c.query("COMMIT");
}

async function verify(client) {
  const one = async (sql) => (await client.query(sql)).rows[0];
  const checks = {
    cursors_consistent: (await one(`SELECT bool_and(c.acked_sequence <= c.last_sequence AND NOT EXISTS (SELECT 1 FROM ${T}hq_product_admin_event_inbox i WHERE i.subscription_id = c.subscription_id AND i.partition_key = c.partition_key AND i.sequence > c.last_sequence)) AS ok FROM ${T}hq_product_admin_sync_cursors c`)).ok,
    lineage_resolves: (await one(`SELECT bool_and(l.inbox_id IS NULL OR EXISTS (SELECT 1 FROM ${T}hq_product_admin_event_inbox i WHERE i.id = l.inbox_id)) AS ok FROM ${T}hq_product_admin_lineage l`)).ok,
    digests_present: (await one(`SELECT count(*) = 0 AS ok FROM ${T}hq_product_admin_event_inbox WHERE event_digest !~ '^sha256:[0-9a-f]{64}$'`)).ok,
    audit_append_only: (await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'hq_product_admin_security_audit_append_only' AND tgenabled = 'O'`)).rowCount === 1,
    one_active_contract_index: (await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'hq_product_admin_contracts_one_active'`)).rowCount === 1,
  };
  for (const [k, v] of Object.entries(checks)) assert.equal(v, true, k);
  return checks;
}

test("Section 9.5.4 backup/restore drill: HQ integration schema", { timeout: 240000 }, async (t) => {
  if (!ADMIN_URL) { t.skip("PIC_TEST_DATABASE_URL not set"); return; }
  if (!pgTool("pg_dump") || !pgTool("pg_restore")) {
    assert.notEqual(process.env.PG_TOOLS_REQUIRED, "1", "pg_dump/pg_restore are required (PG_TOOLS_REQUIRED=1) but not found");
    t.skip("pg_dump/pg_restore not installed (set PG_BIN or PATH)");
    return;
  }
  const reportPath = process.env.RESTORE_DRILL_REPORT_DIR ? path.join(process.env.RESTORE_DRILL_REPORT_DIR, "hq-integration-restore-drill.json") : undefined;
  const report = await runRestoreDrill({ Client, adminUrl: ADMIN_URL, schema: "hq_integration", ledger: "hq_integration.hq_product_admin_schema_migrations", prefix: "pic_drill", oldCount: 2, migrateTo, seed, verify, reportPath });
  assert.equal(report.status, "PASSED", JSON.stringify(report, null, 1).slice(0, 2000));
  const steps = Object.fromEntries(report.steps.map((s) => [s.step, s]));
  assert.deepEqual(steps.forward_migration.applied, listMigrations().slice(2).map((m) => m.version));
  assert.equal(steps.restore_into_fresh_database.schema_equal, true);
  assert.equal(steps.restore_into_fresh_database.rows_equal, true);
  assert.equal(steps.restore_into_fresh_database.ledger_equal, true);
  assert.equal(steps.rerun_migrations_on_restore.schema_equal_to_migrated_source, true);
  assert.deepEqual(steps.idempotent_rerun.applied, []);
  // All 13 Section 9.3 table families carried data through the drill.
  const families = ["hq_product_admins", "hq_product_admin_contracts", "hq_product_admin_grants", "hq_product_admin_datasets", "hq_product_admin_subscriptions", "hq_product_admin_event_inbox", "hq_product_admin_sync_cursors",
    "hq_product_admin_metrics", "hq_product_admin_lineage", "hq_product_admin_sync_runs", "hq_product_admin_quarantine", "hq_product_admin_onboarding_approvals", "hq_product_admin_security_audit"];
  for (const f of families) assert.ok(steps.old_release_seeded.rows[f] >= 1, f);
});
