"use strict";

// Security-negative coverage of the PIC internal API.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { generateKeyPairSync } = require("node:crypto");
const { startHarness, available } = require("./helpers/harness");
const { createApp } = require("../src/api/app");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";

test("caller authentication: missing, replayed, rebound, duplicated or forged delegations are refused", { skip }, async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.call("staff-requester", "GET", "/admin/product-integrations", undefined, { raw: true })).status, 401);
    const first = await h.call("staff-requester", "GET", "/admin/product-integrations");
    assert.equal(first.status, 200);
    const replay = await h.call("staff-requester", "GET", "/admin/product-integrations", undefined, { token: first.token });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error.reason, "DELEGATION_REPLAYED");
    const rebound = await h.call("staff-requester", "GET", "/admin/product-integrations", undefined, { tamper: { path: "/products" } });
    assert.equal(rebound.status, 401);
    assert.equal(rebound.json.error.reason, "DELEGATION_INVALID");
    const forged = first.token.split(".");
    forged[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(forged[1], "base64url")), sub: "staff-approver", jti: "x-" + Date.now() })).toString("base64url");
    assert.equal((await h.call("staff-requester", "GET", "/admin/product-integrations", undefined, { token: forged.join(".") })).status, 401);
    const dup = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: h.port, path: "/internal/pic/v1/products", headers: ["Host", "127.0.0.1", "X-CF-HQ-Delegation", first.token, "X-CF-HQ-Delegation", first.token] }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(dup, 401);
  } finally { await h.close(); }
});

test("product access needs explicit grants: no SUPER bypass, expiry, revocation, datasets, scope", { skip }, async () => {
  const h = await startHarness();
  const P = h.product;
  try {
    await h.registerAndEnable();
    // SUPER tier without any product grant sees nothing and is denied.
    const superList = await h.call("staff-super", "GET", "/products");
    assert.deepEqual(superList.json.data.products, []);
    const superRead = await h.call("staff-super", "GET", "/products/" + P.PRODUCT_ID + "/datasets");
    assert.equal(superRead.status, 403);
    assert.equal(superRead.json.error.reason, "MISSING_PRODUCT_GRANT");
    // Platform admins have no implicit product data access either.
    assert.equal((await h.call("staff-approver", "GET", "/products/" + P.PRODUCT_ID + "/manifest")).status, 403);

    // Grant without dataset access.
    await h.grantViewer("staff-nodata", { datasets: [] });
    const nodata = await h.call("staff-nodata", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
    assert.equal(nodata.status, 403);
    assert.equal(nodata.json.error.reason, "MISSING_DATASET_GRANT");

    // Expiry.
    await h.grantViewer("staff-temp", { expires_at: new Date(Date.now() + 3600000).toISOString() });
    assert.equal((await h.call("staff-temp", "GET", "/products/" + P.PRODUCT_ID + "/datasets")).status, 200);
    h.clock.offsetMs = 2 * 3600000;
    const expired = await h.call("staff-temp", "GET", "/products/" + P.PRODUCT_ID + "/datasets");
    h.clock.offsetMs = 0;
    assert.equal(expired.status, 403);
    assert.equal(expired.json.error.reason, "GRANT_EXPIRED");

    // Revocation.
    const grantId = await h.grantViewer("staff-revoked");
    assert.equal((await h.call("staff-requester", "POST", "/admin/product-integration-grants/" + grantId + "/revoke", { reason_code: "OFFBOARDED" })).status, 200);
    const revoked = await h.call("staff-revoked", "GET", "/products/" + P.PRODUCT_ID + "/datasets");
    assert.equal(revoked.json.error.reason, "GRANT_REVOKED");

    // Cross-market and wildcard scope.
    await h.grantViewer("staff-viewer");
    const cross = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=GH&tenant=tenant-a");
    assert.equal(cross.status, 403);
    const wildcard = await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: P.PRODUCT_ID, staff_id: "staff-wild", actions: ["product.view"], scope: { market: ["*"], organization: ["cosmicforge"] } });
    assert.equal(wildcard.status, 400);
    const beyond = await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: P.PRODUCT_ID, staff_id: "staff-wide", actions: ["product.view"], scope: { market: ["KE"], organization: ["cosmicforge"] } });
    assert.equal(beyond.status, 403);
    assert.equal(beyond.json.error.reason, "SCOPE_EXCEEDS_PRODUCT");

    // Unknown dataset / metric.
    assert.equal((await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.nonexistent")).status, 404);

    // Live capability read carries the delegated staff and effective scope, never more.
    const caps = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/capabilities");
    assert.equal(caps.status, 200);
    assert.equal(caps.json.result.delegated_staff, "staff-viewer");
    assert.deepEqual(caps.json.result.delegated_scope.tenant, ["tenant-a"]);
    const noMfa = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/capabilities", undefined, { mfa: false });
    assert.equal(noMfa.json.error.reason, "RECENT_MFA_REQUIRED");

    // Disabled writes cannot execute and are never forwarded.
    const before = P.state.requests;
    for (const body of [{ capability_id: "synthetic.order.cancel", params: {} }, { capability_id: "wallet.refund" }, { command: "DROP TABLE" }]) {
      const op = await h.call("staff-viewer", "POST", "/products/" + P.PRODUCT_ID + "/operations", body);
      assert.equal(op.status, 403);
      assert.equal(op.json.error.code, "DISABLED");
    }
    assert.equal(P.state.requests, before);

    // Denials are audited.
    const denied = await h.pool.query("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_security_audit WHERE outcome = 'DENIED'");
    assert.ok(denied.rows[0].n >= 5);
  } finally { await h.close(); }
});

