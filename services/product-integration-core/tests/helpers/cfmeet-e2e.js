"use strict";

// Disposable end-to-end environment for CF Meet: real HQ Product Integration
// Core (its own PostgreSQL) + real CF Meet Admin (its own PostgreSQL) +
// disposable secure CF Meet Admin Bridge (TLS 1.3 mTLS, HMAC v2, Ed25519,
// approval claim, pinned interface v1 contract). CF Meet is onboarded through
// the generic HQ registry exactly as any product would be. Nothing here is a
// live credential.

const assert = require("node:assert/strict");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { startHarness } = require("./harness");
const M = require("../../../cfmeet-admin/tests/helpers/fixtures");
const { startFakeBridge, bridgeConfigFor } = require("../../../cfmeet-admin/tests/helpers/fake-bridge");
const { generatePki } = require("../../../../packages/service-clients/tests/helpers/pki");
const { migrate } = require("../../../cfmeet-admin/scripts/migrate");

const SCOPE = Object.freeze({ market: "NG-LAGOS", organization: "cfmeet-ng", zone: "lagos-island", tenant: "tenant-a" });
const ALLOWED = Object.freeze({ market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] });

async function cfmeetDatabase(t) {
  const base = process.env.PIC_TEST_DATABASE_URL;
  const suffix = randomBytes(4).toString("hex");
  const db = "cfm_ops_" + suffix;
  const runtime = "cfm_ops_rt_" + suffix;
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
  return { pool };
}

/** Starts everything and onboards CF Meet to ENABLED (one certified dataset: sync health). */
async function startCfmeetThroughHq(t, { configOverrides = {}, cfmeetDeps = () => ({}) } = {}) {
  const pki = generatePki({ serverName: "bridge.cfmeet.internal" });
  const cm = await cfmeetDatabase(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } } });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret });
  const m = M.material();
  t.after(m.cleanup);
  const config = Object.freeze({ ...M.loadConfig(M.enabledEnv(m, { CFMEET_ADMIN_CERTIFIED_DATASETS: "cfmeet.sync_health" })), bridge, cursorKey: randomBytes(32), enabledCommands: [], ...configOverrides });
  const cfmeet = await M.startApp(config, cfmeetDeps(cm.pool));
  t.after(cfmeet.close);

  const h = await startHarness({
    extraEndpoints: { "cfmeet-test": { product_id: "cfmeet", environment: "test", transport: "http-loopback", origin: "http://127.0.0.1:" + cfmeet.port, address: "127.0.0.1", service_auth: { key_id: "pic-k1", key_b64url: m.hqKey.toString("base64url") }, delegation: { kid: "d1", key_b64url: m.delegationKey.toString("base64url") } } },
    extraSigners: { "cfmeet-test-signer-1": { product_id: "cfmeet", environment: "test", public_key_pem: m.signer.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 86400000).toISOString() } },
  });
  t.after(h.close);

  const reg = await h.call("staff-requester", "POST", "/admin/product-integrations", {
    product_id: "cfmeet", display_name: "CF Meet", service_instance_id: M.INSTANCE, environment: "test", endpoint_ref: "cfmeet-test",
    workload_identity: "cf://test/product-admin/cfmeet", approved_signer_kid: "cfmeet-test-signer-1", allowed_scope: ALLOWED,
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const id = reg.json.data.id;
  const state = { revision: reg.json.data.revision };
  const must = async (who, path, body = {}) => {
    const r = await h.call(who, "POST", "/admin/product-integrations/" + id + path, { expected_revision: state.revision, ...body });
    assert.equal(r.status, 200, path + " " + JSON.stringify(r.json));
    if (r.json.data && r.json.data.revision) state.revision = r.json.data.revision;
    return r;
  };
  await must("staff-requester", "/verify-identity");
  await must("staff-requester", "/validate-contract");
  await must("staff-reviewer", "/review-policy", { evidence_ref: "review:cfmeet" });
  const ds = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/cfmeet.sync_health/approve", { version: "1.0.0" });
  assert.equal(ds.status, 200, JSON.stringify(ds.json));
  await must("staff-reviewer", "/certify-staging", { evidence_ref: "ci:cfmeet" });
  await must("staff-approver", "/approve");
  return { h, m, fake, cm, cfmeet, config, id, state };
}

module.exports = { startCfmeetThroughHq, SCOPE, ALLOWED };
