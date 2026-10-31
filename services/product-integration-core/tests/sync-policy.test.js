"use strict";

// Pure unit tests for the shared synchronization gate and the trust-store
// lifecycle (no database).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const policy = require("../src/registry/sync-policy");
const { identityBlock } = require("../src/sync/engine");
const { buildTrustStore, bindTrustStoreSources } = require("../src/registry/endpoints");
const { loadConfig } = require("../src/config");

const NOW = Date.parse("2026-10-31T12:00:00Z");
const signer = { revoked: false, notAfter: NOW + 3600000, productId: "synthetic-third", environment: "test" };
const trust = { "kid-1": signer };
const row = (over = {}) => ({ id: "p", product_id: "synthetic-third", environment: "test", lifecycle_status: "ENABLED", drift_status: "NONE", manifest_expires_at: new Date(NOW + 60000), approved_signer_kid: "kid-1", current_contract_id: "c1", ...over });
const contract = (over = {}) => ({ id: "c1", status: "ACTIVE", protocol_major: 1, protocol_minor: 0, ...over });
const gate = (r = row(), c = contract(), t = trust) => policy.syncBlock({ row: r, contract: c, trustStore: t, environment: "test", nowMs: NOW });

test("only drift NONE may synchronize; every other drift state, known or unknown, blocks", () => {
  assert.deepEqual(policy.SYNC_SAFE_DRIFT, ["NONE"]);
  assert.equal(gate(), null);
  for (const drift of ["BREAKING_DETECTED", "ADDITIVE_PENDING_REVIEW", "IDENTITY_MISMATCH", "MANIFEST_EXPIRED", "MANIFEST_INVALID"]) {
    assert.equal(gate(row({ drift_status: drift })), drift, drift);
  }
  for (const drift of ["SOMETHING_NEW", "", null, undefined, "none"]) {
    assert.equal(gate(row({ drift_status: drift })), "DRIFT_STATE_UNRECOGNIZED", String(drift));
  }
  // The engine's run-start gate is the same policy.
  const sub = { ...row(), catalog: { protocol: { major: 1, minor: 0 } } };
  assert.equal(identityBlock(sub, trust, NOW), null);
  assert.equal(identityBlock({ ...sub, drift_status: "BREAKING_DETECTED" }, trust, NOW), "BREAKING_DETECTED");
  assert.equal(identityBlock({ ...sub, drift_status: "ADDITIVE_PENDING_REVIEW" }, trust, NOW), "ADDITIVE_PENDING_REVIEW");
  assert.equal(identityBlock({ ...sub, drift_status: "WHATEVER" }, trust, NOW), "DRIFT_STATE_UNRECOGNIZED");
  assert.equal(policy.blockStatus("BREAKING_DETECTED"), "BLOCKED_CONTRACT_DRIFT");
  assert.equal(policy.blockStatus("ADDITIVE_PENDING_REVIEW"), "BLOCKED_CONTRACT_DRIFT");
  assert.equal(policy.blockStatus("SIGNER_REVOKED"), "BLOCKED_IDENTITY");
  assert.equal(policy.blockStatus("DRIFT_STATE_UNRECOGNIZED"), "BLOCKED_SYNC_POLICY");
});

test("the gate requires enablement, environment, the active contract, a supported protocol, a live manifest and a current signer", () => {
  assert.equal(gate(row({ lifecycle_status: "SUSPENDED" })), "PRODUCT_NOT_ENABLED");
  assert.equal(gate(row({ environment: "staging" })), "ENVIRONMENT_MISMATCH");
  assert.equal(gate(row(), null), "NO_ACTIVE_CONTRACT");
  assert.equal(gate(row(), contract({ status: "SUPERSEDED" })), "NO_ACTIVE_CONTRACT");
  assert.equal(gate(row({ current_contract_id: "c2" })), "CONTRACT_SUPERSEDED");
  assert.equal(gate(row(), contract({ protocol_minor: 2 })), "PROTOCOL_UNSUPPORTED");
  assert.equal(gate(row(), contract({ protocol_major: 2 })), "PROTOCOL_UNSUPPORTED");
  assert.equal(gate(row({ manifest_expires_at: new Date(NOW - 1) })), "MANIFEST_EXPIRED");
  assert.equal(gate(row({ manifest_expires_at: null })), "MANIFEST_EXPIRED");
  assert.equal(policy.syncBlock({ row: row(), contract: contract(), trustStore: undefined, environment: "test", nowMs: NOW }), "TRUST_STORE_UNAVAILABLE");
  assert.equal(gate(row(), contract(), {}), "SIGNER_UNKNOWN");
  assert.equal(gate(row(), contract(), { "kid-1": { ...signer, revoked: true } }), "SIGNER_REVOKED");
  assert.equal(gate(row(), contract(), { "kid-1": { ...signer, revoked: "yes" } }), "SIGNER_REVOKED");
  assert.equal(gate(row(), contract(), { "kid-1": { ...signer, notAfter: NOW } }), "SIGNER_EXPIRED");
  assert.equal(gate(row(), contract(), { "kid-1": { ...signer, notAfter: "not-a-date" } }), "SIGNER_EXPIRED");
  assert.equal(gate(row(), contract(), { "kid-1": { ...signer, productId: "other" } }), "SIGNER_SCOPE_MISMATCH");
  // Prototype keys are never signers.
  assert.equal(gate(row({ approved_signer_kid: "constructor" }), contract(), {}), "SIGNER_UNKNOWN");
  // Staff read paths without a trust store still apply every other check.
  assert.equal(policy.syncBlock({ row: row({ drift_status: "ADDITIVE_PENDING_REVIEW" }), contract: contract(), trustStore: false, environment: "test", nowMs: NOW }), "ADDITIVE_PENDING_REVIEW");
  assert.equal(policy.availabilityReason("ADDITIVE_PENDING_REVIEW"), "CONTRACT_DRIFT");
  assert.equal(policy.availabilityReason("BREAKING_DETECTED"), "CONTRACT_DRIFT");
  assert.equal(policy.availabilityReason("DRIFT_STATE_UNRECOGNIZED"), "CONTRACT_DRIFT");
  assert.equal(policy.availabilityReason("SIGNER_REVOKED"), "IDENTITY_NOT_VERIFIED");
  assert.equal(policy.availabilityReason("TRUST_STORE_CHANGED"), "IDENTITY_NOT_VERIFIED");
});

