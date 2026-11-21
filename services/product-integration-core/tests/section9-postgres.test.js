"use strict";

// Section 9.3-9.5 certification of the HQ integration schema on disposable
// PostgreSQL: upgrade with a live onboarded product, the 13 table families'
// guards, concurrent contract activation, grants, privacy, retention, legal
// hold, money rules, exact runtime privileges and the read-only preview.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const I = require("../../../packages/identity-and-permissions");
const { migrate, preview, listMigrations, expectedRuntimePrivileges } = require("../src/db/migrate");
const { loadGrants } = require("../src/authz");
const { createRetention } = require("../src/retention");
const { startHarness, available } = require("./helpers/harness");
const db = require("./helpers/db");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
const rejects = (p, re) => assert.rejects(p, (e) => (re instanceof RegExp ? re.test(e.code + " " + e.message) : e.code === re) || assert.fail(`${e.code} ${e.message}`));
const T = "hq_integration.";

function olderRelease(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-mig-"));
  for (const m of listMigrations().slice(0, count)) fs.writeFileSync(path.join(dir, m.file), m.sql);
  return dir;
}

test("Section 9: HQ integration schema governance (upgrade with live data, guards, privileges)", { skip, timeout: 300000 }, async (t) => {
  const dir002 = olderRelease(2);
  const h = await startHarness({ migrationsDir: dir002 });
  t.after(async () => { await h.close(); fs.rmSync(dir002, { recursive: true, force: true }); });
  const runtime = h.pool;
  const owner = h.database.migClient;
  const q = async (sql, params) => (await owner.query(sql, params)).rows;

  let ids;
  await t.test("9.5 upgrade: a product onboarded and syncing on release 002 keeps working across 003", async () => {
    assert.deepEqual((await q(`SELECT version FROM ${T}hq_product_admin_schema_migrations ORDER BY 1`)).map((r) => r.version), ["001_product_admin_registry", "002_sync_gate_and_integrity_hold"]);
    ids = await h.registerAndEnable();
    h.product.emitMetric({ value: 10, entityVersion: 1 });
    h.product.emitMetric({ value: 12, entityVersion: 2 });
    await h.engine.tick();
    const count = async () => (await q(`SELECT (SELECT count(*) FROM ${T}hq_product_admin_event_inbox)::int AS inbox, (SELECT count(*) FROM ${T}hq_product_admin_metrics)::int AS metrics,
      (SELECT count(*) FROM ${T}hq_product_admin_onboarding_approvals)::int AS approvals, (SELECT count(*) FROM ${T}hq_product_admin_security_audit)::int AS audit,
      (SELECT last_sequence FROM ${T}hq_product_admin_sync_cursors LIMIT 1)::int AS cursor`))[0];
    const before = await count();
    assert.equal(before.inbox, 2);
    const results = await migrate(owner, { runtimeRole: h.database.runtimeRole });
    assert.deepEqual(results.filter((r) => r.status === "APPLIED").map((r) => r.version), listMigrations().slice(2).map((m) => m.version));
    assert.deepEqual(await count(), before, "no committed row is lost or added by the upgrade");
    // Sync continues on the new schema; history and cursor move forward only.
    h.product.emitMetric({ value: 15, entityVersion: 3 });
    await h.engine.tick();
    const after = await count();
    assert.equal(after.inbox, 3);
    assert.equal(after.cursor, before.cursor + 1);
    assert.deepEqual((await migrate(owner, {})).map((r) => r.status), listMigrations().map(() => "ALREADY_APPLIED"));
  });

  await t.test("9.5 ledger is append-only; preview is read-only and flags changed files", async () => {
    await rejects(owner.query(`UPDATE ${T}hq_product_admin_schema_migrations SET checksum = 'x'`), /append-only/);
    await rejects(owner.query(`DELETE FROM ${T}hq_product_admin_schema_migrations`), /append-only/);
    await rejects(runtime.query(`INSERT INTO ${T}hq_product_admin_schema_migrations (version, checksum) VALUES ('999_x', 'y')`), "42501");
    const pv = await preview(owner, { runtimeRole: h.database.runtimeRole });
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));
    assert.deepEqual(pv.pending, []);
    assert.equal(JSON.stringify(pv).includes(h.database.password), false);
    const tampered = olderRelease(listMigrations().length);
    fs.appendFileSync(path.join(tampered, listMigrations()[2].file), "\n-- edited\n");
    const bad = await preview(owner, { dir: tampered });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.changed, [listMigrations()[2].version]);
    await rejects(migrate(owner, { dir: tampered }), /migration_checksum_mismatch/);
    fs.rmSync(tampered, { recursive: true, force: true });
  });

  await t.test("9.1 runtime holds exactly the documented privileges; no DDL, no trigger bypass", async () => {
    const tables = new Set((await q(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'hq_integration' AND relkind = 'r'`)).map((r) => r.relname));
    const actual = await q(`SELECT c.relname AS t, a.privilege_type AS p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
                            WHERE n.nspname = 'hq_integration' AND r.rolname = $1 AND c.relkind = 'r' ORDER BY 1, 2`, [h.database.runtimeRole]);
    const byTable = {};
    for (const r of actual) (byTable[r.t] = byTable[r.t] || []).push(r.p);
    assert.deepEqual(byTable, expectedRuntimePrivileges(tables));
    const denied = (sql) => rejects(runtime.query(sql), "42501");
    await denied(`CREATE TABLE ${T}evil (id int)`);
    await denied(`ALTER TABLE ${T}hq_product_admin_security_audit DISABLE TRIGGER ALL`);
    await denied(`ALTER TABLE ${T}hq_product_admin_metrics OWNER TO ${h.database.runtimeRole}`);
    await denied(`TRUNCATE ${T}hq_product_admin_security_audit`);
    await denied(`DELETE FROM ${T}hq_product_admin_security_audit`);
    await denied(`DELETE FROM ${T}hq_product_admin_lineage`);
    await denied(`UPDATE ${T}hq_product_admin_onboarding_approvals SET actor_id = 'x'`);
    await denied(`SET session_replication_role = replica`);
    // Privileged runtime identities are refused by the runner.
    const su = "pic_t9_su_" + randomUUID().slice(0, 8).replace(/-/g, "");
    const admin = new Client({ connectionString: db.ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${su} SUPERUSER`);
      await rejects(migrate(owner, { runtimeRole: su }), /RUNTIME_ROLE_IS_SUPERUSER/);
      await rejects(migrate(owner, { runtimeRole: h.database.migrator }), /RUNTIME_ROLE_IS_MIGRATION_ROLE/);
    } finally { await admin.query(`DROP ROLE IF EXISTS ${su}`); await admin.end(); }
  });

  await t.test("9.3.2 / 9.4.1 exactly one of two concurrent contract activations wins; an enabled product always has its own active contract", async () => {
    const [active] = await q(`SELECT * FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [ids.id]);
    const clone = async (revision) => {
      const id = randomUUID();
      await owner.query(`INSERT INTO ${T}hq_product_admin_contracts (id, product_admin_id, revision, protocol_major, protocol_minor, manifest_revision, manifest_digest, catalog_digest, build_sha, catalog, compatibility, status, validated_by)
        SELECT $1, product_admin_id, $2, protocol_major, protocol_minor, manifest_revision, manifest_digest, 'sha256:' || md5($4) || md5($4), build_sha, catalog, compatibility, 'VALIDATED', 'staff-requester' FROM ${T}hq_product_admin_contracts WHERE id = $3`, [id, revision, active.id, id]);
      await owner.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'CERTIFIED', certified_by = 'staff-reviewer', certified_at = now() WHERE id = $1`, [id]);
      return id;
    };
    // An unreviewed revision cannot jump to ACTIVE, and certification needs a second person.
    const raw = randomUUID();
    await owner.query(`INSERT INTO ${T}hq_product_admin_contracts (id, product_admin_id, revision, protocol_major, protocol_minor, manifest_revision, manifest_digest, catalog_digest, build_sha, catalog, compatibility, status, validated_by)
      SELECT $1, product_admin_id, 90, protocol_major, protocol_minor, manifest_revision, manifest_digest, 'sha256:' || md5($3) || md5($3), build_sha, catalog, compatibility, 'VALIDATED', 'staff-requester' FROM ${T}hq_product_admin_contracts WHERE id = $2`, [raw, active.id, raw]);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [raw]), /not permitted/);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'CERTIFIED', certified_by = 'staff-requester', certified_at = now() WHERE id = $1`, [raw]), /hq_product_admin_contracts_certified/);
    // Superseding the active contract without moving the product fails at commit.
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'SUPERSEDED' WHERE id = $1`, [active.id]), /must reference its own active certified contract/);

    const [c1, c2] = [await clone(91), await clone(92)];
    // Both transactions start and observe the same active contract before either writes.
    let arrived = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const activate = async (contractId) => {
      const client = await runtime.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT id FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [ids.id]);
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'SUPERSEDED' WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [ids.id]);
        await client.query(`UPDATE ${T}hq_product_admin_contracts SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [contractId]);
        await client.query(`UPDATE ${T}hq_product_admins SET current_contract_id = $2 WHERE id = $1`, [ids.id, contractId]);
        await client.query("COMMIT");
        return "ACTIVATED";
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        return err.code;
      } finally { client.release(); }
    };
    const outcomes = await Promise.all([activate(c1), activate(c2)]);
    assert.equal(outcomes.filter((o) => o === "ACTIVATED").length, 1, JSON.stringify(outcomes));
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${T}hq_product_admin_contracts WHERE product_admin_id = $1 AND status = 'ACTIVE'`, [ids.id]))[0].n, 1);
    const [p] = await q(`SELECT p.current_contract_id = c.id AS consistent FROM ${T}hq_product_admins p JOIN ${T}hq_product_admin_contracts c ON c.product_admin_id = p.id AND c.status = 'ACTIVE' WHERE p.id = $1`, [ids.id]);
    assert.equal(p.consistent, true);
  });

  await t.test("9.3.4 subscriptions: approved dataset of the same product, scope inside the product scope, identity immutable", async () => {
    const [sub] = await q(`SELECT * FROM ${T}hq_product_admin_subscriptions WHERE id = $1`, [ids.subscriptionId]);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_subscriptions SET allowed_scope = '{"market":["NG","GH"]}' WHERE id = $1`, [sub.id]), /immutable/);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_subscriptions SET dataset_row_id = gen_random_uuid() WHERE id = $1`, [sub.id]), /immutable/);
    await rejects(runtime.query(`DELETE FROM ${T}hq_product_admin_subscriptions`), /append-only|42501/);
    // A proposed (unapproved) dataset version cannot be synchronized by a database update alone.
    const proposed = randomUUID();
    await owner.query(`INSERT INTO ${T}hq_product_admin_datasets (id, product_admin_id, contract_id, dataset_id, version, schema_id, schema_digest, privacy_class, scope_dimensions, authorized_departments, semantic_grain, units, currency, freshness_target_seconds, lineage, allowed_fields, metrics, retention_days, approval_status)
      SELECT $1, product_admin_id, contract_id, dataset_id, '9.9.9', schema_id, schema_digest, privacy_class, scope_dimensions, authorized_departments, semantic_grain, units, currency, freshness_target_seconds, lineage, allowed_fields, metrics, retention_days, 'PROPOSED' FROM ${T}hq_product_admin_datasets WHERE id = $2`, [proposed, sub.dataset_row_id]);
    const insert = (datasetRow, scope, enabled = true, productAdminId = ids.id) => runtime.query(
      `INSERT INTO ${T}hq_product_admin_subscriptions (id, product_admin_id, dataset_row_id, consumer_department, schema_revision, schema_digest, allowed_scope, freshness_target_seconds, poll_interval_seconds, enabled, created_by)
       VALUES ($1,$2,$3,'finance','9.9.9',$4,$5,3600,60,$6,'staff-requester')`, [randomUUID(), productAdminId, datasetRow, sub.schema_digest, JSON.stringify(scope), enabled]);
    await rejects(insert(proposed, { market: ["NG"] }), /approved, HQ-syncable dataset/);
    await rejects(insert(proposed, { market: ["ZA"] }, false), /exceeds the approved product scope/);
    await rejects(insert(proposed, { market: [] }, false), /exceeds the approved product scope/);
    await insert(proposed, { market: ["NG"] }, false);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_subscriptions SET enabled = true WHERE dataset_row_id = $1`, [proposed]), /approved, HQ-syncable dataset/);
    // A restricted dataset can never be approved.
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_datasets SET approval_status = 'APPROVED', approved_by = 'staff-reviewer', approved_at = now(), privacy_class = 'RESTRICTED_PII' WHERE id = $1`, [proposed]), /immutable|no_restricted/);
  });

  await t.test("9.3.3 grants: effective date, expiry and revocation all apply; explicit deny wins", async () => {
    const grant = (over) => runtime.query(`INSERT INTO ${T}hq_product_admin_grants (id, grant_kind, product_id, staff_id, role, effect, actions, datasets, scope, granted_by, not_before, expires_at) VALUES ($1,'PRODUCT',$2,$3,'synthetic.viewer',$4,'{metric.read}',$5,'{"market":["NG"],"organization":["cosmicforge"]}','staff-requester',$6,$7)`,
      [randomUUID(), h.product.PRODUCT_ID, over.staff, over.effect || "ALLOW", [h.product.DATASET_ID], over.notBefore || null, over.expiresAt || null]);
    await grant({ staff: "staff-future", notBefore: new Date(Date.now() + 3600000) });
    await grant({ staff: "staff-expired", expiresAt: new Date(Date.now() - 1000), notBefore: new Date(Date.now() - 7200000) });
    await grant({ staff: "staff-now", notBefore: new Date(Date.now() - 1000) });
    await grant({ staff: "staff-now", effect: "DENY" });
    await rejects(grant({ staff: "staff-window", notBefore: new Date(Date.now() + 2000), expiresAt: new Date(Date.now() + 1000) }), /validity_window/);
    const decide = async (staff) => I.authorize({ subject: { staffId: staff }, productId: h.product.PRODUCT_ID, action: "metric.read", datasetId: h.product.DATASET_ID, requestedScope: { market: ["NG"] }, grants: await loadGrants(runtime, staff) });
    assert.equal((await decide("staff-future")).allowed, false);
    assert.equal((await decide("staff-expired")).reason, "GRANT_EXPIRED");
    assert.equal((await decide("staff-now")).reason, "EXPLICIT_DENY");
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_grants SET revoked_at = now(), revoked_by = 'staff-now', revocation_reason = 'SELF' WHERE staff_id = 'staff-now' AND effect = 'DENY'`), /no_self_revoke/);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_grants SET scope = '{"market":["GH"],"organization":["cosmicforge"]}' WHERE staff_id = 'staff-future'`), /immutable/);
  });

  await t.test("9.4.7 / 11.4 prohibited fields never enter the HQ inbox or quarantine detail", async () => {
    const [ev] = await q(`SELECT * FROM ${T}hq_product_admin_event_inbox ORDER BY id LIMIT 1`);
    for (const field of ["nin", "otp", "password", "card_number", "latitude", "medical_record", "NIN"]) {
      await rejects(runtime.query(`INSERT INTO ${T}hq_product_admin_event_inbox (product_admin_id, subscription_id, contract_id, event_id, event_digest, payload_digest, family, schema_id, schema_version, dataset_id, partition_key, sequence, entity_type, entity_id, entity_version, scope, classification, payload, occurred_at, emitted_at, application)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,9000,$12,$13,1,'{}','INTERNAL',$14,now(),now(),'NO_PROJECTION')`,
      [ev.product_admin_id, ev.subscription_id, ev.contract_id, randomUUID(), ev.event_digest, ev.payload_digest, ev.family, ev.schema_id, ev.schema_version, ev.dataset_id, ev.partition_key, ev.entity_type, ev.entity_id, JSON.stringify({ [field]: "x" })]), /no_prohibited_field/);
    }
    await rejects(runtime.query(`INSERT INTO ${T}hq_product_admin_event_inbox (product_admin_id, subscription_id, contract_id, event_id, event_digest, payload_digest, family, schema_id, schema_version, dataset_id, partition_key, sequence, entity_type, entity_id, entity_version, scope, classification, payload, occurred_at, emitted_at, application)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,9001,$12,$13,1,'{}','RESTRICTED_PII','{}',now(),now(),'NO_PROJECTION')`,
    [ev.product_admin_id, ev.subscription_id, ev.contract_id, randomUUID(), ev.event_digest, ev.payload_digest, ev.family, ev.schema_id, ev.schema_version, ev.dataset_id, ev.partition_key, ev.entity_type, ev.entity_id]), /classification_check/);
    await rejects(runtime.query(`INSERT INTO ${T}hq_product_admin_quarantine (id, product_admin_id, reason_code, detail) VALUES ($1,$2,'SCHEMA_INVALID','{"otp":"123456"}')`, [randomUUID(), ids.id]), /quarantine_detail/);
  });

  await t.test("9.4.8 retention clears payloads but never under legal hold; evidence stays", async () => {
    const retention = createRetention(runtime);
    await owner.query(`ALTER TABLE ${T}hq_product_admin_event_inbox DISABLE TRIGGER hq_product_admin_event_inbox_guard`);
    await owner.query(`UPDATE ${T}hq_product_admin_event_inbox SET received_at = received_at - interval '3650 days'`); // age the rows (operator-only test setup)
    await owner.query(`ALTER TABLE ${T}hq_product_admin_event_inbox ENABLE TRIGGER hq_product_admin_event_inbox_guard`);
    const [held] = await q(`SELECT entity_type, entity_id FROM ${T}hq_product_admin_event_inbox ORDER BY id LIMIT 1`);
    await rejects(retention.placeLegalHold({ productAdminId: ids.id, reasonCode: "LITIGATION", caseReference: "L-1", placedBy: "c-1", approvedBy: "c-1" }), /INDEPENDENT_APPROVER/);
    const holdId = await retention.placeLegalHold({ productAdminId: ids.id, entityType: held.entity_type, entityId: held.entity_id, reasonCode: "LITIGATION", caseReference: "L-1", placedBy: "c-1", approvedBy: "c-2" });
    const [r] = await Promise.all([retention.clearExpiredInboxPayloads(), retention.placeLegalHold({ productAdminId: ids.id, datasetId: "other.dataset", reasonCode: "AUDIT", caseReference: "A-2", placedBy: "c-3", approvedBy: "c-4" })]);
    const rows = await q(`SELECT entity_id, payload IS NOT NULL AS has_payload, payload_cleared_reason, event_digest IS NOT NULL AS has_digest FROM ${T}hq_product_admin_event_inbox`);
    assert.ok(rows.every((x) => x.has_digest));
    assert.ok(rows.filter((x) => x.entity_id === held.entity_id).every((x) => x.has_payload), "held entity keeps its payload");
    assert.equal(r.cleared, rows.filter((x) => x.entity_id !== held.entity_id).length);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_event_inbox SET payload = NULL, payload_cleared_at = now(), payload_cleared_reason = 'RETENTION' WHERE entity_id = $1`, [held.entity_id]), /legal hold/);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_event_inbox SET partition_key = 'moved' WHERE id = (SELECT min(id) FROM ${T}hq_product_admin_event_inbox)`), /immutable/);
    await rejects(runtime.query(`DELETE FROM ${T}hq_product_admin_event_inbox`), /42501|append-only/);
    await retention.releaseLegalHold({ id: holdId, releasedBy: "c-2", releaseReason: "CASE_CLOSED" });
    await rejects(retention.releaseLegalHold({ id: holdId, releasedBy: "c-2", releaseReason: "CASE_CLOSED" }), /HOLD_NOT_ACTIVE/);
    assert.ok((await retention.clearExpiredInboxPayloads()).cleared >= 1);
  });

  await t.test("9.4.5 / 9.3.6 money and counts: currency required, whole minor units, null is not zero", async () => {
    const [m] = await q(`SELECT * FROM ${T}hq_product_admin_metrics LIMIT 1`);
    const ins = (unit, currency, value, state = "OBSERVED") => runtime.query(
      `INSERT INTO ${T}hq_product_admin_metrics (id, product_admin_id, product_id, subscription_id, contract_id, dataset_id, metric_id, definition_version, definition_digest, scope_key, scope, window_start, window_end, grain, unit, currency, value, value_state, source_observed_at, freshness, coverage, source_entity_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'1.0.0',$8,$9,'{}','2026-01-01','2026-01-02','DAY',$10,$11,$12,$13,CASE WHEN $13 = 'OBSERVED' THEN now() END,'FRESH','COMPLETE',1)`,
      [randomUUID(), m.product_admin_id, m.product_id, m.subscription_id, m.contract_id, m.dataset_id, "t." + randomUUID().slice(0, 8), m.definition_digest, m.scope_key, unit, currency, value, state]);
    await ins("minor_currency", "NGN", "99999999999999999999999999.0");
    await rejects(ins("minor_currency", null, "100"), /minor_currency/);
    await rejects(ins("minor_currency", "NGN", "100.25"), /minor_currency/);
    await rejects(ins("count", null, "2.5"), /count_whole/);
    await rejects(ins("count", null, null), /observed/);
    await rejects(ins("count", null, "0", "UNAVAILABLE"), /observed/);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_metrics SET currency = 'USD', source_entity_version = source_entity_version + 1 WHERE id = $1`, [m.id]), /immutable/);
  });

  await t.test("9.3.10 / 9.3.11 sync runs and quarantine evidence are immutable once recorded", async () => {
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_sync_runs SET status = 'FAILED' WHERE finished_at IS NOT NULL`), /finished sync runs are immutable/);
    const qid = randomUUID();
    await runtime.query(`INSERT INTO ${T}hq_product_admin_quarantine (id, product_admin_id, reason_code, event_digest, detail) VALUES ($1,$2,'SCHEMA_INVALID',$3,'{"field":"value"}')`, [qid, ids.id, "sha256:" + "a".repeat(64)]);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_quarantine SET event_digest = $2 WHERE id = $1`, [qid, "sha256:" + "b".repeat(64)]), /immutable/);
    await runtime.query(`UPDATE ${T}hq_product_admin_quarantine SET resolved_at = now(), resolved_by = 'op-1', resolution = 'OPERATOR_REVIEWED' WHERE id = $1`, [qid]);
    await rejects(runtime.query(`UPDATE ${T}hq_product_admin_quarantine SET resolved_at = NULL, resolved_by = NULL, resolution = NULL WHERE id = $1`, [qid]), /immutable/);
    await rejects(runtime.query(`DELETE FROM ${T}hq_product_admin_quarantine WHERE id = $1`, [qid]), /append-only|42501/);
  });

  await t.test("9.4.10 representative HQ query plans use the intended indexes", async () => {
    await owner.query(`INSERT INTO ${T}hq_product_admin_grants (id, grant_kind, product_id, staff_id, role, effect, actions, datasets, scope, granted_by)
      SELECT gen_random_uuid(), 'PRODUCT', $1, 'bulk-staff-' || g, 'r.viewer', 'ALLOW', '{metric.read}', '{}', '{"market":["NG"],"organization":["cosmicforge"]}', 'operator-bulk' FROM generate_series(1, 20000) g`, [h.product.PRODUCT_ID]);
    await owner.query(`INSERT INTO ${T}hq_product_admin_event_inbox (product_admin_id, subscription_id, contract_id, event_id, event_digest, payload_digest, family, schema_id, schema_version, dataset_id, partition_key, sequence, entity_type, entity_id, entity_version, scope, classification, payload, occurred_at, emitted_at, application)
      SELECT product_admin_id, subscription_id, contract_id, gen_random_uuid(), event_digest, payload_digest, family, schema_id, schema_version, dataset_id, 'bulk-partition', g, entity_type, 'bulk-' || g, 1, scope, classification, '{}', occurred_at, emitted_at, 'NO_PROJECTION'
      FROM ${T}hq_product_admin_event_inbox, generate_series(1, 20000) g WHERE id = (SELECT min(id) FROM ${T}hq_product_admin_event_inbox)`);
    await owner.query(`ANALYZE ${T}hq_product_admin_grants; ANALYZE ${T}hq_product_admin_event_inbox`);
    const [{ "QUERY PLAN": [plan] }] = await q(`EXPLAIN (FORMAT JSON) SELECT * FROM ${T}hq_product_admin_grants WHERE staff_id = 'bulk-staff-77'`);
    const indexOf = (node) => node["Index Name"] || (node.Plans || []).map(indexOf).find(Boolean) || null;
    assert.equal(indexOf(plan.Plan), "hq_product_admin_grants_staff_all_idx");
    const [{ "QUERY PLAN": [plan2] }] = await q(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${T}hq_product_admin_event_inbox WHERE product_admin_id = $1 AND event_id = $2`, [ids.id, randomUUID()]);
    assert.equal(indexOf(plan2.Plan), "hq_product_admin_event_inbox_event_uq");
  });
});
