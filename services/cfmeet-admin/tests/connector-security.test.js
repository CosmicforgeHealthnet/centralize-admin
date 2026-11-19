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

const SCOPE = { market: "NG-LAGOS", organization: "cfmeet-ng", zone: "lagos-island", tenant: "tenant-a" };
const nowS = () => Math.floor(Date.now() / 1000);
const staff = (over = {}) => ({ sub: "staff-17", sessionId: "session-17", authTime: nowS() - 10, acr: "mfa", role: "hq.cfmeet.read", ...SCOPE, ...over });
const listQuery = () => ({ ...SCOPE, purpose: "support-review", start: new Date(Date.now() - 3600000).toISOString(), end: new Date().toISOString(), limit: 10 });
const scopedQuery = () => ({ ...SCOPE, purpose: "support-review" });

async function setup(t, bridgeOptions = {}) {
  const pki = generatePki({ serverName: "bridge.cfmeet.internal" });
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
  const base = S.bridgeHeaders({ serviceKey: env.secret, serviceKid: "svc-1", privateKey: env.privateKey, staffKid: "staff-1", issuer: "cosmicforge-hq", audience: "cfmeet-bridge", staff: staff(staffOver), method, uri, body, permissions: [R.capability("meetings.meetings.list").permission], now, ...sign });
  const all = { ...base, Host: "bridge.cfmeet.internal:" + env.fake.port, ...headers };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: env.fake.port, servername: "bridge.cfmeet.internal", path: uri, method, headers: all, ca: env.pki.ca, cert: env.pki.clientCert, key: env.pki.clientKey, minVersion: "TLSv1.3", agent: false }, (res) => {
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
  const res = await env.client.call("meetings.meetings.list", { staff: staff(), query: listQuery() });
  assert.equal(res.status, 200);
  assert.equal(res.capability.id, "meetings.meetings.list");
  const seen = env.fake.state.requests.at(-1);
  assert.match(seen.url, /^\/internal\/cfmeet-admin\/v1\/meetings\/meetings\?market=NG-LAGOS&organization=cfmeet-ng&zone=lagos-island&tenant=tenant-a&purpose=support-review&limit=10&start=.+&end=.+$/);
  assert.deepEqual(seen.claims.zone_scopes, ["lagos-island"]);
  assert.deepEqual(seen.claims.permissions, [R.capability("meetings.meetings.list").permission]);
  assert.equal(env.fake.state.denials.length, 0);
  // Only the pinned shape is accepted locally; nothing reaches the network otherwise.
  const before = env.fake.state.requests.length;
  await assert.rejects(env.client.call("meetings.meetings.list", { staff: staff(), query: { ...listQuery(), sort: "x" } }), (e) => e.category === "REQUEST_REFUSED");
  await assert.rejects(env.client.call("meetings.meetings.read", { staff: staff(), query: scopedQuery(), pathParams: { meeting_id: "../admin" } }), (e) => e.category === "REQUEST_REFUSED");
  await assert.rejects(env.client.call("meetings.meetings.list", { staff: staff({ zone: "other" }), query: listQuery() }), (e) => e.reason === "STAFF_SCOPE_MUST_EQUAL_REQUEST_SCOPE");
  await assert.rejects(env.client.call("no.such.capability", { staff: staff(), query: listQuery() }), (e) => e.category === "REQUEST_REFUSED");
  assert.equal(env.fake.state.requests.length, before);
});

