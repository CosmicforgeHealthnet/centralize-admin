"use strict";

// Section 7 connector security (spec 14.2) against the disposable secure
// Bridge with real TLS 1.3 mutual TLS, HMAC v2 and Ed25519 assertions.

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const tls = require("node:tls");
const { once } = require("node:events");
const { generateKeyPairSync, randomBytes, X509Certificate } = require("node:crypto");
const S = require("../src/bridge/client/signing");
const R = require("../src/bridge/contracts/registry");
const { createBridgeClient } = require("../src/bridge/client");
const { startFakeBridge, bridgeConfigFor } = require("./helpers/fake-bridge");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");
const F = require("./helpers/fixtures");

let pkiOk = true;
try { generatePki({ serverName: "probe.internal" }).cleanup(); } catch { pkiOk = false; }
const skip = !pkiOk && "openssl unavailable";

const SCOPE = { market: "NG-LAGOS", organization: "karryam-ng", zone: "lagos-island", tenant: "tenant-a" };
const nowS = () => Math.floor(Date.now() / 1000);
const staff = (over = {}) => ({ sub: "staff-17", sessionId: "session-17", authTime: nowS() - 10, acr: "mfa", role: "hq.karryam.read", ...SCOPE, ...over });
const listQuery = () => ({ ...SCOPE, purpose: "case_review", start: new Date(Date.now() - 3600000).toISOString(), end: new Date().toISOString(), limit: 10 });

async function setup(t, bridgeOptions = {}) {
  const pki = generatePki({ serverName: "bridge.karryam.internal" });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = randomBytes(32);
  const fake = await startFakeBridge({ pki, workloadUri: "cf://test/hq/product-integration-core", staffPublicKey: publicKey, hmacKeys: { "svc-1": { secret, expires: Date.now() + 3600000 } }, ...bridgeOptions });
  t.after(async () => { await fake.close(); pki.cleanup(); });
  const bridge = bridgeConfigFor(pki, fake.port, { staffPrivateKey: privateKey, hmacSecret: secret });
  return { pki, fake, bridge, privateKey, publicKey, secret, client: createBridgeClient(bridge, { metrics: {} }) };
}

// Sends a hand-built request with explicit header overrides (for inputs the
// real client never produces).
function raw(env, { method = "GET", uri, body = Buffer.alloc(0), headers = {}, now = nowS(), staffOver = {}, sign = {} }) {
  const base = S.bridgeHeaders({ serviceKey: env.secret, serviceKid: "svc-1", privateKey: env.privateKey, staffKid: "staff-1", issuer: "cosmicforge-hq", audience: "karryam-bridge", staff: staff(staffOver), method, uri, body, permissions: [R.capability("customer.resources.customers.list").permission], now, ...sign });
  const all = { ...base, Host: "bridge.karryam.internal:" + env.fake.port, ...headers };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: env.fake.port, servername: "bridge.karryam.internal", path: uri, method, headers: all, ca: env.pki.ca, cert: env.pki.clientCert, key: env.pki.clientKey, minVersion: "TLSv1.3", agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data || "null") }));
    });
    req.on("error", reject);
    req.end(body.length ? body : undefined);
  });
}

test("valid TLS 1.3 mTLS + HMAC v2 + Ed25519 read with exact request binding and zone/tenant claims", { skip }, async (t) => {
  const env = await setup(t);
  const res = await env.client.call("customer.resources.customers.list", { staff: staff(), query: listQuery() });
  assert.equal(res.status, 200);
  assert.equal(res.capability.id, "customer.resources.customers.list");
  const seen = env.fake.state.requests.at(-1);
  assert.match(seen.url, /^\/internal\/karryam-admin\/v1\/customer\/resources\/customers\?market=NG-LAGOS&organization=karryam-ng&purpose=case_review&zone=lagos-island&tenant=tenant-a&start=.+&end=.+&limit=10$/);
  assert.deepEqual(seen.claims.zone_scopes, ["lagos-island"]);
  assert.deepEqual(seen.claims.permissions, [R.capability("customer.resources.customers.list").permission]);
  assert.equal(env.fake.state.denials.length, 0);
  // Only the pinned shape is accepted locally; nothing reaches the network otherwise.
  const before = env.fake.state.requests.length;
  await assert.rejects(env.client.call("customer.resources.customers.list", { staff: staff(), query: { ...listQuery(), sort: "x" } }), (e) => e.category === "REQUEST_REFUSED");
  await assert.rejects(env.client.call("customer.resources.customers.detail", { staff: staff(), query: listQuery(), pathParams: { id: "../admin" } }), (e) => e.category === "REQUEST_REFUSED");
  await assert.rejects(env.client.call("customer.resources.customers.list", { staff: staff({ zone: "other" }), query: listQuery() }), (e) => e.reason === "STAFF_SCOPE_MUST_EQUAL_REQUEST_SCOPE");
  await assert.rejects(env.client.call("no.such.capability", { staff: staff(), query: listQuery() }), (e) => e.category === "REQUEST_REFUSED");
  assert.equal(env.fake.state.requests.length, before);
});

