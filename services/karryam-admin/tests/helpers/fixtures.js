"use strict";

// Test fixtures. All key material is generated per test run in a temp dir;
// nothing here is a real credential and nothing is committed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const { contracts, clients, identity } = require("../../src/packages");
const { loadConfig } = require("../../src/config");
const { createApp } = require("../../src/server/app");
const { memoryAudit } = require("../../src/audit");
const { memoryOperations } = require("../../src/db/operations");
const { memoryNonceStore } = require("../../src/security/nonce-store");

const INSTANCE = "karryam-admin-test-1";
const SERVICE_ID = "hq-product-integration-core";

function material() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "karryam-admin-test-"));
  const hqKey = randomBytes(32);
  const delegationKey = randomBytes(32);
  const signer = generateKeyPairSync("ed25519");
  const write = (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content, { mode: 0o600 }); return file; };
  const notAfter = new Date(Date.now() + 86400000).toISOString();
  return {
    dir, hqKey, delegationKey, signer,
    write,
    serviceKeysFile: write("hq-service-keys.json", JSON.stringify({ "pic-k1": { service_id: SERVICE_ID, key_b64url: hqKey.toString("base64url"), not_after: notAfter } })),
    delegationKeysFile: write("delegation-keys.json", JSON.stringify({ d1: { key_b64url: delegationKey.toString("base64url"), not_after: notAfter } })),
    signerFile: write("manifest-signer.pem", signer.privateKey.export({ type: "pkcs8", format: "pem" })),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function enabledEnv(m, overrides = {}) {
  return {
    KARRYAM_ADMIN_ENABLED: "true",
    KARRYAM_ADMIN_ENVIRONMENT: "test",
    KARRYAM_ADMIN_SERVICE_INSTANCE_ID: INSTANCE,
    KARRYAM_ADMIN_WORKLOAD_IDENTITY: "cf://test/product-admin/karryam",
    KARRYAM_ADMIN_BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
    KARRYAM_ADMIN_DATABASE_URL: "postgresql://karryam_admin_runtime@127.0.0.1:5432/karryam_admin_test",
    KARRYAM_ADMIN_HQ_SERVICE_KEYS_FILE: m.serviceKeysFile,
    KARRYAM_ADMIN_DELEGATION_KEYS_FILE: m.delegationKeysFile,
    KARRYAM_ADMIN_MANIFEST_SIGNING_KEY_FILE: m.signerFile,
    KARRYAM_ADMIN_MANIFEST_SIGNING_KID: "karryam-test-signer-1",
    KARRYAM_ADMIN_LISTEN: "tcp:127.0.0.1:4210",
    ...overrides,
  };
}

async function startApp(config, deps = {}) {
  const audit = deps.audit || memoryAudit();
  const full = {
    audit,
    operations: deps.operations || memoryOperations(audit),
    nonceStore: deps.nonceStore || memoryNonceStore(),
    dbReady: deps.dbReady || (async () => true),
    logger: deps.logger || (() => {}),
    ...(deps.bridgeClient !== undefined ? { bridgeClient: deps.bridgeClient } : {}),
  };
  const server = http.createServer(createApp(config, full));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const target = clients.createFixedTarget({ ref: "karryam-test", transport: "http-loopback", origin: "http://127.0.0.1:" + port, address: "127.0.0.1" }, { allowInsecureLoopback: true });
  return { server, port, target, deps: full, close: () => new Promise((r) => server.close(() => r())) };
}

function hqClient(target, key, { serviceId = SERVICE_ID, keyId = "pic-k1" } = {}) {
  return clients.createProductAdminClient({ productId: "karryam", target, auth: { serviceId, keyId, key } });
}

function delegation(m, { method = "GET", uri, body, action, now = Date.now(), ...claims }) {
  const nowS = Math.floor(now / 1000);
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return identity.signDelegation({
    iss: "product-integration-core", aud: "karryam:" + INSTANCE, sub: "staff-17", sid: "session-17",
    auth_time: nowS - 120, mfa_at: nowS - 30, product_id: "karryam", action,
    scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"] }, role: "karryam.capabilities.viewer", grant_id: "grant-1",
    bnd: identity.requestBinding(method, uri, bytes), ...claims,
  }, { key: m.delegationKey, kid: "d1", typ: identity.TYPES.PRODUCT, now });
}

function rawRequest(port, { method = "GET", path: p, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

module.exports = { INSTANCE, SERVICE_ID, material, enabledEnv, startApp, hqClient, delegation, rawRequest, loadConfig, contracts, clients, identity };
