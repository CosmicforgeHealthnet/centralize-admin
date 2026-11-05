"use strict";

// Section 13.2 journey environment. Everything is real application code on
// disposable infrastructure:
//
//   HQ staff -> real Product Integration Core (own PostgreSQL)
//            -> real Karryam Admin (own PostgreSQL, protocol server + Stage A worker)
//            -> disposable secure Bridge (TLS 1.3 mTLS, HMAC v2, Ed25519,
//               pinned contract, Go hqevents feed semantics).
//
// Karryam is onboarded through the generic HQ registry exactly as any other
// product. Nothing here is a live credential; this is disposable evidence,
// never staging certification.

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const { generateKeyPairSync, randomBytes, X509Certificate } = require("node:crypto");
const { Client, Pool } = require("pg");
const { startHarness, available } = require("./harness");
const K = require("../../../karryam-admin/tests/helpers/fixtures");
const { startFakeBridge, bridgeConfigFor } = require("../../../karryam-admin/tests/helpers/fake-bridge");
const { generatePki } = require("../../../../packages/service-clients/tests/helpers/pki");
const { migrate } = require("../../../karryam-admin/scripts/migrate");
const { createApp: createKarryamApp } = require("../../../karryam-admin/src/server/app");
const { createPipelineStore, partitionKeyFor } = require("../../../karryam-admin/src/sync/store");
const { createBridgeConsumer } = require("../../../karryam-admin/src/sync/bridge-consumer");
const { createBridgeClient } = require("../../../karryam-admin/src/bridge/client");
const { pgAudit } = require("../../../karryam-admin/src/audit");
const { pgOperations } = require("../../../karryam-admin/src/db/operations");
const { pgApprovals } = require("../../../karryam-admin/src/db/approvals");
const { pgAccessLog } = require("../../../karryam-admin/src/db/access-log");
const { pgCertifications } = require("../../../karryam-admin/src/db/certifications");
const { createGovernanceStore } = require("../../../karryam-admin/src/db/governance");
const { pgNonceStore } = require("../../../karryam-admin/src/security/nonce-store");

const MARKET = "NG-LAGOS";
const ORG = "karryam-ng";
const ZONE = "lagos-island";
const scopeOf = (tenant = "tenant-a") => Object.freeze({ market: MARKET, organization: ORG, zone: ZONE, tenant });
const arraysOf = (s) => ({ market: [s.market], organization: [s.organization], zone: [s.zone], tenant: [s.tenant] });
const query = (s, extra = {}) => new URLSearchParams({ market: s.market, organization: s.organization, zone: s.zone, tenant: s.tenant, ...extra }).toString();

let opensslChecked = null;
function opensslAvailable() {
  if (opensslChecked === null) {
    try { generatePki({ serverName: "probe.internal" }).cleanup(); opensslChecked = true; } catch { opensslChecked = false; }
  }
  return opensslChecked;
}

// Why the journeys cannot run here, or null. With JOURNEYS_REQUIRED=1 a
// missing prerequisite is a failure, never a skip.
function missingPrerequisite() {
  if (!available()) return "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
  if (!opensslAvailable()) return "openssl unavailable (disposable TLS 1.3 Bridge PKI required)";
  return null;
}

function sourceSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

async function karryamDatabase(t) {
  const base = process.env.PIC_TEST_DATABASE_URL;
  const suffix = randomBytes(4).toString("hex");
  const db = "ka_jny_" + suffix;
  const runtime = "ka_jny_rt_" + suffix;
  const password = randomBytes(12).toString("hex");
  const admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${runtime}`);
  const url = (user, pass) => { const u = new URL(base); u.pathname = "/" + db; if (user) { u.username = user; u.password = pass; } return u.toString(); };
  await migrate({ connectionString: url(), runtimeRole: runtime });
  const pool = new Pool({ connectionString: url(runtime, password), max: 8 });
  pool.on("error", () => {});
  const owner = new Client({ connectionString: url() });
  await owner.connect();
  t.after(async () => {
    await pool.end().catch(() => {});
    await owner.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtime}`).catch(() => {});
    await admin.end();
  });
  return { pool, owner, runtime };
}

