"use strict";

// Section 9 database certification for Karryam Admin on disposable
// PostgreSQL (KARRYAM_ADMIN_TEST_DATABASE_URL, superuser on a throwaway
// server). Covers the 001/002 -> 003 upgrade with existing data, migration
// discipline, exact runtime privileges, and the governance constraints.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Client } = require("pg");
const { migrate, preview, listMigrations, expectedRuntimePrivileges } = require("../scripts/migrate");
const { createPipelineStore } = require("../src/sync/store");
const { createGovernanceStore } = require("../src/db/governance");
const { pgApprovals } = require("../src/db/approvals");
const R = require("../src/bridge/contracts/registry");
const { ADMIN_URL, createDisposable } = require("./helpers/pgdb");
const { outboxEvent, seedRelease002 } = require("./helpers/seed-release-002");

const sha = (s) => "sha256:" + createHash("sha256").update(String(s)).digest("hex");
const hex = (s) => createHash("sha256").update(String(s)).digest("hex");
const rejects = (p, re) => assert.rejects(p, (e) => (re instanceof RegExp ? re.test(e.message) : e.code === re) || assert.fail(`${e.code} ${e.message}`));

test("Section 9: Karryam Admin database governance on disposable PostgreSQL", { timeout: 240000 }, async (t) => {
  if (!ADMIN_URL) { t.skip("KARRYAM_ADMIN_TEST_DATABASE_URL not set"); return; }
  const d = await createDisposable();
  t.after(() => d.drop());
  const owner = await d.owner();
  const q = async (sql, params) => (await owner.query(sql, params)).rows;

  let seeded;
  await t.test("9.5 upgrade path: release 002 with existing data -> 003, then idempotent re-run", async () => {
    const r002 = await migrate({ connectionString: d.migrationUrl, runtimeRole: d.runtime, dir: d.migrationsUpTo(2) });
    assert.deepEqual(r002.applied, ["001_karryam_admin_foundation", "002_sections_6_8_modules_and_pipeline"]);
    seeded = await seedRelease002(owner);
    const before = await q(`SELECT (SELECT count(*) FROM karryam_admin.bridge_event_inbox)::int AS inbox, (SELECT count(*) FROM karryam_admin.hq_outbox)::int AS outbox, (SELECT count(*) FROM karryam_admin.integration_audit)::int AS audit`);
    const r003 = await migrate({ connectionString: d.migrationUrl, runtimeRole: d.runtime });
    assert.deepEqual(r003.applied, listMigrations().slice(2).map((m) => m.version));
    const after = await q(`SELECT (SELECT count(*) FROM karryam_admin.bridge_event_inbox)::int AS inbox, (SELECT count(*) FROM karryam_admin.hq_outbox)::int AS outbox, (SELECT count(*) FROM karryam_admin.integration_audit)::int AS audit`);
    assert.deepEqual(after, before, "no row is lost or added by the upgrade");
    // Backfilled defaults and materialized columns.
    const [m] = await q(`SELECT unit, grain, definition_version, currency FROM karryam_admin.metric_snapshots`);
    assert.deepEqual(m, { unit: "count", grain: "DAY", definition_version: "1.0.0", currency: null });
    const [o] = await q(`SELECT schema_id, classification FROM karryam_admin.hq_outbox`);
    assert.deepEqual(o, { schema_id: "cosmicforge.metric-observation", classification: "INTERNAL" });
    const [qr] = await q(`SELECT occurrences FROM karryam_admin.event_quarantine`);
    assert.equal(qr.occurrences, 1);
    assert.equal((await q(`SELECT count(*)::int AS n FROM karryam_admin.retention_policies`))[0].n, 7);
    const again = await migrate({ connectionString: d.migrationUrl, runtimeRole: d.runtime });
    assert.deepEqual(again.applied, []);
    const ledger = await q(`SELECT version, checksum FROM karryam_admin.schema_migrations ORDER BY version`);
    assert.deepEqual(ledger.map((r) => [r.version, r.checksum]), listMigrations().map((x) => [x.version, x.checksum]));
  });

  await t.test("9.5 ledger immutability, changed-checksum refusal and preview without side effects", async () => {
    await rejects(owner.query(`UPDATE karryam_admin.schema_migrations SET checksum = 'x'`), /not permitted/);
    await rejects(owner.query(`DELETE FROM karryam_admin.schema_migrations`), /not permitted/);
    await rejects(owner.query(`TRUNCATE karryam_admin.schema_migrations`), /not permitted/);
    const runtime = d.pool();
    await rejects(runtime.query(`INSERT INTO karryam_admin.schema_migrations (version, checksum) VALUES ('999_x','y')`), "42501");
    const tampered = d.migrationsUpTo(listMigrations().length);
    const last = listMigrations().at(-1);
    fs.appendFileSync(path.join(tampered, last.file), "\n-- edited after apply\n");
    await rejects(migrate({ connectionString: d.migrationUrl, dir: tampered }), new RegExp("APPLIED_MIGRATION_CHANGED:" + last.version));
    const pv = await preview({ connectionString: d.migrationUrl, runtimeRole: d.runtime, dir: tampered });
    assert.equal(pv.ok, false);
    assert.deepEqual(pv.changed, [last.version]);
    const clean = await preview({ connectionString: d.migrationUrl, runtimeRole: d.runtime });
    assert.equal(clean.ok, true, JSON.stringify(clean.errors));
    assert.deepEqual(clean.pending, []);
    assert.equal(clean.backup_required, false);
    assert.equal(JSON.stringify(clean).includes(d.password), false, "credentials never appear in preview output");
  });

  await t.test("9.5 preview of a fresh database lists pending work and changes nothing", async () => {
    const fresh = "ka_t9_fresh_" + randomUUID().slice(0, 8).replace(/-/g, "");
    await d.database(fresh);
    const url = d.url(fresh, d.migrator);
    const pv = await preview({ connectionString: url, runtimeRole: d.runtime });
    assert.deepEqual(pv.pending.map((p) => p.version), listMigrations().map((m) => m.version));
    assert.equal(pv.backup_required, true);
    assert.ok(pv.pending.find((p) => p.version === "003_section_9_data_governance").counts.TABLE_REWRITE >= 1, "the hq_outbox rewrite is surfaced for review");
    assert.deepEqual(pv.pending.flatMap((p) => p.blocking), []);
    const c = new Client({ connectionString: url });
    await c.connect();
    const { rows: [s] } = await c.query(`SELECT to_regnamespace('karryam_admin') AS ns`);
    await c.end();
    assert.equal(s.ns, null, "preview created nothing");
  });

  await t.test("9.5 concurrent runs serialize on the advisory lock; an interrupted migration leaves nothing behind", async () => {
    const fresh = "ka_t9_conc_" + randomUUID().slice(0, 8).replace(/-/g, "");
    await d.database(fresh);
    const url = d.url(fresh, d.migrator);
    const [a, b] = await Promise.all([migrate({ connectionString: url }), migrate({ connectionString: url })]);
    assert.equal(a.applied.length + b.applied.length, listMigrations().length, "each migration applied exactly once");
    // A failing migration rolls back completely and is not recorded.
    const dir = d.migrationsUpTo(listMigrations().length);
    fs.writeFileSync(path.join(dir, "998_broken.sql"), "CREATE TABLE karryam_admin.half_done (id int);\nSELECT 1/0;\n");
    await rejects(migrate({ connectionString: url, dir }), /MIGRATION_FAILED:998_broken/);
    const c = new Client({ connectionString: url });
    await c.connect();
    const { rows: [r] } = await c.query(`SELECT to_regclass('karryam_admin.half_done') AS t, (SELECT count(*)::int FROM karryam_admin.schema_migrations WHERE version = '998_broken') AS n`);
    await c.end();
    assert.deepEqual(r, { t: null, n: 0 });
    // Fixed file, re-run: applied once.
    fs.writeFileSync(path.join(dir, "998_broken.sql"), "CREATE TABLE karryam_admin.half_done (id int);\n");
    assert.deepEqual((await migrate({ connectionString: url, dir })).applied, ["998_broken"]);
  });

  await t.test("9.1 role separation: runtime holds exactly the documented privileges and nothing else", async () => {
    const actual = await q(`SELECT c.relname AS t, a.privilege_type AS p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
                            WHERE n.nspname = 'karryam_admin' AND r.rolname = $1 AND c.relkind = 'r' ORDER BY 1, 2`, [d.runtime]);
    const byTable = {};
    for (const r of actual) (byTable[r.t] = byTable[r.t] || []).push(r.p);
    const tables = new Set((await q(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'karryam_admin' AND relkind = 'r'`)).map((r) => r.relname));
    assert.deepEqual(byTable, expectedRuntimePrivileges(tables));
    const [attrs] = await q(`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1`, [d.runtime]);
    assert.deepEqual(attrs, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    const [mig] = await q(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
    assert.equal(mig.rolsuper, false, "migrations run without superuser");
    assert.equal((await q(`SELECT count(*)::int AS n FROM pg_default_acl`))[0].n, 0, "no default privileges");
    assert.deepEqual(await q(`SELECT has_schema_privilege($1, 'karryam_admin', 'CREATE') AS c, has_schema_privilege($1, 'public', 'CREATE') AS p`, [d.runtime]), [{ c: false, p: false }]);

    const runtime = d.pool();
    const denied = (sql) => rejects(runtime.query(sql), "42501");
    await denied(`CREATE TABLE karryam_admin.evil (id int)`);
    await denied(`CREATE TABLE public.evil (id int)`);
    await denied(`CREATE SCHEMA evil`);
    await denied(`DROP SCHEMA karryam_admin CASCADE`);
    await denied(`ALTER TABLE karryam_admin.integration_audit DISABLE TRIGGER integration_audit_no_update_delete`);
    await denied(`ALTER TABLE karryam_admin.hq_outbox DISABLE TRIGGER ALL`);
    await denied(`ALTER TABLE karryam_admin.hq_outbox OWNER TO ${d.runtime}`);
    await denied(`TRUNCATE karryam_admin.integration_audit`);
    await denied(`TRUNCATE karryam_admin.bridge_event_inbox`);
    await denied(`DELETE FROM karryam_admin.integration_audit`);
    await denied(`DELETE FROM karryam_admin.sensitive_access_log`);
    await denied(`UPDATE karryam_admin.hq_outbox SET family = 'x'`);
    await denied(`UPDATE karryam_admin.retention_policies SET retention_days = 1`);
    await denied(`SET session_replication_role = replica`);
    // Cross-database: no CONNECT on another database.
    const other = "ka_t9_other_" + randomUUID().slice(0, 8).replace(/-/g, "");
    await d.database(other);
    const c = new Client({ connectionString: d.url(other, d.runtime) });
    await rejects(c.connect(), "42501");
  });

  await t.test("9.1 the runner refuses privileged or shared identities", async () => {
    const su = await d.role("ka_t9_su_" + randomUUID().slice(0, 6).replace(/-/g, ""), "SUPERUSER");
    await rejects(migrate({ connectionString: d.migrationUrl, runtimeRole: su }), /RUNTIME_ROLE_IS_SUPERUSER/);
    const cr = await d.role("ka_t9_cr_" + randomUUID().slice(0, 6).replace(/-/g, ""), "CREATEROLE");
    await rejects(migrate({ connectionString: d.migrationUrl, runtimeRole: cr }), /RUNTIME_ROLE_CAN_CREATE_ROLES/);
    await rejects(migrate({ connectionString: d.migrationUrl, runtimeRole: d.migrator }), /RUNTIME_ROLE_IS_MIGRATION_ROLE/);
    await rejects(migrate({ connectionString: d.migrationUrl, runtimeConnectionString: d.migrationUrl }), /RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER/);
  });

  const runtime = d.pool(undefined, 6);
  const store = createPipelineStore(runtime, { serviceInstanceId: "karryam-admin.test" });
  const gov = createGovernanceStore(runtime);

  await t.test("9.4.4 a source entity never moves into another tenant's projection", async () => {
    const A = { market: "NG-LAGOS", organization: "karryam-ng", zone: "lagos-mainland", tenant: "tenant-a" };
    const B = { ...A, tenant: "tenant-b" };
    const [ka, kb] = await store.ensurePartitions([A, B], "ka.c");
    const la = await store.acquireLease(ka, "w1", 60);
    const lb = await store.acquireLease(kb, "w1", 60);
    const event = (scope, sequence, version, id = randomUUID()) => ({
      event_id: id, sequence, event_type: "support.case.changed.v1", source_service: "support-dispute-service", entity_type: "support_case", entity_ref: "shared-ref",
      entity_version: version, tombstone: false, classification: "INTERNAL", market: scope.market, scope: { organization: scope.organization, zone: scope.zone, tenant: scope.tenant },
      occurred_at: new Date().toISOString(), emitted_at: new Date().toISOString(),
    });
    const ea = event(A, 1, 1);
    assert.equal(await store.applyEvent(ka, "w1", la.lease_token, ea, { digest: sha(ea.event_id), payload: { status: "OPEN" } }, { contractRevision: hex("rev") }), "APPLIED");
    const eb = event(B, 1, 5);
    assert.equal(await store.applyEvent(kb, "w1", lb.lease_token, eb, { digest: sha(eb.event_id), payload: { status: "CLOSED" } }, { contractRevision: hex("rev") }), "SCOPE_CONFLICT");
    const [p] = await q(`SELECT partition_key, entity_version, payload FROM karryam_admin.entity_projections WHERE entity_ref = 'shared-ref'`);
    assert.deepEqual(p, { partition_key: ka, entity_version: "1", payload: { status: "OPEN" } });
    const [qr] = await q(`SELECT reason FROM karryam_admin.event_quarantine WHERE partition_key = $1`, [kb]);
    assert.equal(qr.reason, "ENTITY_SCOPE_CONFLICT");
    const [cur] = await q(`SELECT last_sequence, hold_sequence FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1`, [kb]);
    assert.deepEqual(cur, { last_sequence: "1", hold_sequence: null }, "feed continues; the conflict is evidence, not a block");
    // Database backstop even for a direct write.
    await rejects(runtime.query(`UPDATE karryam_admin.entity_projections SET partition_key = $1, entity_version = 9 WHERE entity_ref = 'shared-ref'`, [kb]), /immutable/);
    await rejects(runtime.query(`UPDATE karryam_admin.entity_projections SET entity_version = 1 WHERE entity_ref = 'shared-ref'`), /must increase/);
    await rejects(runtime.query(`DELETE FROM karryam_admin.entity_projections`), "42501");
  });

  await t.test("9.4.5 exact money and count storage; null is never zero; definitions never change", async () => {
    const P = seeded.partition;
    const ins = (metric, unit, currency, value, state = "OBSERVED") => runtime.query(
      `INSERT INTO karryam_admin.metric_snapshots (metric_id, partition_key, window_start, window_end, value, value_state, coverage, observed_at, entity_version, unit, currency)
       VALUES ($1,$2,'2026-10-01','2026-10-02',$3,$4,'COMPLETE',CASE WHEN $4 = 'OBSERVED' THEN now() END,1,$5,$6)`, [metric, P, value, state, unit, currency]);
    await ins("t.money.ok", "minor_currency", "NGN", "123456789012345678901234567890");
    const [big] = await q(`SELECT value::text AS v FROM karryam_admin.metric_snapshots WHERE metric_id = 't.money.ok'`);
    assert.equal(big.v, "123456789012345678901234567890", "no floating-point rounding");
    await rejects(ins("t.money.nocur", "minor_currency", null, "100"), /metric_snapshot_currency_unit/);
    await rejects(ins("t.money.frac", "minor_currency", "NGN", "100.5"), /metric_snapshot_minor_units_whole/);
    await rejects(ins("t.count.cur", "count", "NGN", "1"), /metric_snapshot_currency_unit/);
    await rejects(ins("t.count.neg", "count", null, "-1"), /metric_snapshot_count_whole/);
    await rejects(ins("t.null.observed", "count", null, null), /metric_observed_has_value/);
    await rejects(ins("t.zero.unavailable", "count", null, "0", "UNAVAILABLE"), /metric_observed_has_value/);
    await ins("t.unavailable", "count", null, null, "UNAVAILABLE");
    await rejects(runtime.query(`UPDATE karryam_admin.metric_snapshots SET currency = 'USD', entity_version = 2 WHERE metric_id = 't.money.ok'`), /immutable/);
    await rejects(runtime.query(`UPDATE karryam_admin.metric_snapshots SET unit = 'minor_currency', currency = 'NGN', value = 1, value_state = 'OBSERVED', observed_at = now(), entity_version = 2 WHERE metric_id = 't.unavailable'`), /immutable/);
    await rejects(runtime.query(`UPDATE karryam_admin.metric_snapshots SET value = 5, entity_version = 1 WHERE metric_id = 't.money.ok'`), /must increase/);
  });

  await t.test("9.4.6 outbox, ACK, quarantine, gaps and sync-run guards", async () => {
    const P = seeded.partition;
    const ds = "karryam.support_operations";
    // Outbox: only syncable classifications, and the stored identity must match the event body.
    await runtime.query(`UPDATE karryam_admin.hq_outbox_heads SET head_sequence = 2 WHERE dataset_id = $1 AND partition_key = $2`, [ds, P]);
    const restricted = outboxEvent({ datasetId: ds, partitionKey: P, sequence: 2, classification: "RESTRICTED_PII" });
    await rejects(runtime.query(`INSERT INTO karryam_admin.hq_outbox (dataset_id, partition_key, sequence, event_id, family, event, payload_digest) VALUES ($1,$2,2,$3,$4,$5,$6)`,
      [ds, P, restricted.event_id, restricted.family, JSON.stringify(restricted), restricted.payload_digest]), /hq_outbox_classification_syncable/);
    const mismatched = outboxEvent({ datasetId: ds, partitionKey: P, sequence: 2 });
    await rejects(runtime.query(`INSERT INTO karryam_admin.hq_outbox (dataset_id, partition_key, sequence, event_id, family, event, payload_digest) VALUES ($1,$2,3,$3,$4,$5,$6)`,
      [ds, P, mismatched.event_id, mismatched.family, JSON.stringify(mismatched), mismatched.payload_digest]), /hq_outbox_event_identity/);
    // ACKs: never beyond the head, never backwards, never for an unknown partition.
    await rejects(runtime.query(`UPDATE karryam_admin.hq_outbox_acks SET acked_sequence = 3 WHERE consumer = 'hq-pic'`), /beyond the committed outbox head/);
    await rejects(runtime.query(`UPDATE karryam_admin.hq_outbox_acks SET acked_sequence = 0 WHERE consumer = 'hq-pic'`), /regress/);
    await rejects(runtime.query(`INSERT INTO karryam_admin.hq_outbox_acks (consumer, dataset_id, partition_key, acked_sequence) VALUES ('hq-other', $1, $2, 5)`, [ds, P]), /beyond/);
    await rejects(runtime.query(`INSERT INTO karryam_admin.hq_outbox_acks (consumer, dataset_id, partition_key, acked_sequence) VALUES ('hq-other', 'unknown.ds', $1, 0)`, [P]), /beyond/);
    // Quarantine evidence is immutable; resolution then re-detection is counted.
    await rejects(runtime.query(`UPDATE karryam_admin.event_quarantine SET raw_digest = $1`, [sha("other")]), /immutable/);
    await runtime.query(`UPDATE karryam_admin.event_quarantine SET resolved_at = now(), resolved_by = 'op-1', resolution = 'OPERATOR_REVIEWED'`);
    await rejects(runtime.query(`UPDATE karryam_admin.event_quarantine SET resolved_at = NULL, resolved_by = NULL, resolution = NULL`), /re-detection/);
    await rejects(runtime.query(`UPDATE karryam_admin.event_quarantine SET occurrences = 0`), /occurrences|check/);
    await rejects(runtime.query(`DELETE FROM karryam_admin.event_quarantine`), "42501");
    // Sync runs: a finished run is immutable; counters are nonnegative integers.
    await rejects(runtime.query(`UPDATE karryam_admin.sync_runs SET status = 'FAILED'`), /finished sync runs are immutable/);
    const id = await store.startRun({ stage: "RECONCILE", workerId: "w1", correlationId: "corr-123" });
    await rejects(runtime.query(`UPDATE karryam_admin.sync_runs SET finished_at = now(), status = 'SUCCEEDED', counts = '{"received": -1}' WHERE id = $1`, [id]), /nonnegative/);
    await rejects(runtime.query(`UPDATE karryam_admin.sync_runs SET worker_id = 'w2' WHERE id = $1`, [id]), /identity/);
    await store.finishRun(id, { status: "SUCCEEDED", counts: { received: 2 } });
    // Contract records: identity immutable, approval evidence recorded once (operator identity).
    await rejects(owner.query(`UPDATE karryam_admin.bridge_contract_revisions SET source_commit = 'other'`), /immutable/);
    await owner.query(`UPDATE karryam_admin.bridge_contract_revisions SET approved_by = 'reviewer-1', approved_at = now(), approval_evidence_ref = 'CAB-2026-11', source_policy_revision = 'policy-7', expires_at = now() + interval '90 days'`);
    await rejects(owner.query(`UPDATE karryam_admin.bridge_contract_revisions SET approved_by = 'reviewer-2'`), /recorded once/);
    await rejects(runtime.query(`UPDATE karryam_admin.bridge_contract_revisions SET approved_by = 'self'`), "42501");
  });

  await t.test("9.2.13 approval decisions are recorded once; revocation is explicit", async () => {
    const approvals = pgApprovals(runtime);
    const id = randomUUID();
    await approvals.propose({ id, capabilityId: "karryam.hq.exports.create", intentDigest: sha("e"), scope: { market: ["NG-LAGOS"] }, requestedBy: "staff-1", ttlSeconds: 600 });
    await approvals.decide({ id, decidedBy: "staff-2", approve: true, mfaAt: Math.floor(Date.now() / 1000) });
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET decided_by = 'staff-3' WHERE id = $1`, [id]), /recorded once/);
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET status = 'PROPOSED', decided_by = NULL WHERE id = $1`, [id]), /recorded once|not allowed/);
    const noMfa = randomUUID();
    await approvals.propose({ id: noMfa, capabilityId: "karryam.hq.exports.create", intentDigest: sha("f"), scope: { market: ["NG-LAGOS"] }, requestedBy: "staff-1", ttlSeconds: 600 });
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET status = 'APPROVED', decided_by = 'staff-2', decided_at = now(), decided_mfa_at = NULL WHERE id = $1`, [noMfa]), /approval_mfa_recorded/);
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET status = 'APPROVED', decided_by = 'staff-1', decided_at = now(), decided_mfa_at = now() WHERE id = $1`, [noMfa]), /approval_two_person/);
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET status = 'REVOKED', revoked_at = now(), revoked_by = 'staff-1', revocation_reason = 'WITHDRAWN' WHERE id = $1`, [id]), /requester cannot revoke/);
    await runtime.query(`UPDATE karryam_admin.approval_references SET status = 'REVOKED', revoked_at = now(), revoked_by = 'staff-9', revocation_reason = 'RISK_REVIEW' WHERE id = $1`, [id]);
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET status = 'CONSUMED', consumed_by = $2, consumed_at = now() WHERE id = $1`, [id, randomUUID()]), /not allowed/);
  });

  await t.test("9.4.8 legal hold overrides retention and erasure; retention keeps identity and digests", async () => {
    const P = seeded.partition;
    // Two-person rule and a valid target.
    await rejects(gov.placeLegalHold({ target: { kind: "PARTITION", partitionKey: P }, reasonCode: "LITIGATION", caseReference: "LEGAL-1", placedBy: "c-1", approvedBy: "c-1" }), /INDEPENDENT_APPROVER/);
    await rejects(runtime.query(`INSERT INTO karryam_admin.legal_holds (id, hold_scope, partition_key, reason_code, case_reference, placed_by, approved_by) VALUES ($1,'PARTITION',$2,'X_Y','c','a','a')`, [randomUUID(), P]), /legal_hold_two_person/);
    const holdId = await gov.placeLegalHold({ target: { kind: "ENTITY", sourceService: "support-dispute-service", entityType: "support_case", entityRef: "case-1" }, reasonCode: "LITIGATION", caseReference: "LEGAL-1", placedBy: "c-1", approvedBy: "c-2" });
    // Race: a retention run and a hold placement serialize on the same lock.
    const [ret] = await Promise.all([gov.clearExpiredPayloads({ configuredDays: 0 }).then(() => store.clearExpiredPayloads(0)), gov.activeLegalHolds()]);
    assert.ok(ret >= 0);
    const [held] = await q(`SELECT payload IS NOT NULL AS has_payload, event_digest FROM karryam_admin.bridge_event_inbox WHERE entity_ref = 'case-1'`);
    assert.equal(held.has_payload, true, "a held entity keeps its payload through retention");
    await rejects(runtime.query(`UPDATE karryam_admin.bridge_event_inbox SET payload = NULL, payload_cleared_at = now(), payload_cleared_reason = 'RETENTION' WHERE entity_ref = 'case-1'`), /legal hold/);
    await rejects(runtime.query(`UPDATE karryam_admin.bridge_event_inbox SET payload = NULL WHERE entity_ref = 'case-1'`), /time and reason|legal hold/);
    // Erasure needs an owner-confirmed privacy fulfilment and no hold.
    const fulfil = randomUUID();
    await rejects(gov.eraseEntity({ sourceService: "support-dispute-service", entityType: "support_case", entityRef: "case-1", fulfilmentOperationId: seeded.operationId, actor: "c-3" }), /ERASURE_REQUIRES_PRIVACY_FULFILMENT/);
    await owner.query(`INSERT INTO karryam_admin.operation_requests (id, service_id, idempotency_key, request_digest, capability_id, staff_ref, status, reason_code) VALUES ($1,'hq-pic','idem-0000000000000002',$2,'karryam.hq.privacy.fulfilment','staff-1','RECORDED','INTENT_RECORDED')`, [fulfil, sha(fulfil)]);
    await rejects(gov.eraseEntity({ sourceService: "support-dispute-service", entityType: "support_case", entityRef: "case-1", fulfilmentOperationId: fulfil, actor: "c-3" }), /ERASURE_NOT_CONFIRMED_BY_OWNER/);
    await owner.query(`UPDATE karryam_admin.operation_requests SET status = 'DISPATCHING', dispatch_count = 1 WHERE id = $1`, [fulfil]);
    await owner.query(`UPDATE karryam_admin.operation_requests SET status = 'SUCCEEDED', reason_code = 'SOURCE_CONFIRMED', source_status = 'COMPLETED' WHERE id = $1`, [fulfil]);
    await rejects(gov.eraseEntity({ sourceService: "support-dispute-service", entityType: "support_case", entityRef: "case-1", fulfilmentOperationId: fulfil, actor: "c-3" }), /LEGAL_HOLD_ACTIVE/);
    await gov.releaseLegalHold({ id: holdId, releasedBy: "c-2", releaseReason: "CASE_CLOSED" });
    await rejects(gov.releaseLegalHold({ id: holdId, releasedBy: "c-2", releaseReason: "CASE_CLOSED" }), /HOLD_NOT_ACTIVE/);
    await rejects(runtime.query(`UPDATE karryam_admin.legal_holds SET reason_code = 'OTHER' WHERE id = $1`, [holdId]), /immutable/);
    const erased = await gov.eraseEntity({ sourceService: "support-dispute-service", entityType: "support_case", entityRef: "case-1", fulfilmentOperationId: fulfil, actor: "c-3" });
    assert.deepEqual(erased, { payloadsCleared: 1, projectionRedacted: true });
    const [after] = await q(`SELECT i.payload, i.payload_cleared_reason, i.event_digest, p.payload AS projection, p.entity_version FROM karryam_admin.bridge_event_inbox i JOIN karryam_admin.entity_projections p ON p.entity_ref = i.entity_ref WHERE i.entity_ref = 'case-1'`);
    assert.deepEqual(after, { payload: null, payload_cleared_reason: "ERASURE", event_digest: held.event_digest, projection: {}, entity_version: "3" });
    const [audit] = await q(`SELECT action, outcome FROM karryam_admin.integration_audit WHERE action = 'privacy.erasure'`);
    assert.deepEqual(audit, { action: "privacy.erasure", outcome: "ERASURE_APPLIED" });
    // Policy-driven retention never goes below the evidence minimum.
    await rejects(owner.query(`UPDATE karryam_admin.retention_policies SET retention_days = 30 WHERE data_class = 'INTEGRATION_AUDIT'`), /retention_evidence_minimum/);
    await rejects(owner.query(`UPDATE karryam_admin.retention_policies SET action = 'CLEAR_PAYLOAD' WHERE data_class = 'INTEGRATION_AUDIT'`), /retention_evidence_kept/);
  });

  await t.test("9.2.3 runtime capability discovery is cached separately and expires to UNKNOWN", async () => {
    let clock = Date.now();
    const g = createGovernanceStore(runtime, { now: () => clock });
    const rev = hex("rev");
    const openapi = hex("openapi");
    const staff = { sub: "staff-1", role: "hq.karryam.read", market: "NG-LAGOS", organization: "karryam-ng" };
    assert.deepEqual(await g.runtimeAvailability("hq.support.queue", staff.role), { state: "UNKNOWN", reason: "NO_RUNTIME_OBSERVATION" });
    const stored = await g.recordCapabilityDiscovery({ registry: R, contractRevision: rev, staff, ttlSeconds: 300,
      discovery: { contract_version: "1.0", openapi_sha256: openapi, capabilities: [{ id: "hq.support.queue", state: "READ_ONLY" }, { id: "hq.exports.create", state: "DISABLED" }, { id: "invented.capability", state: "AVAILABLE" }] } });
    assert.equal(stored.stored, 2, "capabilities unknown to the pinned contract are never cached");
    assert.equal((await g.runtimeAvailability("hq.support.queue", staff.role, { contractRevision: rev })).state, "READ_ONLY");
    assert.equal((await g.runtimeAvailability("hq.exports.create", staff.role)).state, "DISABLED");
    assert.equal((await g.runtimeAvailability("invented.capability", staff.role)).state, "UNKNOWN");
    assert.equal((await g.runtimeAvailability("hq.support.queue", staff.role, { contractRevision: hex("other") })).reason, "OBSERVED_UNDER_OTHER_CONTRACT");
    clock += 301000;
    assert.deepEqual(await g.runtimeAvailability("hq.support.queue", staff.role), { state: "UNKNOWN", reason: "OBSERVATION_EXPIRED" });
    await rejects(runtime.query(`UPDATE karryam_admin.capability_snapshots SET observed_state = 'AVAILABLE'`), "42501");
    await rejects(owner.query(`UPDATE karryam_admin.capability_snapshots SET observed_state = 'AVAILABLE'`), /not permitted/);
    await rejects(runtime.query(`DELETE FROM karryam_admin.capability_snapshots`), "42501");
  });

  await t.test("9.4.10 representative query plans use the intended indexes", async () => {
    const P = seeded.partition;
    // Realistic synthetic volume so the planner prefers indexes.
    await owner.query(`INSERT INTO karryam_admin.bridge_event_inbox (partition_key, event_id, sequence, event_type, source_service, entity_type, entity_ref, entity_version, tombstone, classification, scope, payload, event_digest, outcome, delivery, occurred_at, emitted_at, contract_revision)
      SELECT $1, gen_random_uuid(), 1000 + g, 'support.case.changed.v1', 'support-dispute-service', 'support_case', 'bulk-' || g, 1, false, 'INTERNAL', '{}', '{}', 'sha256:' || md5(g::text) || md5(g::text), 'APPLIED', 'FEED', now(), now(), $2
      FROM generate_series(1, 20000) g`, [P, hex("rev")]);
    await owner.query(`INSERT INTO karryam_admin.operation_requests (id, service_id, idempotency_key, request_digest, capability_id, staff_ref, status, reason_code)
      SELECT gen_random_uuid(), 'hq-pic', 'idem-bulk-' || lpad(g::text, 10, '0'), 'sha256:' || md5(g::text) || md5(g::text), 'karryam.x', 'staff-' || (g % 50), 'REJECTED', 'CAPABILITY_DISABLED' FROM generate_series(1, 20000) g`);
    await owner.query(`ANALYZE karryam_admin.bridge_event_inbox; ANALYZE karryam_admin.operation_requests`);
    const plan = async (sql, params) => (await q("EXPLAIN (FORMAT JSON) " + sql, params))[0]["QUERY PLAN"][0].Plan;
    const indexOf = (node) => node["Index Name"] || (node.Plans || []).map(indexOf).find(Boolean) || null;
    assert.equal(indexOf(await plan(`SELECT * FROM karryam_admin.bridge_event_inbox WHERE event_id = $1`, [randomUUID()])), "bridge_event_inbox_event_id_key");
    assert.equal(indexOf(await plan(`SELECT event_id FROM karryam_admin.bridge_event_inbox WHERE partition_key = $1 AND sequence = $2`, [P, 1500])), "inbox_partition_sequence_unique");
    assert.equal(indexOf(await plan(`SELECT * FROM karryam_admin.operation_requests WHERE service_id = $1 AND idempotency_key = $2`, ["hq-pic", "idem-bulk-0000000042"])), "operation_requests_idempotency_unique");
    assert.equal(indexOf(await plan(`SELECT * FROM karryam_admin.operation_requests WHERE staff_ref = $1 ORDER BY created_at DESC LIMIT 20`, ["staff-7"])), "operation_requests_staff_idx");
  });
});