test("transport identity: wrong CA, wrong client URI, revoked/unenrolled fingerprint, pinned and revoked server certs, TLS 1.2", { skip }, async (t) => {
  const env = await setup(t);
  const other = generatePki({ serverName: "bridge.cfmeet.internal" });
  t.after(other.cleanup);
  const call = (bridge) => createBridgeClient(bridge).call("meetings.meetings.list", { staff: staff(), query: listQuery() });
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
  await assert.rejects(uriEnv.client.call("meetings.meetings.list", { staff: staff(), query: listQuery() }), (e) => e.category === "UNAUTHORIZED");
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
  const uri = R.buildUri(R.capability("meetings.meetings.list"), { query: listQuery() });
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
  const other = R.buildUri(R.capability("meetings.meetings.list"), { query: { ...listQuery(), limit: 11 } });
  const signed = S.bridgeHeaders({ serviceKey: env.secret, serviceKid: "svc-1", privateKey: env.privateKey, staffKid: "staff-1", issuer: "cosmicforge-hq", audience: "cfmeet-bridge", staff: staff(), method: "GET", uri: other, permissions: [R.capability("meetings.meetings.list").permission] });
  const replaced = await raw(env, { uri, headers: { Authorization: signed.Authorization } });
  assert.equal(replaced.status, 401);
  assert.equal(env.fake.state.denials.at(-1), "JWT_DIGEST");
  // Duplicate nonce/JTI: replay is refused.
  const fixed = S.bridgeHeaders({ serviceKey: env.secret, serviceKid: "svc-1", privateKey: env.privateKey, staffKid: "staff-1", issuer: "cosmicforge-hq", audience: "cfmeet-bridge", staff: staff(), method: "GET", uri, permissions: [R.capability("meetings.meetings.list").permission] });
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
  const read = () => env.client.call("meetings.meetings.list", { staff: staff(), query: listQuery() });
  env.fake.state.blockedPolicy.add("meetings.meetings.list");
  await assert.rejects(read(), (e) => e.category === "POLICY_UNAVAILABLE");
  env.fake.state.blockedPolicy.clear();
  env.fake.state.enabled = new Set(["hq.events.feed"]);
  await assert.rejects(read(), (e) => e.category === "CAPABILITY_DISABLED");
  env.fake.state.enabled = null;
  const respond = (fn) => { env.fake.state.handlers["meetings.meetings.list"] = fn; };
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
  delete env.fake.state.handlers["meetings.meetings.list"];
  assert.equal((await read()).status, 200);
  assert.ok(env.client.metrics.failures_total > 0 && env.client.metrics.success_total > 0);
});

test("commands: definite refusals vs UNKNOWN_OUTCOME after a possible submission", { skip }, async (t) => {
  const env = await setup(t);
  const id = "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7";
  const body = { operation_id: id, idempotency_key: "idem-0001-review-request", reason_code: "CUSTOMER_REQUEST", case_ref: "case-9", expected_version: 0, requested_at: new Date().toISOString(), params: { user_ref: "user-1", change: "EMAIL" } };
  const submit = () => env.client.call("accounts.review-requests.submit", { staff: staff(), query: scopedQuery(), body });
  env.fake.state.handlers["accounts.review-requests.submit"] = () => ({ status: 503, error: "capability_blocked" });
  await assert.rejects(submit(), (e) => e.category === "CAPABILITY_DISABLED" && !e.unknownOutcome, "explicit refusal is definite");
  env.fake.state.handlers["accounts.review-requests.submit"] = () => ({ status: 503, error: "owner_unavailable" });
  await assert.rejects(submit(), (e) => e.unknownOutcome, "a 503 after submission is never success and never definite");
  env.fake.state.handlers["accounts.review-requests.submit"] = () => ({ destroy: true });
  await assert.rejects(submit(), (e) => e.unknownOutcome);
  env.fake.state.handlers["accounts.review-requests.submit"] = () => new Promise(() => {});
  const slow = createBridgeClient(env.bridge, { commandTimeoutMs: 300 });
  await assert.rejects(slow.call("accounts.review-requests.submit", { staff: staff(), query: scopedQuery(), body }), (e) => e.unknownOutcome, "timeout after send");
  await assert.rejects(env.client.call("accounts.review-requests.submit", { staff: staff(), query: scopedQuery(), body: { ...body, performed_by: "x" } }), (e) => e.category === "REQUEST_REFUSED", "arbitrary fields never reach the Bridge");
});

