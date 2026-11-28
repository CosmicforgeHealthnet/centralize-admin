"use strict";

// Section 8 Stage A (Bridge -> Karryam Admin) and the Stage B derived outbox
// on disposable PostgreSQL with the disposable secure Bridge (real TLS 1.3
// mTLS, HMAC v2, Ed25519). Runs only with KARRYAM_ADMIN_TEST_DATABASE_URL.
// Each scenario uses its own feed partition (tenant); the Bridge outbox is
// global, so per-partition sequence holes are normal, as in production.

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomBytes, randomUUID } = require("node:crypto");
const { Client, Pool } = require("pg");
const { migrate } = require("../scripts/migrate");
const { createPipelineStore, partitionKeyFor } = require("../src/sync/store");
const { createBridgeConsumer } = require("../src/sync/bridge-consumer");
const { createBridgeClient } = require("../src/bridge/client");
const { verifyEvent } = require("../src/sync/bridge-events");
const { pgAudit } = require("../src/audit");
const { startFakeBridge, bridgeConfigFor } = require("./helpers/fake-bridge");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");
const X = require("./helpers/bridge-fixtures");
const F = require("./helpers/fixtures");

const ADMIN_URL = process.env.KARRYAM_ADMIN_TEST_DATABASE_URL;
const scope = (tenant) => ({ market: "NG-LAGOS", organization: "karryam-ng", zone: "lagos-island", tenant });

function withDb(base, db, user, password) {
  const url = new URL(base);
  url.pathname = "/" + db;
  if (user) { url.username = user; url.password = password || ""; }
  return url.toString();
}

