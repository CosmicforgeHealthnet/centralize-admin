"use strict";

// Pure unit tests: onboarding state machine, configuration, endpoint pinning.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const SM = require("../src/onboarding/state-machine");
const { loadConfig, parseListen } = require("../src/config");
const { buildEndpoints, resolveEndpoint } = require("../src/registry/endpoints");
const { validScope, subsetScope } = require("../src/onboarding/service");

const base = { actorId: "b", requestedBy: "a", expectedRevision: 3, currentRevision: 3 };

test("state machine: only the documented transitions are allowed", () => {
  const happy = ["DRAFT", "REQUESTED", "IDENTITY_VERIFIED", "CONTRACT_VALIDATED", "POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"];
  for (let i = 0; i < happy.length - 1; i += 1) assert.doesNotThrow(() => SM.assertTransition({ ...base, from: happy[i], to: happy[i + 1] }));
  const err = (fields, reason) => assert.throws(() => SM.assertTransition({ ...base, ...fields }), (e) => e.reason === reason, reason);
  err({ from: "REQUESTED", to: "ENABLED" }, "TRANSITION_NOT_ALLOWED");
  err({ from: "DRAFT", to: "IDENTITY_VERIFIED" }, "TRANSITION_NOT_ALLOWED");
  err({ from: "ENABLED", to: "REQUESTED" }, "TRANSITION_NOT_ALLOWED");
  err({ from: "REVOKED", to: "REQUESTED" }, "TERMINAL_STATE");
  err({ from: "REJECTED", to: "REQUESTED" }, "TERMINAL_STATE");
  err({ from: "SUSPENDED", to: "ENABLED" }, "TRANSITION_NOT_ALLOWED");
  err({ from: "SUSPENDED", to: "REQUESTED" }, "EXPLICIT_REREVIEW_REQUIRED");
  assert.doesNotThrow(() => SM.assertTransition({ ...base, from: "SUSPENDED", to: "REQUESTED", reviewedFromSuspension: true }));
  err({ from: "CONTRACT_VALIDATED", to: "POLICY_REVIEWED", actorId: "a" }, "INDEPENDENT_REVIEWER_REQUIRED");
  err({ from: "CERTIFIED_STAGING", to: "ENABLED", actorId: "c", certifiedBy: "c" }, "INDEPENDENT_APPROVER_REQUIRED");
  err({ from: "REQUESTED", to: "IDENTITY_VERIFIED", expectedRevision: 2 }, "STALE_REVISION");
  err({ from: "REQUESTED", to: "IDENTITY_VERIFIED", expectedRevision: undefined }, "EXPECTED_REVISION_REQUIRED");
  for (const from of ["REQUESTED", "IDENTITY_VERIFIED", "CONTRACT_VALIDATED", "POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED", "SUSPENDED"]) {
    assert.doesNotThrow(() => SM.assertTransition({ ...base, from, to: "REVOKED" }), from);
  }
  assert.equal(SM.canSynchronize("ENABLED"), true);
  assert.equal(SM.canSynchronize("CERTIFIED_STAGING"), false);
});