test("transport identity: wrong CA, wrong client URI, revoked/unenrolled fingerprint, pinned and revoked server certs, TLS 1.2", { skip }, async (t) => {
  const env = await setup(t);
  const other = generatePki({ serverName: "bridge.karryam.internal" });
  t.after(other.cleanup);
  const call = (bridge) => createBridgeClient(bridge).call("customer.resources.customers.list", { staff: staff(), query: listQuery() });
  await assert.rejects(call({ ...env.bridge, serverCa: other.ca }), (e) => e.category === "TRANSPORT_SECURITY");
  await assert.rejects(call({ ...env.bridge, clientCert: other.clientCert, clientKey: other.clientKey }), (e) => ["TRANSPORT_SECURITY", "BRIDGE_UNAVAILABLE"].includes(e.category), "client certificate from an untrusted CA");
  const serverFp = new X509Certificate(env.pki.serverCert).fingerprint256.replace(/:/g, "").toLowerCase();
  await assert.rejects(call({ ...env.bridge, serverFingerprints: ["a".repeat(64)] }), (e) => e.category === "TRANSPORT_SECURITY");
  assert.equal((await call({ ...env.bridge, serverFingerprints: [serverFp] })).status, 200);
  await assert.rejects(call({ ...env.bridge, revokedServerFingerprints: [serverFp] }), (e) => e.category === "TRANSPORT_SECURITY");
  const clientFp = new X509Certificate(env.pki.clientCert).fingerprint256.replace(/:/g, "").toLowerCase();
  env.fake.state.revokedFingerprints.add(clientFp);
  await assert.rejects(call(env.bridge), (e) => e.category === "UNAUTHORIZED");
  env.fake.state.revokedFingerprints.clear();
  env.fake.state.enrolledFingerprints = new Set(["b".repeat(64)]);
  await assert.rejects(call(env.bridge), (e) => e.category === "UNAUTHORIZED");
  env.fake.state.enrolledFingerprints = null;

  // A Bridge enrolled for a different workload URI refuses this client.
  const uriEnv = await setup(t, { workloadUri: "cf://test/hq/someone-else" });
  await assert.rejects(uriEnv.client.call("customer.resources.customers.list", { staff: staff(), query: listQuery() }), (e) => e.category === "UNAUTHORIZED");
  assert.ok(uriEnv.fake.state.denials.includes("CLIENT_URI_MISMATCH"));

  // A server that only speaks TLS 1.2 is refused; there is no fallback.
  const tls12 = https.createServer({ cert: env.pki.serverCert, key: env.pki.serverKey, maxVersion: "TLSv1.2", minVersion: "TLSv1.2" }, (req, res) => res.end("{}"));
  tls12.listen(0, "127.0.0.1");
  await once(tls12, "listening");
  t.after(() => tls12.close());
  await assert.rejects(call({ ...env.bridge, port: tls12.address().port }), (e) => e.category === "TRANSPORT_SECURITY");
  assert.ok(tls.DEFAULT_MIN_VERSION, "node TLS available");
});

