"use strict";

// End-to-end harness: disposable PostgreSQL + PIC internal API + synthetic
// third Product Admin, wired exactly as production wires them (operator
// endpoint allowlist, signer trust store, HQ delegation keys).

const http = require("node:http");
const { once } = require("node:events");
const { randomBytes, randomUUID } = require("node:crypto");
const I = require("../../../../packages/identity-and-permissions");
const db = require("./db");
const { startSyntheticProductAdmin } = require("./synthetic-product-admin");
const { buildEndpoints, buildTrustStore } = require("../../src/registry/endpoints");
const { createApp } = require("../../src/api/app");
const { createNonceStore } = require("../../src/db");
const { createSyncEngine } = require("../../src/sync/engine");

const PLATFORM_ROLES = {
  requester: ["integration.read", "integration.request", "integration.verify", "integration.subscriptions.manage", "integration.grants.manage"],
  reviewer: ["integration.read", "integration.review", "integration.certify"],
  approver: ["integration.read", "integration.approve", "integration.suspend", "integration.revoke", "integration.subscriptions.manage"],
};

async function startHarness({ extraEndpoints = {}, extraSigners = {} } = {}) {
  const database = await db.createDisposableDatabase();
  const product = await startSyntheticProductAdmin();
  const endpoints = buildEndpoints({ endpoints: { ...product.endpointConfig(), ...extraEndpoints } }, { environment: "test", allowInsecureLoopback: true });
  const trustStore = buildTrustStore({ signers: { ...product.signerConfig(), ...extraSigners } }, { environment: "test" });
  const hqKey = randomBytes(32);
  const hqDelegationKeys = { "hq-k1": { key: hqKey } };
  const clock = { offsetMs: 0 };
  const now = () => Date.now() + clock.offsetMs;
  const engines = [];
  const makeEngine = (options = {}) => {
    const engine = createSyncEngine({ pool: database.pool, endpoints, environment: "test", now, leaseSeconds: 30, ...options });
    engines.push(engine);
    return engine;
  };
  const defaultEngine = makeEngine({ workerId: "pic-worker-a" });
  const app = createApp({ pool: database.pool, endpoints, trustStore, hqDelegationKeys, environment: "test", nonceStore: createNonceStore(database.pool), now, syncEngine: defaultEngine });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  const nowS = () => Math.floor(now() / 1000);
  const subjects = {};
  function subject(staffId, { mfa = true } = {}) {
    return { staffId, sessionId: "sess-" + staffId, authTime: nowS() - 60, mfaAt: mfa ? nowS() - 10 : null, tier: "SUPER" };
  }

  // Calls the PIC API as the Central Admin API would after session checks.
  function call(who, method, path, body, { mfa = true, tamper = null, raw = false, token: forcedToken } = {}) {
    const s = typeof who === "string" ? subject(who, { mfa }) : who;
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const fullPath = "/internal/pic/v1" + path;
    const token = forcedToken || I.signDelegation({ iss: "central-admin-api", aud: "product-integration-core", sub: s.staffId, sid: s.sessionId, auth_time: s.authTime, mfa_at: s.mfaAt, tier: s.tier, bnd: I.requestBinding(method, tamper && tamper.path ? "/internal/pic/v1" + tamper.path : fullPath, payload) }, { key: hqKey, kid: "hq-k1", typ: I.TYPES.HQ, now: now() });
    return new Promise((resolve, reject) => {
      const headers = { Accept: "application/json" };
      if (!raw) headers["X-CF-HQ-Delegation"] = token;
      if (payload.length) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = payload.length; }
      const req = http.request({ host: "127.0.0.1", port, method, path: fullPath, headers }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(data), token }); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.end(payload.length ? payload : undefined);
    });
  }

  // Operator bootstrap of platform grants (what scripts/bootstrap-platform-grant.js does).
  async function bootstrapPlatformGrant(staffId, actions) {
    await database.pool.query(`INSERT INTO hq_integration.hq_product_admin_grants (id, grant_kind, staff_id, effect, actions, granted_by) VALUES ($1,'PLATFORM',$2,'ALLOW',$3,'operator-bootstrap')`, [randomUUID(), staffId, actions]);
  }
  for (const [role, actions] of Object.entries(PLATFORM_ROLES)) await bootstrapPlatformGrant("staff-" + role, actions);

  async function registerAndEnable({ allowedScope = { market: ["NG", "GH"], organization: ["cosmicforge"], tenant: ["tenant-a", "tenant-b"] }, subscriptionScope = { market: ["NG"], organization: ["cosmicforge"], tenant: ["tenant-a"] } } = {}) {
    const reg = await call("staff-requester", "POST", "/admin/product-integrations", {
      product_id: product.PRODUCT_ID, display_name: "Synthetic Third Product", service_instance_id: product.INSTANCE_ID, environment: "test",
      endpoint_ref: "synthetic-third-test", workload_identity: "cf://test/product-admin/synthetic-third", approved_signer_kid: product.signer.kid, allowed_scope: allowedScope,
    });
    if (reg.status !== 201) throw new Error("register failed " + JSON.stringify(reg.json));
    const id = reg.json.data.id;
    let rev = reg.json.data.revision;
    const step = async (who, path, body = {}) => {
      const r = await call(who, "POST", "/admin/product-integrations/" + id + path, { expected_revision: rev, ...body });
      if (r.status !== 200) throw new Error(path + " failed " + JSON.stringify(r.json));
      if (r.json.data.revision) rev = r.json.data.revision;
      return r;
    };
    await step("staff-requester", "/verify-identity");
    await step("staff-requester", "/validate-contract");
    await step("staff-reviewer", "/review-policy", { evidence_ref: "review:policy-1" });
    const ds = await call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/" + product.DATASET_ID + "/approve", { version: "1.0.0" });
    if (ds.status !== 200) throw new Error("dataset approve failed " + JSON.stringify(ds.json));
    await step("staff-reviewer", "/certify-staging", { evidence_ref: "ci:conformance-run-1" });
    await step("staff-approver", "/approve");
    const sub = await call("staff-requester", "POST", "/admin/product-integrations/" + id + "/subscriptions", { dataset_id: product.DATASET_ID, version: "1.0.0", consumer_department: "analytics", allowed_scope: subscriptionScope, enabled: true, poll_interval_seconds: 30 });
    if (sub.status !== 201) throw new Error("subscription failed " + JSON.stringify(sub.json));
    return { id, revision: rev, subscriptionId: sub.json.data.subscription_id };
  }

  async function grantViewer(staffId = "staff-viewer", overrides = {}) {
    const r = await call("staff-requester", "POST", "/admin/product-integration-grants", {
      grant_kind: "PRODUCT", product_id: product.PRODUCT_ID, staff_id: staffId, role: "synthetic.viewer",
      actions: ["product.view", "product.manifest.read", "product.capabilities.read", "dataset.list", "metric.read", "events.status.read", "operation.read", "operation.submit"],
      datasets: [product.DATASET_ID], scope: { market: ["NG"], organization: ["cosmicforge"], tenant: ["tenant-a"] }, ...overrides,
    });
    if (r.status !== 201) throw new Error("grant failed " + JSON.stringify(r.json));
    return r.json.data.grant_id;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await product.close();
    await database.drop();
  }

  return { database, pool: database.pool, product, endpoints, trustStore, app, port, call, subject, clock, now, makeEngine, engine: defaultEngine, bootstrapPlatformGrant, registerAndEnable, grantViewer, close, subjects };
}

module.exports = { startHarness, PLATFORM_ROLES, available: db.available };