test("configuration: client certificate URI/expiry/revocation, command allowlist and feed scopes fail closed", { skip }, (t) => {
  const pki = generatePki({ serverName: "bridge.cfmeet.internal" });
  const m = F.material();
  t.after(() => { pki.cleanup(); m.cleanup(); });
  const fp = new X509Certificate(pki.clientCert).fingerprint256.replace(/:/g, "").toLowerCase();
  const env = F.enabledEnv(m, {
    CFMEET_BRIDGE_ENABLED: "true", CFMEET_BRIDGE_ORIGIN: "https://bridge.cfmeet.internal:8443", CFMEET_BRIDGE_ADDRESS: "10.20.0.9",
    CFMEET_ADMIN_MARKET: "NG-LAGOS", CFMEET_ADMIN_ORGANIZATION: "cfmeet-ng", CFMEET_ADMIN_ACR: "mfa", CFMEET_BRIDGE_SERVICE_KID: "svc-1", CFMEET_BRIDGE_STAFF_KID: "staff-1",
    CFMEET_BRIDGE_ISSUER: "hq", CFMEET_BRIDGE_AUDIENCE: "cfmeet-bridge", CFMEET_ADMIN_ROLE_MAP: JSON.stringify({ "cfmeet.ops.viewer": "hq.cfmeet.read" }),
    CFMEET_BRIDGE_CA_FILE: m.write("ca.pem", pki.ca), CFMEET_BRIDGE_CLIENT_CERT_FILE: m.write("client.pem", pki.clientCert), CFMEET_BRIDGE_CLIENT_KEY_FILE: m.write("client.key", pki.clientKey),
    CFMEET_BRIDGE_HMAC_KEY_FILE: m.write("hmac", randomBytes(32).toString("base64url")), CFMEET_BRIDGE_STAFF_PRIVATE_KEY_FILE: m.write("staff.pem", generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })),
    CFMEET_BRIDGE_CLIENT_URI: "cf://test/hq/product-integration-core", CFMEET_ADMIN_CURSOR_KEY_FILE: m.write("cursor", randomBytes(32).toString("base64url")),
    CFMEET_ADMIN_ZONES: "lagos-island", CFMEET_ADMIN_TENANTS: "tenant-a",
  });
  const reason = (r) => (e) => e.reason === r;
  const ok = F.loadConfig(env);
  assert.equal(ok.bridge.clientIdentity.fingerprint, fp);
  assert.throws(() => F.loadConfig({ ...env, CFMEET_BRIDGE_CLIENT_URI: "cf://test/hq/other" }), reason("CFMEET_BRIDGE_CLIENT_CERT_URI_MISMATCH"));
  assert.throws(() => F.loadConfig({ ...env, CFMEET_BRIDGE_REVOKED_FINGERPRINTS: fp }), reason("CFMEET_BRIDGE_CLIENT_CERT_REVOKED"));
  assert.throws(() => F.loadConfig(env, { now: Date.now() - 86400000 }), reason("CFMEET_BRIDGE_CLIENT_CERT_NOT_CURRENTLY_VALID"));
  // Section 12.3: the client key must belong to the certificate; the CA file must hold a current CA.
  const otherPki = generatePki({ serverName: "bridge.cfmeet.internal" });
  t.after(() => otherPki.cleanup());
  assert.throws(() => F.loadConfig({ ...env, CFMEET_BRIDGE_CLIENT_KEY_FILE: m.write("other.key", otherPki.clientKey) }), reason("CFMEET_BRIDGE_CLIENT_KEY_CERT_MISMATCH"));
  assert.throws(() => F.loadConfig({ ...env, CFMEET_BRIDGE_CLIENT_KEY_FILE: m.write("bad.key", "not a key") }), reason("CFMEET_BRIDGE_CLIENT_KEY_INVALID"));
  assert.throws(() => F.loadConfig({ ...env, CFMEET_BRIDGE_CA_FILE: m.write("leaf-as-ca.pem", pki.clientCert) }), reason("CFMEET_BRIDGE_CA_FILE_NOT_A_CA"));
  assert.throws(() => F.loadConfig({ ...env, CFMEET_BRIDGE_CA_FILE: m.write("junk-ca.pem", "junk") }), reason("CFMEET_BRIDGE_CA_FILE_INVALID"));
  assert.equal(typeof require("../src/config").describeConfig(ok).bridge_client_cert_expires_in_days, "number");
  assert.throws(() => F.loadConfig({ ...env, CFMEET_ADMIN_CURSOR_KEY_FILE: "" }), reason("CFMEET_ADMIN_CURSOR_KEY_FILE_REQUIRED"));
  assert.throws(() => F.loadConfig({ ...env, CFMEET_ADMIN_ZONES: "*" }), reason("CFMEET_ADMIN_ZONES_INVALID"));
  // Commands: only exact pinned commands. R3/R4 may be listed, but listing
  // alone never exposes them: without a high-risk certification in force
  // they stay DISABLED (Section 11.3).
  assert.deepEqual(F.loadConfig({ ...env, CFMEET_ADMIN_ENABLED_COMMANDS: "cfmeet.accounts.review-requests.submit" }).enabledCommands, ["cfmeet.accounts.review-requests.submit"]);
  const { commandExposure } = require("../src/modules/catalog");
  const R = require("../src/bridge/contracts/registry");
  for (const id of ["cfmeet.accounts.users.status.update", "cfmeet.pricing.versions.activate"]) {
    const listed = F.loadConfig({ ...env, CFMEET_ADMIN_ENABLED_COMMANDS: id });
    const exposure = commandExposure(R.capability(id.slice("cfmeet.".length)), listed);
    assert.equal(exposure.state, "DISABLED", id);
    assert.deepEqual(exposure.blockers.map((b) => b.code), ["HIGH_RISK_CERTIFICATION_REQUIRED"], id);
    assert.equal(commandExposure(R.capability(id.slice("cfmeet.".length)), { ...listed, highRiskCertified: [id] }).state, "AVAILABLE", "only listing + certification exposes " + id);
  }
  assert.throws(() => F.loadConfig({ ...env, CFMEET_ADMIN_ENABLED_COMMANDS: "cfmeet.meetings.meetings.list" }), reason("CFMEET_ADMIN_ENABLED_COMMANDS_INVALID"));
  assert.throws(() => F.loadConfig({ ...env, CFMEET_ADMIN_ENABLED_COMMANDS: "cfmeet.telecom.numbers.assign" }), reason("CFMEET_ADMIN_ENABLED_COMMANDS_INVALID"), "source-disabled commands cannot be enabled");
  assert.throws(() => F.loadConfig({ ...F.enabledEnv(m), CFMEET_ADMIN_ENABLED_COMMANDS: "cfmeet.accounts.review-requests.submit" }), reason("CFMEET_ADMIN_ENABLED_COMMANDS_REQUIRE_BRIDGE"));
  // Feed: explicit enrolled scopes and an operator-approved consumer principal.
  const feed = { ...env, CFMEET_BRIDGE_FEED_ENABLED: "true", CFMEET_BRIDGE_FEED_SCOPES: JSON.stringify([SCOPE]), CFMEET_BRIDGE_FEED_CONSUMER: "cfmeet-admin-test", CFMEET_BRIDGE_FEED_SUBJECT: "svc-cfmeet-admin", CFMEET_BRIDGE_FEED_ROLE: "hq.cfmeet.events", CFMEET_BRIDGE_FEED_ACR: "workload" };
  assert.equal(F.loadConfig(feed).feed.scopes.length, 1);
  assert.throws(() => F.loadConfig({ ...feed, CFMEET_BRIDGE_FEED_SCOPES: JSON.stringify([{ ...SCOPE, zone: "abuja" }]) }), reason("CFMEET_BRIDGE_FEED_SCOPE_NOT_ENROLLED"));
  assert.throws(() => F.loadConfig({ ...feed, CFMEET_BRIDGE_FEED_SCOPES: JSON.stringify([SCOPE, SCOPE]) }), reason("CFMEET_BRIDGE_FEED_SCOPES_DUPLICATE"));
  assert.throws(() => F.loadConfig({ ...feed, CFMEET_BRIDGE_FEED_SUBJECT: "" }), reason("CFMEET_BRIDGE_FEED_SUBJECT_REQUIRED"));
  assert.throws(() => F.loadConfig({ ...F.enabledEnv(m), CFMEET_BRIDGE_FEED_ENABLED: "true" }), reason("CFMEET_BRIDGE_FEED_REQUIRES_BRIDGE"));
  // The cursor key is its own trust boundary.
  assert.throws(() => F.loadConfig({ ...env, CFMEET_ADMIN_CURSOR_KEY_FILE: m.write("cursor-reuse", m.hqKey.toString("base64url")) }), reason("KEY_REUSE_ACROSS_BOUNDARIES"));
});