test("HMAC v2 and staff assertion negatives are rejected by the Bridge", { skip }, async (t) => {
  const env = await setup(t);
  const uri = R.buildUri(R.capability("customer.resources.customers.list"), { query: listQuery() });
  const baseline = await raw(env, { uri });
  assert.equal(baseline.status, 200, "the raw helper is valid by default: " + env.fake.state.denials.join(","));
  const cases = [
    ["invalid HMAC", { headers: { "X-Service-Signature": "0".repeat(64) } }, "HMAC_INVALID"],
    ["wrong HMAC key", { sign: { serviceKey: randomBytes(32) } }, "HMAC_INVALID"],
    ["unknown key ID", { headers: { "X-HQ-Key-ID": "svc-unknown" } }, "HMAC_KEY_UNKNOWN"],
    ["HMAC version 1", { headers: { "X-Service-Signature-Version": "1" } }, "HMAC_VERSION_OR_NAME"],
    ["wrong service name", { headers: { "X-Service-Name": "cosmicforge-hq-healthnet-admin" } }, "HMAC_VERSION_OR_NAME"],
    ["stale timestamp", { now: nowS() - 120 }, "HMAC_STALE"],
    ["invalid EdDSA signature", { sign: { privateKey: generateKeyPairSync("ed25519").privateKey } }, "JWT_SIGNATURE"],
    ["wrong audience", { sign: { audience: "other-bridge" } }, "JWT_AUDIENCE"],
    ["wrong issuer", { sign: { issuer: "rogue" } }, "JWT_AUDIENCE"],
    ["wrong staff market scope", { staffOver: { market: "NG-ABUJA" } }, "SCOPE"],
    ["wrong staff zone scope", { staffOver: { zone: "abuja-central" } }, "ZONE_SCOPE"],
    ["missing permission", { sign: { permissions: ["customer.other.read"] } }, "PERMISSION"],
    ["unapproved role", { staffOver: { role: "SUPER" } }, "ROLE"],
  ];
  for (const [name, opts, why] of cases) {
    const res = await raw(env, { uri, ...opts });
    assert.equal(res.status, 401, name);
    assert.equal(res.json.error.code, "unauthorized", name);
    assert.equal(env.fake.state.denials.at(-1), why, name);
  }
  // Request digest bound to a different URI.
  const other = R.buildUri(R.capability("customer.resources.customers.list"), { query: { ...listQuery(), limit: 11 } });
  const signed = S.bridgeHeaders({ serviceKey: env.secret, serviceKid: "svc-1", privateKey: env.privateKey, staffKid: "staff-1", issuer: "cosmicforge-hq", audience: "karryam-bridge", staff: staff(), method: "GET", uri: other, permissions: [R.capability("customer.resources.customers.list").permission] });
  const replaced = await raw(env, { uri, headers: { Authorization: signed.Authorization } });
  assert.equal(replaced.status, 401);
  assert.equal(env.fake.state.denials.at(-1), "JWT_DIGEST");
  // Duplicate nonce/JTI: replay is refused.
  const fixed = S.bridgeHeaders({ serviceKey: env.secret, serviceKid: "svc-1", privateKey: env.privateKey, staffKid: "staff-1", issuer: "cosmicforge-hq", audience: "karryam-bridge", staff: staff(), method: "GET", uri, permissions: [R.capability("customer.resources.customers.list").permission] });
  assert.equal((await raw(env, { uri, headers: fixed })).status, 200);
  const replay = await raw(env, { uri, headers: fixed });
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error.code, "replay_rejected");
  // Revoked staff session.
  env.fake.state.revokedSessions.add("session-17");
  assert.equal((await raw(env, { uri })).status, 401);
  assert.equal(env.fake.state.denials.at(-1), "SESSION_REVOKED");
});

test("policy, feature gates and source failures are classified, never turned into success", { skip }, async (t) => {
  const env = await setup(t);
  const read = () => env.client.call("customer.resources.customers.list", { staff: staff(), query: listQuery() });
  env.fake.state.blockedPolicy.add("customer.resources.customers.list");
  await assert.rejects(read(), (e) => e.category === "POLICY_UNAVAILABLE");
  env.fake.state.blockedPolicy.clear();
  env.fake.state.enabled = new Set(["hq.events.feed"]);
  await assert.rejects(read(), (e) => e.category === "CAPABILITY_DISABLED");
  env.fake.state.enabled = null;
  const respond = (fn) => { env.fake.state.handlers["customer.resources.customers.list"] = fn; };
  for (const [status, code, category] of [[503, "owner_unavailable", "SOURCE_UNAVAILABLE"], [429, "rate_limited", "RATE_LIMITED"], [409, "conflict", "VERSION_CONFLICT"], [409, "idempotency_conflict", "IDEMPOTENCY_CONFLICT"], [404, "not_found", "NOT_FOUND"], [400, "invalid_query", "INVALID_SCOPE_OR_QUERY"], [403, "forbidden", "FORBIDDEN"], [503, "audit_unavailable", "BRIDGE_UNAVAILABLE"]]) {
    respond(() => ({ status, error: code }));
    await assert.rejects(read(), (e) => e.category === category, code);
  }
  respond(({ res }) => { res.writeHead(302, { Location: "https://evil.example/" }); res.end(); return "HANDLED"; });
  await assert.rejects(read(), (e) => e.category === "CONTRACT_MISMATCH" && e.reason === "BRIDGE_REDIRECT_REFUSED");
  respond(() => ({ raw: "x".repeat(300 * 1024) }));
  await assert.rejects(read(), (e) => e.category === "RESPONSE_TOO_LARGE");
  respond(() => ({ raw: "<html>", contentType: "text/html" }));
  await assert.rejects(read(), (e) => e.category === "CONTRACT_MISMATCH");
  respond(() => ({ raw: JSON.stringify({ contract_version: "1.0", product: "healthnet", correlation_id: "00000000-0000-4000-8000-000000000001", as_of: new Date().toISOString(), freshness: "LIVE", result: {} }) }));
  await assert.rejects(read(), (e) => e.category === "CONTRACT_MISMATCH" && e.reason === "BRIDGE_ENVELOPE_INVALID");
  respond(() => ({ destroy: true }));
  await assert.rejects(read(), (e) => e.category === "BRIDGE_UNAVAILABLE");
  delete env.fake.state.handlers["customer.resources.customers.list"];
  assert.equal((await read()).status, 200);
  assert.ok(env.client.metrics.failures_total > 0 && env.client.metrics.success_total > 0);
});

