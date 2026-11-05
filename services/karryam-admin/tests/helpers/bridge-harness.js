"use strict";

// Karryam Admin app + disposable secure Bridge, wired with real TLS 1.3
// mutual TLS, HMAC v2 and Ed25519 assertions. Throwaway key material only.

const { generateKeyPairSync, randomBytes, randomUUID } = require("node:crypto");
const F = require("./fixtures");
const { startFakeBridge, bridgeConfigFor } = require("./fake-bridge");
const { generatePki } = require("../../../../packages/service-clients/tests/helpers/pki");
const { memoryAudit } = require("../../src/audit");
const { memoryOperations } = require("../../src/db/operations");
const { memoryAccessLog } = require("../../src/db/access-log");
const { memoryApprovals } = require("../../src/db/approvals");

const SCOPE = Object.freeze({ market: "NG-LAGOS", organization: "karryam-ng", zone: "lagos-island", tenant: "tenant-a" });
const READ_ROLE = "karryam.ops.viewer";

function opensslAvailable() {
  try { generatePki({ serverName: "probe.internal" }).cleanup(); return true; } catch { return false; }
}

async function startBridgeHarness(t, { configOverrides = {}, deps = {}, bridgeOptions = {}, envOverrides = {} } = {}) {
  const pki = generatePki({ serverName: "bridge.karryam.internal" });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const hmacSecret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret: hmacSecret, expires: Date.now() + 3600000 } }, ...bridgeOptions });
  const m = F.material();
  const base = F.loadConfig(F.enabledEnv(m, envOverrides));
  const config = Object.freeze({
    ...base,
    bridge: bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret }),
    cursorKey: randomBytes(32),
    enabledCommands: Object.freeze([]),
    ...configOverrides,
  });
  const audit = deps.audit || memoryAudit();
  const accessLog = deps.accessLog || memoryAccessLog();
  const operations = deps.operations || memoryOperations(audit);
  const approvals = deps.approvals || memoryApprovals();
  const app = await F.startApp(config, { audit, operations, ...deps, accessLog, approvals });
  t.after(async () => { await app.close(); await fake.close(); pki.cleanup(); m.cleanup(); });
  const client = F.hqClient(app.target, m.hqKey);
  // Staff delegation for one exact request.
  const delegate = (uri, { method = "GET", body, action = "resource.read", scope, ...claims } = {}) => F.delegation(m, {
    method, uri, body, action, role: READ_ROLE,
    scope: scope || { market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] }, ...claims,
  });
  return { pki, fake, m, config, app, client, delegate, audit, accessLog, operations, approvals, privateKey, publicKey, hmacSecret };
}

function queryString(q) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.append(k, String(v));
  const s = params.toString();
  return s ? "?" + s : "";
}

// GET through the protocol with a request-bound delegation.
async function protocolGet(h, path, query = {}, delegationOptions = {}) {
  const { noDelegation, ...claims } = delegationOptions;
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
  const uri = F.contracts.BASE_PATH + path + queryString(clean);
  return F.clients.createServiceClient({ target: h.app.target, auth: { serviceId: F.SERVICE_ID, keyId: "pic-k1", key: h.m.hqKey } })
    .request({ method: "GET", path: F.contracts.BASE_PATH + path, query: Object.keys(clean).length ? clean : undefined, delegation: noDelegation ? undefined : h.delegate(uri, claims) });
}

module.exports = { startBridgeHarness, protocolGet, opensslAvailable, SCOPE, READ_ROLE, randomUUID };
