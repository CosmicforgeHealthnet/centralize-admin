"use strict";

// Karryam Admin is the first real Product Admin. Through the same generic HQ
// registry it can prove its identity and contract, but it stays unavailable:
// its datasets and events are honestly NOT_CERTIFIED (Sections 6-9 pending),
// so HQ refuses to approve them and the integration cannot be enabled.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, available } = require("./helpers/harness");
const K = require("../../karryam-admin/tests/helpers/fixtures");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";

test("Karryam Admin onboards through the generic registry and remains unavailable until certified", { skip }, async () => {
  const m = K.material();
  const karryam = await K.startApp(K.loadConfig(K.enabledEnv(m)));
  const h = await startHarness({
    extraEndpoints: { "karryam-test": { product_id: "karryam", environment: "test", transport: "http-loopback", origin: "http://127.0.0.1:" + karryam.port, address: "127.0.0.1", service_auth: { key_id: "pic-k1", key_b64url: m.hqKey.toString("base64url") }, delegation: { kid: "d1", key_b64url: m.delegationKey.toString("base64url") } } },
    extraSigners: { "karryam-test-signer-1": { product_id: "karryam", environment: "test", public_key_pem: m.signer.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 86400000).toISOString() } },
  });
  try {
    const reg = await h.call("staff-requester", "POST", "/admin/product-integrations", {
      product_id: "karryam", display_name: "Karryam", service_instance_id: K.INSTANCE, environment: "test", endpoint_ref: "karryam-test",
      workload_identity: "cf://test/product-admin/karryam", approved_signer_kid: "karryam-test-signer-1", allowed_scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"] },
    });
    assert.equal(reg.status, 201);
    const id = reg.json.data.id;
    let rev = reg.json.data.revision;
    for (const [who, path] of [["staff-requester", "/verify-identity"], ["staff-requester", "/validate-contract"], ["staff-reviewer", "/review-policy"]]) {
      const r = await h.call(who, "POST", "/admin/product-integrations/" + id + path, { expected_revision: rev });
      assert.equal(r.status, 200, path + " " + JSON.stringify(r.json));
      rev = r.json.data.revision;
    }
    const detail = await h.call("staff-reviewer", "GET", "/admin/product-integrations/" + id);
    const contract = detail.json.data.contracts[0];
    assert.equal(contract.status, "VALIDATED");
    const [{ catalog }] = (await h.pool.query("SELECT catalog FROM hq_integration.hq_product_admin_contracts WHERE id = $1", [contract.id])).rows;
    assert.equal(catalog.product_id, "karryam");
    assert.ok(catalog.capabilities.every((c) => c.state !== "AVAILABLE")); // nothing claims to be executable
    assert.ok(catalog.capabilities.filter((c) => c.kind === "COMMAND").every((c) => c.state === "DISABLED"));
    assert.ok(catalog.datasets.every((d) => d.readiness === "NOT_CERTIFIED"));

    for (const ds of catalog.datasets) {
      const r = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/" + ds.dataset_id + "/approve", { version: ds.version });
      assert.equal(r.status, 409);
      assert.equal(r.json.error.reason, "DATASET_NOT_CERTIFIED_BY_PRODUCT");
    }
    const certify = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/certify-staging", { expected_revision: rev, evidence_ref: "ci:karryam-attempt" });
    assert.equal(certify.status, 409);
    assert.equal(certify.json.error.reason, "NO_APPROVED_DATASET");

    await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: "karryam", staff_id: "staff-ops", role: "karryam.capabilities.viewer", actions: ["product.view", "product.capabilities.read"], scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"] } });
    const nav = await h.call("staff-ops", "GET", "/products");
    assert.deepEqual(nav.json.data.products.map((p) => [p.product_id, p.available, p.reason]), [["karryam", false, "NOT_ENABLED"]]);
    const caps = await h.call("staff-ops", "GET", "/products/karryam/capabilities");
    assert.equal(caps.status, 503);
    assert.equal(caps.json.error.reason, "PRODUCT_NOT_ENABLED");
    assert.deepEqual(await h.engine.tick(), []);
  } finally {
    await h.close();
    await karryam.close();
    m.cleanup();
  }
});