test("commands: definite refusals vs UNKNOWN_OUTCOME after a possible submission", { skip }, async (t) => {
  const env = await setup(t);
  const id = "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7";
  const body = { contract_version: "customer.admin-review-request.v1", request_id: id, customer_id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_review_revision: 1, idempotency_key: "idem-0001-review", reason_code: "CUSTOMER_REQUEST", requested_at: new Date().toISOString() };
  const submit = () => env.client.call("customer.review.submit", { staff: staff(), query: listQuery(), body });
  env.fake.state.handlers["customer.review.submit"] = () => ({ status: 503, error: "capability_blocked" });
  await assert.rejects(submit(), (e) => e.category === "CAPABILITY_DISABLED" && !e.unknownOutcome, "explicit refusal is definite");
  env.fake.state.handlers["customer.review.submit"] = () => ({ status: 503, error: "owner_unavailable" });
  await assert.rejects(submit(), (e) => e.unknownOutcome, "a 503 after submission is never success and never definite");
  env.fake.state.handlers["customer.review.submit"] = () => ({ destroy: true });
  await assert.rejects(submit(), (e) => e.unknownOutcome);
  env.fake.state.handlers["customer.review.submit"] = () => new Promise(() => {});
  const slow = createBridgeClient(env.bridge, { commandTimeoutMs: 300 });
  await assert.rejects(slow.call("customer.review.submit", { staff: staff(), query: listQuery(), body }), (e) => e.unknownOutcome, "timeout after send");
  await assert.rejects(env.client.call("customer.review.submit", { staff: staff(), query: listQuery(), body: { ...body, performed_by: "x" } }), (e) => e.category === "REQUEST_REFUSED", "arbitrary fields never reach the Bridge");
});