/**
 * Starts the full chain and onboards Karryam to ENABLED.
 *   tenants:          feed partitions (each one exact scope; all enrolled at the Bridge)
 *   datasets:         datasets the product certifies and HQ approves
 *   subscriptions:    datasets HQ subscribes to (scope = all tenants)
 *   enabledCommands / highRiskCertified: Karryam Admin command exposure
 *   bridgeClientOptions: protocol-server Bridge client options (e.g. commandTimeoutMs)
 *   manifestTtlSeconds:  manifest lifetime (long for clock-advance journeys)
 */
async function startJourneyEnv(t, {
  tenants = ["tenant-a"], datasets = ["karryam.sync_health"], subscriptions = [], enabledCommands = [], highRiskCertified = [],
  bridgeClientOptions = {}, manifestTtlSeconds = 3600,
} = {}) {
  const pki = generatePki({ serverName: "bridge.karryam.internal" });
  const ka = await karryamDatabase(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } } });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret, tenants });
  const clientFingerprint = new X509Certificate(pki.clientCert).fingerprint256.replace(/:/g, "").toLowerCase();

  const scopes = tenants.map(scopeOf);
  const feed = Object.freeze({ enabled: true, scopes, consumer: "karryam-admin-journeys", subject: "svc-karryam-admin", role: "hq.karryam.read", acr: "workload", purpose: "hq_event_sync", pageSize: 50, pollSeconds: 5, rewindEvents: 20, reconcileSeconds: 300, retentionDays: 7, leaseSeconds: 30 });
  const m = K.material();
  t.after(m.cleanup);
  const config = Object.freeze({
    ...K.loadConfig(K.enabledEnv(m, { KARRYAM_ADMIN_CERTIFIED_DATASETS: datasets.join(",") })),
    bridge, cursorKey: randomBytes(32), enabledCommands: Object.freeze(enabledCommands), highRiskCertified: Object.freeze(highRiskCertified), feed, manifestTtlSeconds,
  });
  const store = createPipelineStore(ka.pool, { serviceInstanceId: config.serviceInstanceId });
  const audit = pgAudit(ka.pool);
  const governance = createGovernanceStore(ka.pool);
  const deps = {
    audit, operations: pgOperations(ka.pool), approvals: pgApprovals(ka.pool), accessLog: pgAccessLog(ka.pool), certifications: pgCertifications(ka.pool), governance,
    nonceStore: pgNonceStore(ka.pool), pipeline: store, dbReady: async () => true, bridgeMetrics: {}, logger: () => {},
    bridgeClient: createBridgeClient(bridge, { metrics: {}, ...bridgeClientOptions }),
  };

  // Karryam Admin protocol server; restartable on the same port (the HQ
  // endpoint allowlist pins the origin).
  let server = null;
  let port = 0;
  async function startKarryam() {
    server = http.createServer(createKarryamApp(config, deps));
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
  }
  async function stopKarryam() {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
  }
  await startKarryam();
  t.after(stopKarryam);

  const worker = createBridgeConsumer({ feed, store, bridgeClient: createBridgeClient(bridge), workerId: "karryam-worker-journeys" });
  await worker.init();
  const consumerFor = async (opts = {}) => { const c = createBridgeConsumer({ feed, store, bridgeClient: createBridgeClient(bridge), ...opts }); await c.init(); return c; };

  const productScope = { market: [MARKET], organization: [ORG], zone: [ZONE], tenant: [...tenants] };
  const h = await startHarness({
    extraEndpoints: { "karryam-test": { product_id: "karryam", environment: "test", transport: "http-loopback", origin: "http://127.0.0.1:" + port, address: "127.0.0.1", service_auth: { key_id: "pic-k1", key_b64url: m.hqKey.toString("base64url") }, delegation: { kid: "d1", key_b64url: m.delegationKey.toString("base64url") } } },
    extraSigners: { "karryam-test-signer-1": { product_id: "karryam", environment: "test", public_key_pem: m.signer.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 7 * 86400000).toISOString() } },
  });
  t.after(h.close);

  const reg = await h.call("staff-requester", "POST", "/admin/product-integrations", {
    product_id: "karryam", display_name: "Karryam", service_instance_id: K.INSTANCE, environment: "test", endpoint_ref: "karryam-test",
    workload_identity: "cf://test/product-admin/karryam", approved_signer_kid: "karryam-test-signer-1", allowed_scope: productScope,
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const id = reg.json.data.id;
  const state = { revision: reg.json.data.revision };
  const step = async (who, path, body = {}) => {
    const r = await h.call(who, "POST", "/admin/product-integrations/" + id + path, { expected_revision: state.revision, ...body });
    if (r.status === 200 && r.json.data && r.json.data.revision) state.revision = r.json.data.revision;
    return r;
  };
  const must = async (who, path, body) => { const r = await step(who, path, body); assert.equal(r.status, 200, path + " " + JSON.stringify(r.json)); return r; };
  await must("staff-requester", "/verify-identity");
  await must("staff-requester", "/validate-contract");
  await must("staff-reviewer", "/review-policy", { evidence_ref: "review:journeys" });
  for (const ds of datasets) {
    const r = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/" + ds + "/approve", { version: "1.0.0" });
    assert.equal(r.status, 200, ds + " " + JSON.stringify(r.json));
  }
  await must("staff-reviewer", "/certify-staging", { evidence_ref: "ci:journeys" });
  await must("staff-approver", "/approve");
  for (const ds of subscriptions) {
    const sub = await h.call("staff-requester", "POST", "/admin/product-integrations/" + id + "/subscriptions", { dataset_id: ds, version: "1.0.0", consumer_department: "operations", allowed_scope: productScope, enabled: true, poll_interval_seconds: 30 });
    assert.equal(sub.status, 201, ds + " " + JSON.stringify(sub.json));
  }

  async function grant(staffId, { actions, datasets: grantDatasets, scope = arraysOf(scopes[0]), role = "karryam.ops.viewer" }) {
    const r = await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: "karryam", staff_id: staffId, role, actions, ...(grantDatasets ? { datasets: grantDatasets } : {}), scope });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.data.grant_id;
  }

  // Product operations switch, flipped by an independent approver.
  async function enableOperations() {
    await h.bootstrapPlatformGrant("staff-ops-approver", ["integration.read", "integration.approve", "integration.suspend"]);
    const on = await step("staff-ops-approver", "/operations/enable", { evidence_ref: "cab:journeys" });
    assert.equal(on.status, 200, JSON.stringify(on.json));
  }

  const hq = (sql, params) => h.pool.query(sql, params).then((r) => r.rows);
  const kaq = (sql, params) => ka.pool.query(sql, params).then((r) => r.rows);
  const bridgeCalls = (capability, predicate = () => true) => fake.state.requests.filter((r) => (!capability || r.capability === capability) && predicate(r));
  const metricPath = (metricId, s = scopes[0]) => "/products/karryam/metrics/" + metricId + "?" + query(s);

  return {
    h, fake, pki, ka, store, audit, governance, config, deps, worker, consumerFor, id, state, step, must, grant, enableOperations, hq, kaq, bridgeCalls, metricPath,
    scopes, productScope, clientFingerprint, partitionKey: (tenant = tenants[0]) => partitionKeyFor(scopeOf(tenant)),
    karryam: { start: startKarryam, stop: stopKarryam, get port() { return port; } },
  };
}

module.exports = { startJourneyEnv, missingPrerequisite, sourceSha, scopeOf, arraysOf, query, MARKET, ORG, ZONE };
