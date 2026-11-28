"use strict";

// Disposable end-to-end environment: real HQ Product Integration Core (its
// own PostgreSQL) + real Karryam Admin (its own PostgreSQL) + disposable
// secure Bridge (TLS 1.3 mTLS, HMAC v2, Ed25519, pinned contract). Karryam is
// onboarded through the generic HQ registry exactly as any product would
// be. Nothing here is a live credential.

const assert = require("node:assert/strict");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { Client, Pool } = require("pg");
const { startHarness } = require("./harness");
const K = require("../../../karryam-admin/tests/helpers/fixtures");
const { startFakeBridge, bridgeConfigFor } = require("../../../karryam-admin/tests/helpers/fake-bridge");
const { generatePki } = require("../../../../packages/service-clients/tests/helpers/pki");
const { migrate } = require("../../../karryam-admin/scripts/migrate");

const SCOPE = Object.freeze({ market: "NG-LAGOS", organization: "karryam-ng", zone: "lagos-island", tenant: "tenant-a" });
const ALLOWED = Object.freeze({ market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] });

async function karryamDatabase(t) {
  const base = process.env.PIC_TEST_DATABASE_URL;
  const suffix = randomBytes(4).toString("hex");
  const db = "ka_ops_" + suffix;
  const runtime = "ka_ops_rt_" + suffix;
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
  const owner = new Client({ connectionString: url() });
  await owner.connect();
  t.after(async () => {
    await pool.end().catch(() => {});
    await owner.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${runtime}`).catch(() => {});
    await admin.end();
  });
  return { pool, owner };
}

/**
 * Starts everything and onboards Karryam to ENABLED. `karryamDeps(pool)`
 * returns extra Karryam Admin dependencies; `configOverrides` adjusts its
 * configuration (enabled commands, high-risk exposure).
 */
async function startKarryamThroughHq(t, { configOverrides = {}, karryamDeps = () => ({}) } = {}) {
  const pki = generatePki({ serverName: "bridge.karryam.internal" });
  const ka = await karryamDatabase(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } } });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret });
  const m = K.material();
  t.after(m.cleanup);
  const config = Object.freeze({ ...K.loadConfig(K.enabledEnv(m, { KARRYAM_ADMIN_CERTIFIED_DATASETS: "karryam.sync_health" })), bridge, cursorKey: randomBytes(32), enabledCommands: [], ...configOverrides });
  const karryam = await K.startApp(config, karryamDeps(ka.pool));
  t.after(karryam.close);

  const h = await startHarness({
    extraEndpoints: { "karryam-test": { product_id: "karryam", environment: "test", transport: "http-loopback", origin: "http://127.0.0.1:" + karryam.port, address: "127.0.0.1", service_auth: { key_id: "pic-k1", key_b64url: m.hqKey.toString("base64url") }, delegation: { kid: "d1", key_b64url: m.delegationKey.toString("base64url") } } },
    extraSigners: { "karryam-test-signer-1": { product_id: "karryam", environment: "test", public_key_pem: m.signer.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 86400000).toISOString() } },
  });
  t.after(h.close);

  const reg = await h.call("staff-requester", "POST", "/admin/product-integrations", {
    product_id: "karryam", display_name: "Karryam", service_instance_id: K.INSTANCE, environment: "test", endpoint_ref: "karryam-test",
    workload_identity: "cf://test/product-admin/karryam", approved_signer_kid: "karryam-test-signer-1", allowed_scope: ALLOWED,
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
  await must("staff-reviewer", "/review-policy", { evidence_ref: "review:karryam-ops" });
  // One approved dataset is required to enable a product; Karryam certifies sync health here.
  const ds = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/karryam.sync_health/approve", { version: "1.0.0" });
  assert.equal(ds.status, 200, JSON.stringify(ds.json));
  await must("staff-reviewer", "/certify-staging", { evidence_ref: "ci:karryam-ops" });
  await must("staff-approver", "/approve");
  return { h, m, fake, ka, karryam, config, id, state, step, must };
}

module.exports = { startKarryamThroughHq, SCOPE, ALLOWED };