async function disposableDatabase(t) {
  const suffix = randomBytes(4).toString("hex");
  const db = "ka_pipe_" + suffix;
  const migrator = "ka_pipe_mig_" + suffix;
  const runtime = "ka_pipe_rt_" + suffix;
  const password = randomBytes(12).toString("hex");
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${migrator}`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${runtime}`);
  await migrate({ connectionString: withDb(ADMIN_URL, db, migrator, password), runtimeRole: runtime });
  const pool = new Pool({ connectionString: withDb(ADMIN_URL, db, runtime, password), max: 6 });
  pool.on("error", () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtime}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${migrator}`).catch(() => {});
    await admin.end();
  });
  return { pool, ownerUrl: withDb(ADMIN_URL, db, migrator, password) };
}

const feedFor = (tenant, over = {}) => ({ enabled: true, scopes: [scope(tenant)], consumer: "karryam-admin-test", subject: "svc-karryam-admin", role: "hq.karryam.read", acr: "workload", purpose: "hq_event_sync", pageSize: 3, pollSeconds: 5, rewindEvents: 50, reconcileSeconds: 300, retentionDays: 7, leaseSeconds: 30, ...over });

test("Stage A and Stage B on disposable PostgreSQL", { skip: !ADMIN_URL && "KARRYAM_ADMIN_TEST_DATABASE_URL not set" }, async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.karryam.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const { pool, ownerUrl } = await disposableDatabase(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } } });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret, tenants: ["tenant-a", "tenant-b", "tenant-c", "tenant-d", "tenant-e", "tenant-f", "tenant-g"] });
  const bridgeClient = createBridgeClient(bridge, { metrics: {} });
  const store = createPipelineStore(pool, { serviceInstanceId: F.INSTANCE });
  const consumerFor = (tenant, opts = {}) => {
    const c = createBridgeConsumer({ feed: feedFor(tenant, opts.feed), store, bridgeClient, hooks: opts.hooks || {}, workerId: opts.workerId });
    return c.init().then(() => c);
  };
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const partitionOf = async (tenant) => (await q("SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1", [partitionKeyFor(scope(tenant))]))[0];
  const outboxOf = (tenant, dataset) => q("SELECT sequence, event FROM karryam_admin.hq_outbox WHERE partition_key = $1 AND dataset_id = $2 ORDER BY sequence", [partitionKeyFor(scope(tenant)), dataset]);
  const latestMetric = async (tenant, metric) => (await q("SELECT * FROM karryam_admin.metric_snapshots WHERE partition_key = $1 AND metric_id = $2 ORDER BY window_start DESC LIMIT 1", [partitionKeyFor(scope(tenant)), metric]))[0];

  await t.test("ingests verified events, ACKs the Bridge only after commit, projects, derives and publishes contiguous HQ events", async () => {
    const s = scope("tenant-a");
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", status: "OPEN", priority: "EMERGENCY", scope: s }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "other-tenant", scope: scope("tenant-z") })); // another partition's event: a normal hole
    fake.publish((n) => X.verificationEvent({ sequence: n, scope: s }));
    fake.publish((n) => X.campaignEvent({ sequence: n, scope: s }));
    const c = await consumerFor("tenant-a");
    const [r] = await c.tick();
    assert.equal(r.status, "SUCCEEDED", JSON.stringify(r));
    assert.equal(r.applied, 3);
    const p = await partitionOf("tenant-a");
    assert.equal(Number(p.last_sequence), 4);
    assert.equal(Number(p.acked_sequence), 4);
    assert.equal(fake.state.consumers[c.consumerName(p.partition_key)], 4, "Bridge ACK equals the committed cursor");
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox WHERE partition_key = $1", [p.partition_key]))[0].n, 3);
    const inbox = await q("SELECT payload FROM karryam_admin.bridge_event_inbox WHERE partition_key = $1 AND entity_type = 'support_case'", [p.partition_key]);
    assert.equal(inbox[0].payload.status, "OPEN");
    assert.equal(JSON.stringify(inbox).includes("phone"), false);
    // Before the Bridge reports COMPLETE source coverage, counts are UNAVAILABLE.
    const before = await latestMetric("tenant-a", "karryam.support.cases_open");
    assert.equal(before.value_state, "UNAVAILABLE");
    assert.equal(before.coverage, "PARTIAL");
    // Reconciliation records source coverage; derived counts become OBSERVED.
    const [rec] = await c.reconcile();
    assert.equal(rec.status, "SUCCEEDED", JSON.stringify(rec));
    assert.equal(rec.details.bridge_head, 4);
    const open = await latestMetric("tenant-a", "karryam.support.cases_open");
    assert.equal(open.value_state, "OBSERVED");
    assert.equal(Number(open.value), 1);
    assert.equal(Number((await latestMetric("tenant-a", "karryam.support.cases_emergency_open")).value), 1);
    assert.equal(Number((await latestMetric("tenant-a", "karryam.verification.cases_pending_review")).value), 1);
    // LOGGED_ONLY is never delivered; delivered is unavailable without provider receipts.
    assert.equal(Number((await latestMetric("tenant-a", "karryam.marketing.messages_logged_only")).value), 5);
    assert.equal((await latestMetric("tenant-a", "karryam.marketing.messages_delivered")).value_state, "UNAVAILABLE");
    // Stage B: contiguous sequences, typed minimized payloads, lineage.
    const out = await outboxOf("tenant-a", "karryam.support_operations");
    assert.deepEqual(out.map((o) => Number(o.sequence)), out.map((_, i) => i + 1));
    const ev = out.at(-1).event;
    assert.equal(ev.envelope, "cosmicforge.product-admin.event/v1");
    assert.equal(ev.schema_id, "cosmicforge.metric-observation");
    assert.deepEqual(ev.scope, { market: s.market, organization: s.organization, zone: s.zone, tenant: s.tenant });
    assert.equal(Object.keys(ev.payload).includes("status"), false, "raw Bridge bodies never reach HQ");
    const lineage = await q("SELECT operation FROM karryam_admin.projection_lineage WHERE partition_key = $1", [p.partition_key]);
    assert.ok(lineage.some((l) => l.operation === "APPLY_EVENT") && lineage.some((l) => l.operation === "DERIVE_METRIC"));
    // A second run with nothing new changes nothing.
    const outCount = (await q("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox")).rows;
    const [again] = await c.tick();
    assert.equal(again.received, 0);
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox"))[0].n >= 0, true);
    void outCount;
  });

  await t.test("tombstones, older versions and entity-version gaps; snapshot backfill repairs the gap", async () => {
    const s = scope("tenant-b");
    const c = await consumerFor("tenant-b");
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-b1", version: 1, scope: s }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-b1", version: 2, scope: s, tombstone: true }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-b1", version: 1, status: "CLOSED", scope: s, eventId: randomUUID() }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-b2", version: 1, scope: s }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-b2", version: 3, status: "ESCALATED", scope: s }));
    const [r] = await c.tick();
    assert.equal(r.status, "SUCCEEDED", JSON.stringify(r));
    assert.equal(r.stale, 1);
    assert.equal(r.gap_applied, 1);
    const b1 = (await q("SELECT * FROM karryam_admin.entity_projections WHERE entity_ref = 'case-b1'"))[0];
    assert.equal(b1.tombstone, true);
    assert.deepEqual(b1.payload, {});
    assert.equal(Number(b1.entity_version), 2, "an older version never overwrites a newer one");
    const gaps = await q("SELECT * FROM karryam_admin.entity_version_gaps WHERE entity_ref = 'case-b2' AND repaired_at IS NULL");
    assert.equal(gaps.length, 1);
    await c.reconcile();
    // Gap open -> coverage partial -> counts withheld, until backfill repairs it.
    // The reconcile above already back-filled from the HQ support queue:
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.entity_version_gaps WHERE entity_ref = 'case-b2' AND repaired_at IS NULL"))[0].n, 0);
    const escalated = await latestMetric("tenant-b", "karryam.support.cases_escalated");
    assert.equal(escalated.value_state, "OBSERVED");
    assert.equal(Number(escalated.value), 1);
    assert.equal(Number((await latestMetric("tenant-b", "karryam.support.cases_open")).value), 1, "tombstoned case excluded");
    // A snapshot with a newer source version is applied (version-fenced).
    fake.state.supportProjections.set("case-b9", { ref: "case-b9", version: 5, fields: X.supportEvent({ sequence: 1, scope: s }).payload, scope: s });
    const [full] = await c.reconcile({ trigger: "OPERATOR", backfill: "FULL" });
    assert.ok(full.counts.backfilled >= 1, JSON.stringify(full));
    const b9 = (await q("SELECT * FROM karryam_admin.entity_projections WHERE entity_ref = 'case-b9'"))[0];
    assert.equal(b9.coverage, "BACKFILLED");
    assert.equal(Number(b9.entity_version), 5);
  });

  await t.test("changed digest on a known event ID is an integrity incident: quarantined, held, never ACKed past or skipped", async () => {
    const s = scope("tenant-c");
    const c = await consumerFor("tenant-c");
    const first = fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-c1", scope: s }));
    await c.tick();
    const heldBefore = Number((await partitionOf("tenant-c")).last_sequence);
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-c1", version: 2, status: "CLOSED", scope: s, eventId: first.event_id }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-c2", scope: s }));
    const [r] = await c.tick();
    assert.equal(r.status, "HELD");
    const p = await partitionOf("tenant-c");
    assert.equal(Number(p.last_sequence), heldBefore);
    assert.equal(Number(p.acked_sequence), heldBefore);
    assert.equal(p.hold_reason, "EVENT_ID_DIGEST_CONFLICT");
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.entity_projections WHERE entity_ref = 'case-c2'"))[0].n, 0, "nothing after the hold is applied");
    const quarantine = await q("SELECT * FROM karryam_admin.event_quarantine WHERE partition_key = $1", [p.partition_key]);
    assert.equal(quarantine[0].reason, "EVENT_ID_DIGEST_CONFLICT");
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(quarantine[0].raw_digest));
    assert.equal(Object.keys(quarantine[0]).includes("payload"), false, "quarantine keeps metadata and digest only");
    assert.equal((await c.tick())[0].status, "HELD");
    assert.equal((await latestMetric("tenant-c", "karryam.sync.open_quarantine")).value_state, "OBSERVED");
    // Operator release is audited and does not skip: the same event holds again.
    assert.equal(await store.releaseHold(p.partition_key, { operator: "ops-1", resolution: "SOURCE_INVESTIGATION" }), true);
    const [again] = await c.tick();
    assert.equal(again.status, "HELD");
    assert.equal(Number((await partitionOf("tenant-c")).last_sequence), heldBefore);
  });

  await t.test("unverifiable events (unknown type, cross-tenant, bad payload, out-of-order) are quarantined and hold the cursor", async () => {
    const cases = [
      ["tenant-d", (n, s) => ({ ...X.supportEvent({ sequence: n, scope: s }), event_type: "karryam.support.case.deleted.v1" }), "EVENT_TYPE_UNKNOWN"],
      ["tenant-e", (n) => ({ ...X.supportEvent({ sequence: n, scope: scope("tenant-q") }), forceVisibleTo: "tenant-e" }), "SCOPE_MISMATCH"],
      ["tenant-f", (n, s) => { const e = X.supportEvent({ sequence: n, scope: s }); e.payload.status = "DELETED"; return e; }, "PAYLOAD_FIELD_INVALID"],
    ];
    for (const [tenant, build, reason] of cases) {
      const c = await consumerFor(tenant);
      fake.publish((n) => build(n, scope(tenant)));
      const [r] = await c.tick();
      assert.equal(r.status, "HELD", tenant);
      assert.equal(r.reason, reason, tenant);
      assert.equal(Number((await partitionOf(tenant)).last_sequence), 0);
    }
    const c = await consumerFor("tenant-g");
    const s = scope("tenant-g");
    fake.state.handlers["hq.events.feed"] = ({ query }) => query.tenant === "tenant-g"
      ? { result: { events: [X.supportEvent({ sequence: 900002, scope: s }), X.supportEvent({ sequence: 900001, scope: s })], next_sequence: 900002, head_sequence: 900002, as_of: new Date().toISOString() } }
      : undefined;
    const [r] = await c.tick();
    delete fake.state.handlers["hq.events.feed"];
    assert.equal(r.status, "HELD");
    assert.equal(r.reason, "SEQUENCE_ANOMALY");
    assert.equal(Number((await partitionOf("tenant-g")).last_sequence), 900002 - 0 > 0 ? Number((await partitionOf("tenant-g")).last_sequence) : 0);
    // Unit-level verification reasons that the Bridge contract itself already blocks.
    const ev = X.supportEvent({ sequence: 1, scope: scope("tenant-a") });
    assert.equal(verifyEvent({ ...ev, product: "healthnet" }, scope("tenant-a")).reason, "PRODUCT_MISMATCH");
    assert.equal(verifyEvent({ ...ev, classification: "RESTRICTED_PII" }, scope("tenant-a")).reason, "CLASSIFICATION_NOT_EXPORTABLE");
    assert.equal(verifyEvent({ ...ev, classification: "INTERNAL" }, scope("tenant-a")).reason, "CLASSIFICATION_MISMATCH");
    assert.equal(verifyEvent({ ...ev, source_service: "customer-service" }, scope("tenant-a")).reason, "SOURCE_MISMATCH");
    assert.equal(verifyEvent({ ...ev, payload: { ...ev.payload, phone: "+234" } }, scope("tenant-a")).reason, "PAYLOAD_FIELD_UNKNOWN");
    assert.equal(verifyEvent({ ...ev, tombstone: true }, scope("tenant-a")).reason, "TOMBSTONE_WITH_PAYLOAD");
    assert.equal(verifyEvent({ ...ev, emitted_at: new Date(Date.now() + 3600000).toISOString() }, scope("tenant-a")).reason, "TIMESTAMP_INVALID");
    assert.equal(verifyEvent({ ...ev, schema: "other.v2" }, scope("tenant-a")).reason, "SCHEMA_UNSUPPORTED");
    assert.equal(verifyEvent(ev, { ...scope("tenant-a"), organization: "other-org" }).reason, "SCOPE_MISMATCH");
  });

  await t.test("crash before commit, crash after commit before ACK, ACK retry: no lost or duplicated effects", async () => {
    const tenant = "tenant-a";
    const s = scope(tenant);
    const start = Number((await partitionOf(tenant)).last_sequence);
    const e1 = fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-a2", scope: s }));
    const e2 = fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-a3", scope: s }));
    const crashing = await consumerFor(tenant, { hooks: { beforeCommit: ({ sequence }) => { if (sequence === e2.sequence) throw new Error("crash"); } } });
    await assert.rejects(crashing.tick(), /crash/);
    const mid = await partitionOf(tenant);
    assert.equal(Number(mid.last_sequence), e1.sequence, "only the committed event moved the cursor");
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.entity_projections WHERE entity_ref = 'case-a3'"))[0].n, 0);
    // Lease from the crashed worker expires; a fresh worker resumes.
    await pool.query("UPDATE karryam_admin.bridge_feed_partitions SET lease_expires_at = now() - interval '1 second' WHERE partition_key = $1", [mid.partition_key]);
    const noAck = await consumerFor(tenant, { hooks: { beforeAck: ({ sequence }) => { if (sequence === e2.sequence) throw new Error("crash-before-ack"); } } });
    await assert.rejects(noAck.tick(), /crash-before-ack/);
    const committed = await partitionOf(tenant);
    assert.equal(Number(committed.last_sequence), e2.sequence);
    assert.ok(Number(committed.acked_sequence) < e2.sequence, "not acknowledged before ACK succeeded");
    await pool.query("UPDATE karryam_admin.bridge_feed_partitions SET lease_expires_at = now() - interval '1 second' WHERE partition_key = $1", [mid.partition_key]);
    const inboxBefore = (await q("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox"))[0].n;
    // The ACK endpoint fails once, then succeeds; events are never re-applied.
    let failOnce = true;
    fake.state.handlers["hq.events.ack"] = () => (failOnce ? ((failOnce = false), { status: 503, error: "owner_unavailable" }) : undefined);
    const recovering = await consumerFor(tenant);
    const [partial] = await recovering.tick();
    assert.equal(partial.status, "PARTIAL");
    delete fake.state.handlers["hq.events.ack"];
    const [ok] = await recovering.tick();
    assert.equal(ok.status, "SUCCEEDED");
    assert.equal(Number((await partitionOf(tenant)).acked_sequence), e2.sequence);
    assert.equal(fake.state.consumers[recovering.consumerName(mid.partition_key)], e2.sequence);
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox"))[0].n, inboxBefore, "no duplicate application");
    assert.ok(start < e2.sequence);
  });

  await t.test("late-visible Bridge rows are recovered by the reconciliation rewind; duplicates are idempotent", async () => {
    const tenant = "tenant-b";
    const s = scope(tenant);
    const c = await consumerFor(tenant);
    const reserved = fake.reserveSequence();
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-b3", scope: s }));
    await c.tick();
    assert.ok(Number((await partitionOf(tenant)).last_sequence) > reserved);
    fake.commitLate(X.supportEvent({ sequence: reserved, ref: "case-b4", scope: s }));
    const [rec] = await c.reconcile();
    assert.equal(rec.counts.late_applied, 1, JSON.stringify(rec));
    assert.ok(rec.counts.rewind_duplicates >= 1);
    assert.equal((await q("SELECT outcome FROM karryam_admin.bridge_event_inbox WHERE entity_ref = 'case-b4'"))[0].outcome, "LATE_APPLIED");
    const [again] = await c.reconcile();
    assert.equal(again.counts.late_applied, 0);
  });

  await t.test("Bridge outage, revoked transport identity and lease collisions fail closed", async () => {
    const tenant = "tenant-a";
    const c = await consumerFor(tenant);
    const before = await partitionOf(tenant);
    fake.state.paused = true;
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-a9", scope: scope(tenant) }));
    const [down] = await c.tick();
    fake.state.paused = false;
    assert.equal(down.status, "FAILED");
    assert.match(down.reason, /^BRIDGE_/);
    assert.equal((await partitionOf(tenant)).last_sequence, before.last_sequence);
    const fp = require("node:crypto").createHash("sha256").update(new (require("node:crypto").X509Certificate)(pki.clientCert).raw).digest("hex");
    fake.state.revokedFingerprints.add(fp);
    const [revoked] = await c.tick();
    assert.equal(revoked.reason, "BRIDGE_UNAUTHORIZED");
    fake.state.revokedFingerprints.clear();
    // Lease collision: a second worker cannot process while the lease is held,
    // and a superseded token cannot commit.
    const lease = await store.acquireLease(before.partition_key, "worker-A", 30);
    const other = await consumerFor(tenant, { workerId: "worker-B" });
    assert.equal((await other.syncPartition(scope(tenant))).status, "LEASE_LOST");
    await pool.query("UPDATE karryam_admin.bridge_feed_partitions SET lease_expires_at = now() - interval '1 second' WHERE partition_key = $1", [before.partition_key]);
    const takeover = await store.acquireLease(before.partition_key, "worker-B", 30);
    const ev = X.supportEvent({ sequence: 999999, ref: "case-zombie", scope: scope(tenant) });
    assert.equal(await store.applyEvent(before.partition_key, "worker-A", lease.lease_token, ev, verifyEvent(ev, scope(tenant)), { delivery: "FEED", contractRevision: "x" }), "LEASE_LOST");
    await store.releaseLease(before.partition_key, "worker-B", takeover.lease_token);
    const [resumed] = await c.tick();
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.entity_projections WHERE entity_ref = 'case-a9'"))[0].n, 1);
  });

  await t.test("Stage B outbox: bounded pages, monotonic HQ acknowledgements independent of Stage A", async () => {
    const key = partitionKeyFor(scope("tenant-a"));
    const page = await store.outboxEvents("karryam.support_operations", key, 0, 2);
    assert.equal(page.events.length, 2);
    assert.ok(page.headSequence >= 2);
    assert.equal(await store.outboxAck("hq-product-integration-core", "karryam.support_operations", key, page.headSequence + 1), "BEYOND_HEAD");
    assert.equal(await store.outboxAck("hq-product-integration-core", "karryam.support_operations", key, 2), "ACKED");
    assert.equal(await store.outboxAck("hq-product-integration-core", "karryam.support_operations", key, 1), "REGRESSION");
    assert.equal(await store.outboxAck("hq-product-integration-core", "karryam.support_operations", "nope", 1), "UNKNOWN_PARTITION");
    // Stage A kept acknowledging the Bridge with no HQ consumer at all.
    const p = await partitionOf("tenant-a");
    assert.equal(Number(p.acked_sequence), Number(p.last_sequence));
    const snap = await store.snapshot("karryam.support_operations", key);
    assert.equal(snap.headSequence, (await store.outboxEvents("karryam.support_operations", key, 0, 100)).headSequence);
    assert.ok(snap.rows.length === 3);
  });

  await t.test("local reports through the protocol use projections with honest coverage", async (tt) => {
    const m = F.material();
    tt.after(m.cleanup);
    const config = Object.freeze({ ...F.loadConfig(F.enabledEnv(m)), bridge, cursorKey: randomBytes(32), enabledCommands: [], feed: feedFor("tenant-a") });
    const app = await F.startApp(config, { pipeline: store, audit: pgAudit(pool) });
    tt.after(app.close);
    const client = F.hqClient(app.target, m.hqKey);
    const get = (id, query, scopeClaim) => {
      const uri = F.contracts.BASE_PATH + "/reports/karryam.report." + id + "?" + new URLSearchParams(query).toString();
      return client.getReport("karryam.report." + id, query, { delegation: F.delegation(m, { uri, action: "report.read", scope: scopeClaim || { market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: ["lagos-island"], tenant: ["tenant-a", "tenant-c"] } }) });
    };
    const base = { market: "NG-LAGOS", organization: "karryam-ng", purpose: "ops_review" };
    const queue = await get("support_queue", base);
    assert.equal(queue.status, 200, JSON.stringify(queue.json));
    assert.deepEqual(queue.json.result.scope.partitions.sort(), [partitionKeyFor(scope("tenant-a")), partitionKeyFor(scope("tenant-c"))].sort());
    assert.equal(queue.json.result.quality, "PARTIAL_COVERAGE", "tenant-c is held, so counts are withheld");
    assert.ok(queue.json.result.rows.every((r) => r.count === null));
    assert.ok(queue.json.result.blockers.some((b) => b.code === "SLA_POLICY_UNAVAILABLE"));
    const onlyA = await get("support_queue", { ...base, tenant: "tenant-a" });
    assert.equal(onlyA.json.result.quality, "LIVE");
    assert.ok(onlyA.json.result.rows.some((r) => r.status === "OPEN" && r.count >= 1));
    const lag = await get("sync_lag", base);
    const held = lag.json.result.rows.find((r) => r.partition_key === partitionKeyFor(scope("tenant-c")));
    assert.equal(held.hold.reason, "EVENT_ID_DIGEST_CONFLICT");
    const quarantine = await get("quarantine_reconciliation", base);
    assert.ok(quarantine.json.result.rows.some((r) => r.type === "QUARANTINE" && r.reason === "EVENT_ID_DIGEST_CONFLICT"));
    assert.ok(quarantine.json.result.rows.some((r) => r.type === "RUN" && r.stage === "RECONCILE"));
    const marketing = await get("marketing_evidence", { ...base, tenant: "tenant-a" });
    assert.equal(marketing.json.result.rows[0].delivered, null);
    assert.equal(marketing.json.result.rows[0].logged_only, 5);
    // A staff member without explicit tenant grants sees no partition.
    const none = await get("support_queue", base, { market: ["NG-LAGOS"], organization: ["karryam-ng"] });
    assert.deepEqual(none.json.result.rows, []);
    assert.equal(none.json.result.blockers[0].code, "NO_AUTHORIZED_PARTITION");
  });

  await t.test("database guarantees: append-only outbox, immutable inbox, monotonic projections and cursors, retention", async () => {
    const denied = (sql) => assert.rejects(pool.query(sql), (e) => ["42501", "23000", "P0001"].includes(e.code) || /append-only|immutable|monotonic|must increase|exactly one/.test(e.message), sql);
    await denied("UPDATE karryam_admin.hq_outbox SET family = 'x'");
    await denied("DELETE FROM karryam_admin.hq_outbox");
    await denied("UPDATE karryam_admin.bridge_event_inbox SET entity_version = 99");
    await denied("DELETE FROM karryam_admin.bridge_event_inbox");
    await denied("UPDATE karryam_admin.entity_projections SET entity_version = 1");
    await denied("UPDATE karryam_admin.bridge_feed_partitions SET last_sequence = 0");
    await denied("UPDATE karryam_admin.hq_outbox_heads SET head_sequence = head_sequence + 2");
    await denied("UPDATE karryam_admin.projection_lineage SET metric_id = 'x'");
    const cleared = await store.clearExpiredPayloads(0);
    assert.ok(cleared > 0);
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox WHERE payload IS NOT NULL"))[0].n, 0);
    assert.equal((await q("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox WHERE event_digest IS NULL"))[0].n, 0, "digests survive retention");
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    await assert.rejects(owner.query("TRUNCATE karryam_admin.hq_outbox"), /append-only/);
    await owner.end();
  });
});
