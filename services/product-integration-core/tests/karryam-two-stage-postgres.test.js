"use strict";

// Section 8 two-stage end-to-end (spec 14.4):
//
//   synthetic Karryam owner event
//     -> disposable secure Bridge (TLS 1.3 mTLS, HMAC v2, Ed25519, pinned contract)
//     -> real Karryam Admin worker -> real Karryam Admin PostgreSQL (inbox, projections)
//     -> derived HQ outbox (Stage B)
//     -> real Product Integration Core sync engine -> HQ PostgreSQL projection
//     -> authorized HQ API read.
//
// Plus: HQ offline while Stage A keeps acknowledging the Bridge, HQ crash
// after commit before ACK, duplicate protection, and an HQ -> PIC -> Karryam
// Admin -> Bridge scoped resource read (HQ never calls the Bridge).
// Everything external is disposable; nothing here is a live credential.

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { startHarness, available } = require("./helpers/harness");
const K = require("../../karryam-admin/tests/helpers/fixtures");
const X = require("../../karryam-admin/tests/helpers/bridge-fixtures");
const { startFakeBridge, bridgeConfigFor } = require("../../karryam-admin/tests/helpers/fake-bridge");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");
const { migrate } = require("../../karryam-admin/scripts/migrate");
const { createPipelineStore, partitionKeyFor } = require("../../karryam-admin/src/sync/store");
const { createBridgeConsumer } = require("../../karryam-admin/src/sync/bridge-consumer");
const { createBridgeClient } = require("../../karryam-admin/src/bridge/client");
const { pgAudit } = require("../../karryam-admin/src/audit");
const { pgOperations } = require("../../karryam-admin/src/db/operations");
const { pgNonceStore } = require("../../karryam-admin/src/security/nonce-store");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
const SCOPE = { market: "NG-LAGOS", organization: "karryam-ng", zone: "lagos-island", tenant: "tenant-a" };
const DATASET = "karryam.support_operations";

async function karryamDatabase(t) {
  const base = process.env.PIC_TEST_DATABASE_URL;
  const suffix = randomBytes(4).toString("hex");
  const db = "ka_e2e_" + suffix;
  const runtime = "ka_e2e_rt_" + suffix;
  const password = randomBytes(12).toString("hex");
  const admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${runtime}`);
  const url = (user, pass) => { const u = new URL(base); u.pathname = "/" + db; if (user) { u.username = user; u.password = pass; } return u.toString(); };
  await migrate({ connectionString: url(), runtimeRole: runtime });
  const pool = new Pool({ connectionString: url(runtime, password), max: 6 });
  pool.on("error", () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtime}`).catch(() => {});
    await admin.end();
  });
  return pool;
}

