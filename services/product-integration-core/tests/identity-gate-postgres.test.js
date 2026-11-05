"use strict";

// Spec 5.6 step 6 and 5.9: synchronization stops when the product's approved
// signer or signed manifest can no longer be verified, and resumes only after
// a health check verifies a valid manifest from the same approved signer.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, available } = require("./helpers/harness");
const { createHealthChecker } = require("../src/registry/health");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
const rows = (h, sql, params) => h.pool.query(sql, params).then((r) => r.rows);
const inboxCount = async (h) => Number((await rows(h, "SELECT count(*) AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n);
const registration = async (h, id) => (await rows(h, "SELECT * FROM hq_integration.hq_product_admins WHERE id = $1", [id]))[0];
const withSigner = (h, change) => {
  const kid = h.product.signer.kid;
  return { ...h.trustStore, [kid]: { ...h.trustStore[kid], ...change } };
};

test("a revoked, expired or missing signer stops synchronization before any request is sent", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitMetric({ value: 7 });
    const cases = [
      [withSigner(h, { revoked: true }), "SIGNER_REVOKED"],
      [withSigner(h, { notAfter: new Date(h.now() - 1000).toISOString() }), "SIGNER_EXPIRED"],
      [withSigner(h, { productId: "another-product" }), "SIGNER_SCOPE_MISMATCH"],
      [{}, "SIGNER_UNKNOWN"],
      [undefined, "TRUST_STORE_UNAVAILABLE"],
    ];
    for (const [trustStore, reason] of cases) {
      const before = h.product.state.requests;
      const engine = h.makeEngine({ workerId: "pic-worker-" + reason.toLowerCase().replace(/_/g, "-"), trustStore });
      const [result] = await engine.tick();
      assert.equal(result.status, "BLOCKED_IDENTITY", reason);
      assert.equal(result.reason, reason);
      assert.equal(h.product.state.requests, before, "no request reached the Product Admin for " + reason);
    }
    assert.equal(await inboxCount(h), 0);
    const alerts = await rows(h, "SELECT reason_code FROM hq_integration.hq_product_admin_security_audit WHERE action = 'integration.alert'");
    assert.ok(alerts.some((a) => a.reason_code === "SIGNER_REVOKED"), "a sanitized alert is recorded");

    // The trusted configuration still works.
    const [ok] = await h.engine.tick();
    assert.equal(ok.status, "DONE");
    assert.equal(await inboxCount(h), 1);
  } finally { await h.close(); }
});

test("identity drift found by a health check blocks synchronization and navigation until re-verified", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id } = await h.registerAndEnable();
    await h.grantViewer();
    const revokedHealth = createHealthChecker({ pool: h.pool, endpoints: h.endpoints, trustStore: withSigner(h, { revoked: true }), now: h.now });
    const check = await revokedHealth.check(await registration(h, id));
    assert.equal(check.drift_status, "IDENTITY_MISMATCH");
    assert.equal(check.reason, "SIGNER_REVOKED");

    h.product.emitMetric({ value: 3 });
    const before = h.product.state.requests;
    const [blocked] = await h.engine.tick();
    assert.equal(blocked.status, "BLOCKED_IDENTITY");
    assert.equal(blocked.reason, "IDENTITY_MISMATCH");
    assert.equal(h.product.state.requests, before);
    const nav = await h.call("staff-viewer", "GET", "/products");
    assert.equal(nav.json.data.products[0].available, false);
    assert.equal(nav.json.data.products[0].reason, "IDENTITY_NOT_VERIFIED");
    assert.equal(nav.json.data.products[0].navigation, null);

    const health = createHealthChecker({ pool: h.pool, endpoints: h.endpoints, trustStore: h.trustStore, now: h.now });
    assert.equal((await health.check(await registration(h, id))).drift_status, "NONE");
    const [resumed] = await h.engine.tick();
    assert.equal(resumed.status, "DONE");
    assert.equal(await inboxCount(h), 1);
    assert.equal((await h.call("staff-viewer", "GET", "/products")).json.data.products[0].available, true);
  } finally { await h.close(); }
});

test("an expired stored manifest stops synchronization; a verified health check refreshes it", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id } = await h.registerAndEnable();
    await h.pool.query("UPDATE hq_integration.hq_product_admins SET manifest_expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    h.product.emitMetric({ value: 4 });
    const [blocked] = await h.engine.tick();
    assert.equal(blocked.status, "BLOCKED_IDENTITY");
    assert.equal(blocked.reason, "MANIFEST_EXPIRED");

    const health = createHealthChecker({ pool: h.pool, endpoints: h.endpoints, trustStore: h.trustStore, now: h.now });
    await health.check(await registration(h, id));
    const refreshed = await registration(h, id);
    assert.ok(refreshed.manifest_expires_at.getTime() > h.now(), "expiry refreshed from the verified manifest");
    const [resumed] = await h.engine.tick();
    assert.equal(resumed.status, "DONE");
    assert.equal(await inboxCount(h), 1);
  } finally { await h.close(); }
});

test("subscriptions of a revoked registration cannot be changed", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id, revision, subscriptionId } = await h.registerAndEnable();
    const base = "/admin/product-integrations/" + id;
    const suspended = await h.call("staff-approver", "POST", base + "/suspend", { expected_revision: revision, reason_code: "TEST_SUSPEND" });
    assert.equal(suspended.status, 200);
    const revoked = await h.call("staff-approver", "POST", base + "/revoke", { expected_revision: suspended.json.data.revision, reason_code: "TEST_REVOKE" });
    assert.equal(revoked.status, 200);
    for (const action of ["enable", "disable"]) {
      const r = await h.call("staff-requester", "POST", base + "/subscriptions/" + subscriptionId + "/" + action, {});
      assert.equal(r.status, 409, action);
      assert.equal(r.json.error.reason, "REGISTRATION_TERMINAL");
    }
  } finally { await h.close(); }
});

test("the navigation dataset flag applies the same decision as reads, including explicit deny", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    await h.grantViewer();
    const datasetFlag = async () => (await h.call("staff-viewer", "GET", "/products")).json.data.products[0].datasets[0].granted;
    assert.equal(await datasetFlag(), true);
    await h.grantViewer("staff-viewer", { effect: "DENY", role: null, actions: ["metric.read"], scope: {} });
    assert.equal(await datasetFlag(), false);
    const read = await h.call("staff-viewer", "GET", "/products/" + h.product.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
    assert.equal(read.status, 403);
  } finally { await h.close(); }
});
