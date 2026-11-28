"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");


const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const F = require("./helpers/fixtures");
const { loadConfig, bridgeOrigin, describeConfig } = require("../src/config");
const { parseListen } = require("../src/transport/listen-spec");

const reason = (r) => (e) => e.reason === r;

test("disabled by default with a private Unix socket listener", () => {
  const config = loadConfig({});
  assert.equal(config.enabled, false);
  assert.deepEqual(config.listen, { kind: "unix", path: "/run/cosmicforge/cfmeet-admin.sock" });
  assert.deepEqual(describeConfig(config), { enabled: false, listen: "unix" });
  assert.throws(() => loadConfig({ CFMEET_ADMIN_ENABLED: "yes" }), reason("CFMEET_ADMIN_ENABLED_MUST_BE_TRUE_OR_FALSE"));
});

test("enabled configuration loads and never exposes secret values in its description", (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const config = loadConfig(F.enabledEnv(m));
  assert.equal(config.enabled, true);
  assert.equal(config.productId, "cfmeet");
  assert.equal(config.manifestSigner.kid, "cfmeet-test-signer-1");
  assert.equal(config.bridge.enabled, false);
  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes(m.hqKey.toString("base64url")));
  assert.match(described, /NOT_PROVISIONED|PROVISIONED/);
});

test("enabled configuration fails closed on each missing credential", (t) => {
  const m = F.material();
  t.after(m.cleanup);
  for (const name of ["CFMEET_ADMIN_ENVIRONMENT", "CFMEET_ADMIN_SERVICE_INSTANCE_ID", "CFMEET_ADMIN_WORKLOAD_IDENTITY", "CFMEET_ADMIN_BUILD_SHA", "CFMEET_ADMIN_DATABASE_URL", "CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE", "CFMEET_ADMIN_DELEGATION_KEYS_FILE"]) {
    const env = F.enabledEnv(m);
    delete env[name];
    assert.throws(() => loadConfig(env), reason(name + "_REQUIRED"), name);
  }
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE: "relative/keys.json" })), reason("CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE_PATH_INVALID"));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE: m.dir + "/missing.json" })), reason("CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE_UNREADABLE"));
  const short = m.write("short.json", JSON.stringify({ k: { service_id: "hq-product-integration-core", key_b64url: randomBytes(8).toString("base64url"), not_after: "2099-01-01T00:00:00Z" } }));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE: short })), reason("CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE_KEY_TOO_SHORT"));
  const expired = m.write("expired.json", JSON.stringify({ k: { service_id: "hq-product-integration-core", key_b64url: randomBytes(32).toString("base64url"), not_after: "2020-01-01T00:00:00Z" } }));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE: expired })), reason("CFMEET_ADMIN_HQ_SERVICE_KEYS_FILE_NO_LIVE_KEY"));
  const noExpiry = m.write("noexp.json", JSON.stringify({ d1: { key_b64url: randomBytes(32).toString("base64url") } }));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_DELEGATION_KEYS_FILE: noExpiry })), reason("CFMEET_ADMIN_DELEGATION_KEYS_FILE_EXPIRY_REQUIRED"));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_ENVIRONMENT: "prod" })), reason("CFMEET_ADMIN_ENVIRONMENT_INVALID"));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_WORKLOAD_IDENTITY: "cf://test/product-admin/healthnet" })), reason("CFMEET_ADMIN_WORKLOAD_IDENTITY_INVALID"));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_DATABASE_URL: "mysql://x@y/z" })), reason("CFMEET_ADMIN_DATABASE_URL_INVALID"));
  const env = F.enabledEnv(m);
  assert.throws(() => loadConfig({ ...env, CFMEET_ADMIN_MIGRATION_DATABASE_URL: env.CFMEET_ADMIN_DATABASE_URL }), reason("RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER"));
});

test("manifest signer is optional but must be complete and Ed25519", (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const env = F.enabledEnv(m);
  delete env.CFMEET_ADMIN_MANIFEST_SIGNING_KEY_FILE;
  delete env.CFMEET_ADMIN_MANIFEST_SIGNING_KID;
  assert.equal(loadConfig(env).manifestSigner, null);
  assert.throws(() => loadConfig({ ...env, CFMEET_ADMIN_MANIFEST_SIGNING_KID: "kid" }), reason("MANIFEST_SIGNER_REQUIRES_KEY_AND_KID"));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_MANIFEST_SIGNING_KEY_FILE: m.write("rsa.pem", rsa) })), reason("CFMEET_ADMIN_MANIFEST_SIGNING_KEY_FILE_NOT_ED25519"));
});