test("scope helpers reject wildcards and enforce containment", () => {
  assert.equal(validScope({ market: ["NG"], organization: ["cf"] }, { required: ["market", "organization"] }), true);
  assert.equal(validScope({ market: ["*"] }), false);
  assert.equal(validScope({ market: [] }), false);
  assert.equal(validScope({ region: ["x"] }), false);
  assert.equal(validScope({ market: ["NG", "NG"] }), false);
  assert.equal(subsetScope({ market: ["NG"] }, { market: ["NG", "GH"] }), true);
  assert.equal(subsetScope({ market: ["KE"] }, { market: ["NG"] }), false);
});

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("configuration is disabled by default and fails closed when enabled", () => {
  assert.deepEqual(loadConfig({}).enabled, false);
  assert.throws(() => loadConfig({ PIC_ENABLED: "true" }), (e) => e.reason === "PIC_ENVIRONMENT_REQUIRED");
  assert.throws(() => loadConfig({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging" }), (e) => e.reason === "PIC_DATABASE_URL_REQUIRED");
  assert.throws(() => loadConfig({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: "postgres://rt@db/x", PIC_MIGRATION_DATABASE_URL: "postgres://rt@db/x" }), (e) => e.reason === "RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER");
  assert.throws(() => loadConfig({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: "postgres://rt@db/x" }), (e) => e.reason === "PIC_ENDPOINTS_FILE_REQUIRED");
  assert.throws(() => loadConfig({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "production", PIC_DATABASE_URL: "postgres://rt@db/x", PIC_ALLOW_INSECURE_LOOPBACK: "true" }), (e) => e.reason === "INSECURE_LOOPBACK_FORBIDDEN_IN_PRODUCTION");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-config-"));
  try {
    const keyA = Buffer.alloc(32, 1).toString("base64url");
    const keyB = Buffer.alloc(32, 2).toString("base64url");
    const env = {
      PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: "postgres://rt@db/x",
      PIC_ENDPOINTS_FILE: writeJson(dir, "endpoints.json", { endpoints: { "karryam-staging": { product_id: "karryam", environment: "staging", transport: "unix", socket_path: "/run/cosmicforge/karryam-admin.sock", service_auth: { key_id: "k1", key_b64url: keyA }, delegation: { kid: "d1", key_b64url: keyB } } } }),
      PIC_TRUSTED_SIGNERS_FILE: writeJson(dir, "signers.json", { signers: {} }),
      PIC_HQ_DELEGATION_KEYS_FILE: writeJson(dir, "hq.json", { keys: { h1: { key_b64url: Buffer.alloc(32, 3).toString("base64url"), not_after: new Date(Date.now() + 86400000).toISOString() } } }),
    };
    const cfg = loadConfig(env);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.sync.enabled, false);
    assert.equal(cfg.endpoints.get("karryam-staging").target.transport, "unix");
    // Key reuse across trust boundaries is refused.
    const reused = { ...env, PIC_HQ_DELEGATION_KEYS_FILE: writeJson(dir, "hq2.json", { keys: { h1: { key_b64url: keyA, not_after: new Date(Date.now() + 86400000).toISOString() } } }) };
    assert.throws(() => loadConfig(reused), (e) => e.reason === "KEY_REUSE_ACROSS_BOUNDARIES");
    const noExpiry = { ...env, PIC_HQ_DELEGATION_KEYS_FILE: writeJson(dir, "hq3.json", { keys: { h1: { key_b64url: Buffer.alloc(32, 3).toString("base64url") } } }) };
    assert.throws(() => loadConfig(noExpiry), (e) => e.reason === "HQ_DELEGATION_KEY_EXPIRY_REQUIRED");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("listener must be private; remote TCP requires an mTLS step", () => {
  assert.equal(parseListen(undefined).kind, "unix");
  assert.equal(parseListen("tcp:127.0.0.1:4300").host, "127.0.0.1");
  assert.throws(() => parseListen("tcp:0.0.0.0:4300"), (e) => e.reason === "PIC_LISTEN_NOT_PRIVATE");
  assert.throws(() => parseListen("tcp:8.8.8.8:4300"), (e) => e.reason === "PIC_LISTEN_NOT_PRIVATE");
  assert.throws(() => parseListen("tcp:10.0.0.4:4300"), (e) => e.reason === "PIC_LISTEN_REMOTE_REQUIRES_MTLS");
  assert.throws(() => parseListen("unix:relative.sock"), (e) => e.reason === "PIC_LISTEN_INVALID");
});

test("endpoint allowlist: SSRF-resistant targets bound to one product and environment", () => {
  const keys = { service_auth: { key_id: "k", key_b64url: Buffer.alloc(32, 1).toString("base64url") }, delegation: { kid: "d", key_b64url: Buffer.alloc(32, 2).toString("base64url") } };
  const tls = { ca_pem: "x", cert_pem: "x", key_pem: "x" };
  const bad = [
    { transport: "https", origin: "https://karryam-admin.internal", address: "203.0.113.10", tls },
    { transport: "https", origin: "https://karryam-admin.internal", address: "169.254.169.254", tls },
    { transport: "https", origin: "https://karryam-admin.internal/path", address: "10.0.0.5", tls },
    { transport: "https", origin: "https://karryam-admin.internal", address: "karryam-admin.internal", tls },
    { transport: "http-loopback", origin: "http://127.0.0.1:1", address: "127.0.0.1" },
  ];
  assert.throws(() => buildEndpoints({ endpoints: { ep: { product_id: "karryam", environment: "staging", transport: "https", origin: "https://karryam-admin.internal", address: "10.0.0.5", tls, ...keys } } }, { environment: "staging" }), /SERVER_FINGERPRINT_PIN_REQUIRED/);
  for (const spec of bad) assert.throws(() => buildEndpoints({ endpoints: { ep: { product_id: "karryam", environment: "staging", ...spec, ...keys } } }, { environment: "staging" }), JSON.stringify(spec));
  assert.throws(() => buildEndpoints({ endpoints: { ep: { product_id: "karryam", environment: "staging", transport: "unix", socket_path: "/run/x.sock", service_auth: keys.service_auth, delegation: { kid: "d", key_b64url: keys.service_auth.key_b64url } } } }, { environment: "staging" }), /KEY_REUSE/);
  const map = buildEndpoints({ endpoints: {
    ep: { product_id: "karryam", environment: "staging", transport: "unix", socket_path: "/run/x.sock", ...keys },
    prod: { product_id: "karryam", environment: "production", transport: "unix", socket_path: "/run/y.sock", ...keys },
  } }, { environment: "staging" });
  assert.equal(map.has("prod"), false); // other environments are never loaded
  assert.throws(() => resolveEndpoint(map, { endpoint_ref: "ep", product_id: "healthnet", environment: "staging" }), (e) => e.reason === "ENDPOINT_PRODUCT_MISMATCH");
  assert.throws(() => resolveEndpoint(map, { endpoint_ref: "missing", product_id: "karryam", environment: "staging" }), (e) => e.reason === "ENDPOINT_NOT_ALLOWLISTED");
  void generateKeyPairSync;
});