test("two-stage pipeline: Karryam source event to an authorized HQ API read", { skip, timeout: 180000 }, async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.karryam.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const kpool = await karryamDatabase(t);

  // Disposable secure Bridge.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } } });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret });

  // Karryam Admin (protocol server + Stage A worker) on its own database.
  const m = K.material();
  t.after(m.cleanup);
  const feed = { enabled: true, scopes: [SCOPE], consumer: "karryam-admin-e2e", subject: "svc-karryam-admin", role: "hq.karryam.read", acr: "workload", purpose: "hq_event_sync", pageSize: 50, pollSeconds: 5, rewindEvents: 20, reconcileSeconds: 300, retentionDays: 7, leaseSeconds: 30 };
  const config = Object.freeze({ ...K.loadConfig(K.enabledEnv(m, { KARRYAM_ADMIN_CERTIFIED_DATASETS: DATASET + ",karryam.sync_health" })), bridge, cursorKey: randomBytes(32), enabledCommands: [], feed });
  const store = createPipelineStore(kpool, { serviceInstanceId: config.serviceInstanceId });
  const audit = pgAudit(kpool);
  const karryam = await K.startApp(config, { pipeline: store, audit, operations: pgOperations(kpool), nonceStore: pgNonceStore(kpool), dbReady: async () => true });
  t.after(karryam.close);
  const worker = createBridgeConsumer({ feed, store, bridgeClient: createBridgeClient(bridge), workerId: "karryam-worker-e2e" });
  await worker.init();

  // Real HQ Product Integration Core with its own database.
  const h = await startHarness({
    extraEndpoints: { "karryam-test": { product_id: "karryam", environment: "test", transport: "http-loopback", origin: "http://127.0.0.1:" + karryam.port, address: "127.0.0.1", service_auth: { key_id: "pic-k1", key_b64url: m.hqKey.toString("base64url") }, delegation: { kid: "d1", key_b64url: m.delegationKey.toString("base64url") } } },
    extraSigners: { "karryam-test-signer-1": { product_id: "karryam", environment: "test", public_key_pem: m.signer.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 86400000).toISOString() } },
  });
  t.after(h.close);
  const hq = (sql, params) => h.pool.query(sql, params).then((r) => r.rows);
  const ka = (sql, params) => kpool.query(sql, params).then((r) => r.rows);
  const partitionKey = partitionKeyFor(SCOPE);

  // Onboard Karryam through the generic registry (no Karryam-specific code in HQ).
  const allowed = { market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] };
  const reg = await h.call("staff-requester", "POST", "/admin/product-integrations", {
    product_id: "karryam", display_name: "Karryam", service_instance_id: K.INSTANCE, environment: "test", endpoint_ref: "karryam-test",
    workload_identity: "cf://test/product-admin/karryam", approved_signer_kid: "karryam-test-signer-1", allowed_scope: allowed,
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const id = reg.json.data.id;
  let rev = reg.json.data.revision;
  const step = async (who, path, body = {}) => {
    const r = await h.call(who, "POST", "/admin/product-integrations/" + id + path, { expected_revision: rev, ...body });
    assert.equal(r.status, 200, path + " " + JSON.stringify(r.json));
    if (r.json.data.revision) rev = r.json.data.revision;
  };
  await step("staff-requester", "/verify-identity");
  await step("staff-requester", "/validate-contract");
  await step("staff-reviewer", "/review-policy", { evidence_ref: "review:karryam-e2e" });
  const dsApprove = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/" + DATASET + "/approve", { version: "1.0.0" });
  assert.equal(dsApprove.status, 200, JSON.stringify(dsApprove.json));
  const uncertified = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/karryam.marketing_campaigns/approve", { version: "1.0.0" });
  assert.equal(uncertified.json.error.reason, "DATASET_NOT_CERTIFIED_BY_PRODUCT", "uncertified datasets stay unapprovable");
  await step("staff-reviewer", "/certify-staging", { evidence_ref: "ci:karryam-two-stage" });
  await step("staff-approver", "/approve");
  const sub = await h.call("staff-requester", "POST", "/admin/product-integrations/" + id + "/subscriptions", { dataset_id: DATASET, version: "1.0.0", consumer_department: "support", allowed_scope: allowed, enabled: true, poll_interval_seconds: 30 });
  assert.equal(sub.status, 201, JSON.stringify(sub.json));
  const grant = await h.call("staff-requester", "POST", "/admin/product-integration-grants", {
    grant_kind: "PRODUCT", product_id: "karryam", staff_id: "staff-support", role: "karryam.ops.viewer",
    actions: ["product.view", "dataset.list", "metric.read", "events.status.read", "resource.read", "report.read"], datasets: [DATASET], scope: allowed,
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.json));
  const metricPath = "/products/karryam/metrics/karryam.support.cases_open?market=NG-LAGOS&organization=karryam-ng&zone=lagos-island&tenant=tenant-a";

  await t.test("source event -> Bridge -> Karryam Admin inbox -> projection -> derived outbox -> HQ inbox -> HQ metric read", async () => {
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", status: "OPEN", priority: "EMERGENCY", scope: SCOPE }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-2", status: "ESCALATED", scope: SCOPE }));
    const [a] = await worker.tick();
    assert.equal(a.status, "SUCCEEDED", JSON.stringify(a));
    assert.equal(a.applied, 2);
    assert.equal(fake.state.consumers[worker.consumerName(partitionKey)], 2, "Bridge ACK only after Karryam Admin commit");
    await worker.reconcile();
    assert.equal((await ka("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox"))[0].n, 2);

    // Before HQ syncs, HQ has nothing and says so.
    const before = await h.call("staff-support", "GET", metricPath);
    assert.equal(before.status, 503);
    assert.equal(before.json.error.reason, "NO_SOURCE_OBSERVATION");

    const results = await h.engine.tick();
    assert.equal(results[0].status, "DONE", JSON.stringify(results));
    const part = results[0].results.find((r) => r.partitionKey === partitionKey);
    assert.equal(part.status, "SUCCEEDED", JSON.stringify(results[0].results));
    assert.equal(part.ackStatus, "ACKED");
    const outbox = await ka("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox WHERE dataset_id = $1 AND partition_key = $2", [DATASET, partitionKey]);
    const inbox = await hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox WHERE dataset_id = $1 AND partition_key = $2", [DATASET, partitionKey]);
    assert.equal(inbox[0].n, outbox[0].n, "every derived event reached HQ exactly once");
    const acks = await store.outboxAcks();
    assert.equal(acks.find((x) => x.dataset_id === DATASET).acked_sequence, outbox[0].n, "HQ ACK after its own commit");

    const res = await h.call("staff-support", "GET", metricPath);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const latest = res.json.result.observations[0];
    assert.equal(latest.value, 2);
    assert.equal(latest.value_state, "OBSERVED");
    assert.equal(latest.coverage, "COMPLETE");
    assert.equal(res.json.result.metric.dataset_id, DATASET);
    // Lineage on both sides.
    assert.ok((await ka("SELECT count(*)::int AS n FROM karryam_admin.projection_lineage WHERE operation = 'DERIVE_METRIC'"))[0].n > 0);
    assert.ok((await hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_lineage"))[0].n > 0);
    // Raw source fields never reached HQ.
    const payloads = await hq("SELECT payload FROM hq_integration.hq_product_admin_event_inbox");
    assert.equal(JSON.stringify(payloads).includes("complainant_type"), false);
  });

  await t.test("HQ offline: Stage A keeps acknowledging the Bridge; HQ resumes with no loss or duplicates", async () => {
    const hqInboxBefore = (await hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n;
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", version: 2, status: "RESOLVED", scope: SCOPE }));
    fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-3", status: "OPEN", scope: SCOPE }));
    const [a] = await worker.tick();
    assert.equal(a.status, "SUCCEEDED");
    assert.equal(fake.state.consumers[worker.consumerName(partitionKey)], 4, "Bridge ACK does not depend on HQ");
    assert.equal((await hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n, hqInboxBefore, "HQ was offline");
    // HQ crashes after committing but before acknowledging.
    const crashing = h.makeEngine({ workerId: "pic-worker-crash", hooks: { beforeAck: () => { throw new Error("hq-crash"); } } });
    await assert.rejects(crashing.tick(), /hq-crash/);
    const committed = (await hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n;
    assert.ok(committed > hqInboxBefore);
    const outboxHead = (await ka("SELECT head_sequence FROM karryam_admin.hq_outbox_heads WHERE dataset_id = $1 AND partition_key = $2", [DATASET, partitionKey]))[0].head_sequence;
    assert.ok((await store.outboxAcks()).find((x) => x.dataset_id === DATASET).acked_sequence < Number(outboxHead), "not acknowledged by the crashed HQ worker");
    await h.pool.query("UPDATE hq_integration.hq_product_admin_sync_cursors SET lease_expires_at = now() - interval '1 second'");
    await h.engine.tick();
    await h.engine.tick();
    assert.equal((await hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n, (await ka("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox WHERE dataset_id = $1", [DATASET]))[0].n, "no loss, no duplicate application");
    assert.equal((await store.outboxAcks()).find((x) => x.dataset_id === DATASET).acked_sequence, Number(outboxHead));
    const res = await h.call("staff-support", "GET", metricPath);
    assert.equal(res.json.result.observations[0].value, 2, "case-1 resolved, case-3 opened");
  });

  await t.test("HQ reads Karryam module data only through PIC -> Karryam Admin -> Bridge, scoped and authorized", async () => {
    const qs = "?market=NG-LAGOS&organization=karryam-ng&zone=lagos-island&tenant=tenant-a&purpose=case_review&limit=2";
    const res = await h.call("staff-support", "GET", "/products/karryam/resources/karryam.customers.read/customer.resources.customers.list" + qs);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.result.module, "customer");
    assert.equal(fake.state.requests.at(-1).capability, "customer.resources.customers.list");
    assert.equal(fake.state.requests.at(-1).claims.sub, "staff-support", "the original staff identity reaches the Bridge");
    // No grant for another tenant, no MFA, no grant at all.
    const otherTenant = await h.call("staff-support", "GET", "/products/karryam/resources/karryam.customers.read/customer.resources.customers.list" + qs.replace("tenant-a", "tenant-b"));
    assert.equal(otherTenant.status, 403);
    const noMfa = await h.call("staff-support", "GET", "/products/karryam/resources/karryam.customers.read/customer.resources.customers.list" + qs, undefined, { mfa: false });
    assert.equal(noMfa.json.error.reason, "RECENT_MFA_REQUIRED");
    const stranger = await h.call("staff-viewer", "GET", "/products/karryam/resources/karryam.customers.read/customer.resources.customers.list" + qs);
    assert.equal(stranger.status, 403);
    const command = await h.call("staff-support", "GET", "/products/karryam/resources/karryam.wallet.command.submit/wallet.command.submit" + qs);
    assert.equal(command.json.error.reason, "CAPABILITY_NOT_READ");
    const unknownKey = await h.call("staff-support", "GET", "/products/karryam/resources/karryam.customers.read/customer.resources.customers.list" + qs + "&host=evil");
    assert.equal(unknownKey.json.error.reason, "UNKNOWN_PARAMETER");
    // Report through HQ.
    const report = await h.call("staff-support", "GET", "/products/karryam/reports/karryam.report.sync_lag?market=NG-LAGOS&organization=karryam-ng&purpose=ops_review");
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.equal(report.json.result.rows[0].partition_key, partitionKey);
    assert.equal(report.json.result.rows[0].lag_events, 0);
  });
});