test("a trust store bound to its files fails closed, and stays closed, once the files change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-trust-"));
  try {
    const file = path.join(dir, "signers.json");
    const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const json = { signers: { "kid-1": { product_id: "synthetic-third", environment: "test", public_key_pem: pem, not_after: new Date(NOW + 86400000).toISOString() } } };
    fs.writeFileSync(file, JSON.stringify(json));
    let clock = NOW;
    const store = buildTrustStore(json, { environment: "test" });
    bindTrustStoreSources(store, [{ file, bytes: fs.readFileSync(file) }], { recheckMs: 1000, now: () => clock });
    assert.deepEqual(Object.keys(store), ["kid-1"], "the freshness check is not a signer entry");
    assert.equal(store.isCurrent(), true);
    assert.equal(gate(row(), contract(), Object.assign(store, {})), null);

    // The operator revokes the signer in the file. Until restart, this
    // process must not keep trusting what it loaded.
    json.signers["kid-1"].revoked = true;
    fs.writeFileSync(file, JSON.stringify(json));
    clock += 999;
    assert.equal(store.isCurrent(), true, "re-checked at most every recheckMs");
    clock += 2;
    assert.equal(store.isCurrent(), false);
    assert.equal(gate(row(), contract(), store), "TRUST_STORE_CHANGED");
    // Restoring the original bytes does not silently re-trust: restart required.
    delete json.signers["kid-1"].revoked;
    fs.writeFileSync(file, JSON.stringify({ signers: json.signers }));
    clock += 5000;
    assert.equal(store.isCurrent(), false);

    // An unreadable source also fails closed.
    const other = buildTrustStore(json, { environment: "test" });
    bindTrustStoreSources(other, [{ file, bytes: fs.readFileSync(file) }], { recheckMs: 0, now: () => clock });
    fs.rmSync(file);
    assert.equal(other.isCurrent(), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("loadConfig binds the trust store, including referenced public-key files, to their bytes", { skip: process.platform === "win32" && "configuration paths are POSIX-only" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pic-config-trust-"));
  try {
    const write = (name, value) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value)); return f; };
    const keyFile = write("signer.pem", generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
    const env = {
      PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: "postgres://rt@db/x", PIC_TRUST_STORE_RECHECK_SECONDS: "1",
      PIC_ENDPOINTS_FILE: write("endpoints.json", { endpoints: { "karryam-staging": { product_id: "karryam", environment: "staging", transport: "unix", socket_path: "/run/cosmicforge/karryam-admin.sock", service_auth: { key_id: "k1", key_b64url: Buffer.alloc(32, 1).toString("base64url") }, delegation: { kid: "d1", key_b64url: Buffer.alloc(32, 2).toString("base64url") } } } }),
      PIC_TRUSTED_SIGNERS_FILE: write("signers.json", { signers: { "karryam-staging-1": { product_id: "karryam", environment: "staging", public_key_file: keyFile, not_after: new Date(Date.now() + 86400000).toISOString() } } }),
      PIC_HQ_DELEGATION_KEYS_FILE: write("hq.json", { keys: { h1: { key_b64url: Buffer.alloc(32, 3).toString("base64url"), not_after: new Date(Date.now() + 86400000).toISOString() } } }),
    };
    const cfg = loadConfig(env);
    assert.equal(cfg.trustStore.isCurrent(), true);
    assert.match(cfg.trustStore.fingerprint, /^sha256:[0-9a-f]{64}$/);
    // Rotating the key file in place is a trust change too.
    write("signer.pem", generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
    const until = Date.now() + 1100;
    while (Date.now() < until) { /* wait past the recheck interval */ }
    assert.equal(cfg.trustStore.isCurrent(), false);
    assert.throws(() => loadConfig({ ...env, PIC_TRUST_STORE_RECHECK_SECONDS: "0" }), (e) => e.reason === "PIC_TRUST_STORE_RECHECK_INVALID");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