test("configuration: client certificate URI/expiry/revocation, command allowlist and feed scopes fail closed", { skip }, (t) => {
  const pki = generatePki({ serverName: "bridge.karryam.internal" });
  const m = F.material();
  t.after(() => { pki.cleanup(); m.cleanup(); });
  const fp = new X509Certificate(pki.clientCert).fingerprint256.replace(/:/g, "").toLowerCase();
  const env = F.enabledEnv(m, {
    KARRYAM_BRIDGE_ENABLED: "true", KARRYAM_BRIDGE_ORIGIN: "https://bridge.karryam.internal:8443", KARRYAM_BRIDGE_ADDRESS: "10.20.0.9",
    KARRYAM_ADMIN_MARKET: "NG-LAGOS", KARRYAM_ADMIN_ORGANIZATION: "karryam-ng", KARRYAM_ADMIN_ACR: "mfa", KARRYAM_BRIDGE_SERVICE_KID: "svc-1", KARRYAM_BRIDGE_STAFF_KID: "staff-1",
    KARRYAM_BRIDGE_ISSUER: "hq", KARRYAM_BRIDGE_AUDIENCE: "karryam-bridge", KARRYAM_ADMIN_ROLE_MAP: JSON.stringify({ "karryam.ops.viewer": "hq.karryam.read" }),
    KARRYAM_BRIDGE_CA_FILE: m.write("ca.pem", pki.ca), KARRYAM_BRIDGE_CLIENT_CERT_FILE: m.write("client.pem", pki.clientCert), KARRYAM_BRIDGE_CLIENT_KEY_FILE: m.write("client.key", pki.clientKey),
    KARRYAM_BRIDGE_HMAC_KEY_FILE: m.write("hmac", randomBytes(32).toString("base64url")), KARRYAM_BRIDGE_STAFF_PRIVATE_KEY_FILE: m.write("staff.pem", generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })),
    KARRYAM_BRIDGE_CLIENT_URI: "cf://test/hq/product-integration-core", KARRYAM_ADMIN_CURSOR_KEY_FILE: m.write("cursor", randomBytes(32).toString("base64url")),
    KARRYAM_ADMIN_ZONES: "lagos-island", KARRYAM_ADMIN_TENANTS: "tenant-a",
  });
  const reason = (r) => (e) => e.reason === r;
  const ok = F.loadConfig(env);
  assert.equal(ok.bridge.clientIdentity.fingerprint, fp);
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_BRIDGE_CLIENT_URI: "cf://test/hq/other" }), reason("KARRYAM_BRIDGE_CLIENT_CERT_URI_MISMATCH"));
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_BRIDGE_REVOKED_FINGERPRINTS: fp }), reason("KARRYAM_BRIDGE_CLIENT_CERT_REVOKED"));
  assert.throws(() => F.loadConfig(env, { now: Date.now() - 86400000 }), reason("KARRYAM_BRIDGE_CLIENT_CERT_NOT_CURRENTLY_VALID"));
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_CURSOR_KEY_FILE: "" }), reason("KARRYAM_ADMIN_CURSOR_KEY_FILE_REQUIRED"));
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_ZONES: "*" }), reason("KARRYAM_ADMIN_ZONES_INVALID"));
  // Commands: only exact pinned commands; R3/R4 refused pending certification.
  assert.deepEqual(F.loadConfig({ ...env, KARRYAM_ADMIN_ENABLED_COMMANDS: "karryam.customer.review.submit" }).enabledCommands, ["karryam.customer.review.submit"]);
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_ENABLED_COMMANDS: "karryam.wallet.command.submit" }), reason("KARRYAM_ADMIN_COMMAND_RISK_REQUIRES_CERTIFICATION"));
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_ENABLED_COMMANDS: "karryam.pricing.policy.activate" }), reason("KARRYAM_ADMIN_COMMAND_RISK_REQUIRES_CERTIFICATION"));
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_ENABLED_COMMANDS: "karryam.customer.resources.customers.list" }), reason("KARRYAM_ADMIN_ENABLED_COMMANDS_INVALID"));
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_ENABLED_COMMANDS: "karryam.bridge.operations.submit" }), reason("KARRYAM_ADMIN_ENABLED_COMMANDS_INVALID"), "source-disabled commands cannot be enabled");
  assert.throws(() => F.loadConfig({ ...F.enabledEnv(m), KARRYAM_ADMIN_ENABLED_COMMANDS: "karryam.customer.review.submit" }), reason("KARRYAM_ADMIN_ENABLED_COMMANDS_REQUIRE_BRIDGE"));
  // Feed: explicit enrolled scopes and an operator-approved consumer principal.
  const feed = { ...env, KARRYAM_BRIDGE_FEED_ENABLED: "true", KARRYAM_BRIDGE_FEED_SCOPES: JSON.stringify([SCOPE]), KARRYAM_BRIDGE_FEED_CONSUMER: "karryam-admin-test", KARRYAM_BRIDGE_FEED_SUBJECT: "svc-karryam-admin", KARRYAM_BRIDGE_FEED_ROLE: "hq.karryam.events", KARRYAM_BRIDGE_FEED_ACR: "workload" };
  assert.equal(F.loadConfig(feed).feed.scopes.length, 1);
  assert.throws(() => F.loadConfig({ ...feed, KARRYAM_BRIDGE_FEED_SCOPES: JSON.stringify([{ ...SCOPE, zone: "abuja" }]) }), reason("KARRYAM_BRIDGE_FEED_SCOPE_NOT_ENROLLED"));
  assert.throws(() => F.loadConfig({ ...feed, KARRYAM_BRIDGE_FEED_SCOPES: JSON.stringify([SCOPE, SCOPE]) }), reason("KARRYAM_BRIDGE_FEED_SCOPES_DUPLICATE"));
  assert.throws(() => F.loadConfig({ ...feed, KARRYAM_BRIDGE_FEED_SUBJECT: "" }), reason("KARRYAM_BRIDGE_FEED_SUBJECT_REQUIRED"));
  assert.throws(() => F.loadConfig({ ...F.enabledEnv(m), KARRYAM_BRIDGE_FEED_ENABLED: "true" }), reason("KARRYAM_BRIDGE_FEED_REQUIRES_BRIDGE"));
  // The cursor key is its own trust boundary.
  assert.throws(() => F.loadConfig({ ...env, KARRYAM_ADMIN_CURSOR_KEY_FILE: m.write("cursor-reuse", m.hqKey.toString("base64url")) }), reason("KEY_REUSE_ACROSS_BOUNDARIES"));
});