test("listeners are private only; non-loopback TCP requires mutual TLS", (t) => {
  assert.throws(() => parseListen("tcp:0.0.0.0:4210"), reason("LISTEN_HOST_NOT_PRIVATE"));
  assert.throws(() => parseListen("tcp:[::]:4210"), reason("LISTEN_HOST_NOT_PRIVATE"));
  assert.throws(() => parseListen("tcp:8.8.8.8:4210"), reason("LISTEN_HOST_NOT_PRIVATE"));
  assert.throws(() => parseListen("tcp:169.254.169.254:80"), reason("LISTEN_HOST_NOT_PRIVATE"));
  assert.throws(() => parseListen("tcp:cfmeet-admin.internal:4210"), reason("LISTEN_INVALID"));
  assert.throws(() => parseListen("unix:relative.sock"), reason("LISTEN_SOCKET_PATH_INVALID"));
  assert.throws(() => parseListen("unix:/run/../tmp/x.sock"), reason("LISTEN_SOCKET_PATH_INVALID"));
  assert.deepEqual(parseListen("tcp:10.20.0.5:4210"), { kind: "tcp", host: "10.20.0.5", port: 4210, loopback: false });
  const m = F.material();
  t.after(m.cleanup);
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_LISTEN: "tcp:10.20.0.5:4210" })), reason("NON_LOOPBACK_TCP_REQUIRES_MTLS"));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_LISTEN: "unix:/run/cosmicforge/k.sock", CFMEET_ADMIN_TLS_CERT_FILE: "/x" })), reason("TLS_NOT_SUPPORTED_ON_UNIX_SOCKET"));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_LISTEN: "tcp:10.20.0.5:4210", CFMEET_ADMIN_ALLOWED_CLIENT_FINGERPRINTS: "zz" })), reason("CFMEET_ADMIN_ALLOWED_CLIENT_FINGERPRINTS_INVALID"));
});

test("bridge origin refuses HTTP, credentials, query and unexpected path (PR #36 rules)", () => {
  assert.throws(() => bridgeOrigin("http://127.0.0.1:8110"));
  assert.throws(() => bridgeOrigin("https://admin:pass@127.0.0.1:8110"));
  assert.throws(() => bridgeOrigin("https://127.0.0.1:8110/internal"));
  assert.throws(() => bridgeOrigin("https://127.0.0.1:8110/?to=other"));
  assert.throws(() => bridgeOrigin("https://127.0.0.1:8110/#frag"));
  assert.equal(bridgeOrigin("https://127.0.0.1:8110").protocol, "https:");
});

test("bridge configuration is all-or-nothing, private-IP pinned and never maps staff tiers", (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const base = F.enabledEnv(m, { CFMEET_BRIDGE_ENABLED: "true" });
  assert.throws(() => loadConfig(base), reason("CFMEET_BRIDGE_ORIGIN_REQUIRED"));
  const bridgeEnv = { ...base, CFMEET_BRIDGE_ORIGIN: "https://bridge.cfmeet.internal:8443", CFMEET_BRIDGE_ADDRESS: "8.8.8.8" };
  assert.throws(() => loadConfig(bridgeEnv), reason("CFMEET_BRIDGE_ADDRESS_NOT_PRIVATE_IP"));
  assert.throws(() => loadConfig({ ...bridgeEnv, CFMEET_BRIDGE_ADDRESS: "bridge.cfmeet.internal" }), reason("CFMEET_BRIDGE_ADDRESS_NOT_PRIVATE_IP"));
  const scoped = { ...bridgeEnv, CFMEET_BRIDGE_ADDRESS: "10.20.0.9", CFMEET_ADMIN_MARKET: "NG-LAGOS", CFMEET_ADMIN_ORGANIZATION: "cfmeet-ng", CFMEET_ADMIN_ACR: "mfa", CFMEET_BRIDGE_SERVICE_KID: "svc-1", CFMEET_BRIDGE_STAFF_KID: "staff-1", CFMEET_BRIDGE_ISSUER: "hq", CFMEET_BRIDGE_AUDIENCE: "cfmeet-bridge" };
  assert.throws(() => loadConfig({ ...scoped, CFMEET_ADMIN_ROLE_MAP: JSON.stringify({ super: "approved-read" }) }), reason("CFMEET_ADMIN_ROLE_MAP_INVALID"));
  assert.throws(() => loadConfig({ ...scoped, CFMEET_ADMIN_ROLE_MAP: "{}" }), reason("CFMEET_ADMIN_ROLE_MAP_INVALID"));
  assert.throws(() => loadConfig({ ...scoped, CFMEET_ADMIN_ROLE_MAP: JSON.stringify({ "cfmeet.capabilities.viewer": "approved-read" }) }), reason("CFMEET_BRIDGE_CA_FILE_REQUIRED"));
});

test("service-auth and delegation keys may never share key material", (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const notAfter = new Date(Date.now() + 86400000).toISOString();
  const reused = m.write("delegation-reused.json", JSON.stringify({ d1: { key_b64url: m.hqKey.toString("base64url"), not_after: notAfter } }));
  assert.throws(() => loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_DELEGATION_KEYS_FILE: reused })), reason("KEY_REUSE_ACROSS_BOUNDARIES"));
  assert.equal(loadConfig(F.enabledEnv(m)).enabled, true);
});