test("registration is pinned: environment, endpoint allowlist, product binding and signer enrollment", { skip }, async () => {
  const other = generateKeyPairSync("ed25519");
  const h = await startHarness({
    extraEndpoints: { "other-product-ep": { product_id: "other-product", environment: "test", transport: "http-loopback", origin: "http://127.0.0.1:9", address: "127.0.0.1", service_auth: { key_id: "k", key_b64url: Buffer.alloc(32, 1).toString("base64url") }, delegation: { kid: "d", key_b64url: Buffer.alloc(32, 2).toString("base64url") } } },
    extraSigners: { "synthetic-signer-2": { product_id: "synthetic-third", environment: "test", public_key_pem: other.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 86400000).toISOString() } },
  });
  const base = { product_id: "synthetic-third", display_name: "Synthetic", service_instance_id: "synthetic-third-test-1", environment: "test", endpoint_ref: "synthetic-third-test", workload_identity: "cf://test/product-admin/synthetic-third", approved_signer_kid: "synthetic-signer-1", allowed_scope: { market: ["NG"], organization: ["cosmicforge"] } };
  const reg = (body) => h.call("staff-requester", "POST", "/admin/product-integrations", body);
  try {
    assert.equal((await reg({ ...base, environment: "staging" })).json.error.reason, "ENVIRONMENT_ISOLATION");
    assert.equal((await reg({ ...base, endpoint_ref: "https-attacker" })).json.error.reason, "ENDPOINT_NOT_ALLOWLISTED");
    assert.equal((await reg({ ...base, endpoint_ref: "other-product-ep" })).json.error.reason, "ENDPOINT_PRODUCT_MISMATCH");
    assert.equal((await reg({ ...base, approved_signer_kid: "unknown-kid" })).json.error.reason, "SIGNER_NOT_ENROLLED");
    assert.equal((await reg({ ...base, endpoint_url: "http://169.254.169.254/" })).json.error.reason, "UNKNOWN_FIELD");
    assert.equal((await reg({ ...base, allowed_scope: { market: ["*"], organization: ["x"] } })).json.error.reason, "ALLOWED_SCOPE_INVALID");
    const noMfa = await h.call("staff-requester", "POST", "/admin/product-integrations", base, { mfa: false });
    assert.equal(noMfa.json.error.reason, "RECENT_MFA_REQUIRED");
    // Approved signer differs from the key the product actually signs with.
    const wrong = await reg({ ...base, approved_signer_kid: "synthetic-signer-2" });
    assert.equal(wrong.status, 201);
    const verify = await h.call("staff-requester", "POST", "/admin/product-integrations/" + wrong.json.data.id + "/verify-identity", { expected_revision: wrong.json.data.revision });
    assert.equal(verify.status, 422);
    assert.equal(verify.json.error.reason, "SIGNER_NOT_APPROVED");
    const history = await h.pool.query("SELECT decision, reason_code FROM hq_integration.hq_product_admin_onboarding_approvals WHERE decision = 'IDENTITY_CHECK_FAILED'");
    assert.equal(history.rows[0].reason_code, "SIGNER_NOT_APPROVED");
    // A second live registration for the same product is refused.
    assert.equal((await reg(base)).json.error.reason, "ALREADY_REGISTERED");
  } finally { await h.close(); }
});

test("a disabled core refuses every API call", async () => {
  const app = createApp({ enabled: false, pool: null, endpoints: new Map(), trustStore: {}, hqDelegationKeys: {}, environment: "disabled", nonceStore: null });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const get = (path) => new Promise((resolve) => http.get({ host: "127.0.0.1", port: server.address().port, path }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(d) })); }));
    assert.equal((await get("/health/live")).status, 200);
    assert.equal((await get("/health/ready")).status, 503);
    const r = await get("/internal/pic/v1/products");
    assert.equal(r.status, 503);
    assert.equal(r.json.error.reason, "PRODUCT_INTEGRATION_DISABLED");
  } finally { server.close(); }
});
