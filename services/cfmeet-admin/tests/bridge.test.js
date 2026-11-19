"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { once } = require("node:events");
const { generateKeyPairSync, verify, createHmac, randomBytes } = require("node:crypto");
const S = require("../src/bridge/client/signing");
const { createBridgeClient } = require("../src/bridge/client");
const { bridgeStaffContext } = require("../src/bridge/capabilities");
const F = require("./helpers/fixtures");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");

const secret = Buffer.alloc(32, 0x3a);
const nowS = 1793250000;
const staff = { sub: "staff-01", sessionId: "session-01", authTime: nowS - 2, acr: "mfa", role: "hq.cfmeet.read", market: "LAGOS", organization: "COSMICFORGE", zone: "production", tenant: "tenant-a" };
const DISCOVERY_SCOPE = { market: "LAGOS", organization: "COSMICFORGE", zone: "production", tenant: "tenant-a" };

test("HMAC v2 matches the CF Meet serviceauth canonical line protocol", () => {
  const uri = "/internal/cfmeet-admin/v1/capabilities?market=LAGOS&organization=COSMICFORGE&zone=production&tenant=tenant-a&purpose=admin-ui-capabilities";
  const nonce = "abcdef0123456789";
  const canonical = ["2", "cosmicforge-hq-cfmeet-admin", "GET", uri, String(nowS), nonce, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"].join("\n");
  assert.equal(S.bridgeSignature({ secret, method: "GET", uri, timestamp: nowS, nonce }), createHmac("sha256", secret).update(canonical).digest("hex"));
  assert.equal(S.capabilitiesUri(DISCOVERY_SCOPE), uri);
});

test("request_digest matches CF Meet security.Digest", () => {
  const uri = "/internal/cfmeet-admin/v1/capabilities?market=LAGOS&organization=COSMICFORGE&zone=production&tenant=tenant-a&purpose=admin-ui-capabilities";
  const expected = S.sha(["GET", uri, "cfmeet", S.sha(Buffer.alloc(0))].join("\n"));
  assert.equal(S.requestDigest("GET", uri), expected);
  assert.match(S.requestDigest("GET", uri), /^[0-9a-f]{64}$/);
});

test("Ed25519 assertion uses exact bridge claims and signed request binding", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const uri = S.capabilitiesUri(DISCOVERY_SCOPE);
  const h = S.bridgeHeaders({ serviceKey: secret, serviceKid: "kid-1", privateKey, staffKid: "staff-1", issuer: "hq-issuer", audience: "cfmeet-private", staff, method: "GET", uri, now: nowS });
  const [rawHeader, rawClaims, rawSignature] = h.Authorization.slice(7).split(".");
  const header = JSON.parse(Buffer.from(rawHeader, "base64url"));
  const claims = JSON.parse(Buffer.from(rawClaims, "base64url"));
  assert.deepEqual(header, { alg: "EdDSA", typ: "JWT", kid: "staff-1" });
  assert.deepEqual(Object.keys(claims).sort(), ["acr", "aud", "auth_time", "exp", "iat", "iss", "jti", "market_scopes", "nbf", "organization_scopes", "permissions", "product", "request_digest", "roles", "session_id", "sub", "tenant_scopes", "zone_scopes"].sort());
  assert.deepEqual(claims.zone_scopes, ["production"]);
  assert.deepEqual(claims.tenant_scopes, ["tenant-a"]);
  assert.equal(claims.product, "cfmeet");
  assert.deepEqual(claims.permissions, ["bridge.capabilities.read"]);
  assert.deepEqual(claims.roles, ["hq.cfmeet.read"]);
  assert.equal(claims.request_digest, S.requestDigest("GET", uri));
  assert.equal(claims.auth_time, staff.authTime);
  assert.ok(claims.iat <= claims.nbf && claims.exp - claims.iat <= 60, "Bridge limit is 60 s");
  assert.equal(verify(null, Buffer.from(rawHeader + "." + rawClaims), publicKey, Buffer.from(rawSignature, "base64url")), true);
  assert.equal(h["X-Service-Name"], "cosmicforge-hq-cfmeet-admin");
  assert.equal(h["X-Service-Signature-Version"], "2");
  assert.equal(h["X-HQ-Key-ID"], "kid-1");
});

test("approval claim is carried exactly, only when given (interface v1 §3.4)", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const uri = "/internal/cfmeet-admin/v1/meetings/meetings/mtg-1/end?market=LAGOS&organization=COSMICFORGE&zone=production&tenant=tenant-a&purpose=abuse-review";
  const approval = { approval_id: "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", capability: "meetings.meetings.end", requester_ref: "staff-01", approver_ref: "staff-02",
    intent_digest: "a".repeat(64), decided_at: "2026-11-19T10:00:00Z", expires_at: "2026-11-19T22:00:00Z" };
  const claimsOf = (h) => JSON.parse(Buffer.from(h.Authorization.slice(7).split(".")[1], "base64url"));
  const withClaim = claimsOf(S.bridgeHeaders({ serviceKey: secret, serviceKid: "kid-1", privateKey, staffKid: "staff-1", issuer: "i", audience: "a", staff, method: "POST", uri, body: Buffer.from("{}"), approval: { ...approval, extra: "dropped" }, now: nowS }));
  assert.deepEqual(withClaim.approval, approval, "exactly the seven agreed keys");
  const without = claimsOf(S.bridgeHeaders({ serviceKey: secret, serviceKid: "kid-1", privateKey, staffKid: "staff-1", issuer: "i", audience: "a", staff, method: "GET", uri, now: nowS }));
  assert.equal(without.approval, undefined);
  assert.deepEqual(S.APPROVAL_KEYS, ["approval_id", "capability", "requester_ref", "approver_ref", "intent_digest", "decided_at", "expires_at"]);
});

test("staff context: recent MFA, mapped product role and granted scope are required locally", () => {
  const bridge = { market: "LAGOS", organization: "COSMICFORGE", acr: "mfa", roleMap: { "cfmeet.capabilities.viewer": "hq.cfmeet.read" } };
  const d = { sub: "s1", sid: "sess", mfa_at: nowS - 10, role: "cfmeet.capabilities.viewer", scope: { market: ["LAGOS"], organization: ["COSMICFORGE"] } };
  assert.equal(bridgeStaffContext(d, bridge, nowS).authTime, nowS - 10);
  assert.throws(() => bridgeStaffContext({ ...d, mfa_at: null }, bridge, nowS), (e) => e.reason === "RECENT_MFA_REQUIRED");
  assert.throws(() => bridgeStaffContext({ ...d, mfa_at: nowS - 301 }, bridge, nowS), (e) => e.reason === "RECENT_MFA_REQUIRED");
  assert.throws(() => bridgeStaffContext({ ...d, role: "SUPER" }, bridge, nowS), (e) => e.reason === "ROLE_NOT_APPROVED");
  assert.throws(() => bridgeStaffContext({ ...d, scope: { market: ["ABUJA"], organization: ["COSMICFORGE"] } }, bridge, nowS), (e) => e.reason === "SCOPE_NOT_GRANTED");
});

async function fakeBridge(pki, staffPublicKey, behaviour) {
  const state = { requests: 0, last: null };
  const server = https.createServer({ cert: pki.serverCert, key: pki.serverKey, ca: pki.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (req, res) => {
    state.requests += 1;
    const assertion = String(req.headers.authorization || "").slice(7).split(".");
    const claims = JSON.parse(Buffer.from(assertion[1] || "", "base64url").toString() || "{}");
    const canonical = ["2", req.headers["x-service-name"], req.method, req.url, req.headers["x-service-timestamp"], req.headers["x-service-nonce"], S.sha(Buffer.alloc(0))].join("\n");
    state.last = {
      tls: req.socket.getProtocol(),
      clientCn: req.socket.getPeerCertificate().subject.CN,
      host: req.headers.host,
      url: req.url,
      hmacOk: createHmac("sha256", secret).update(canonical).digest("hex") === req.headers["x-service-signature"],
      assertionOk: verify(null, Buffer.from(assertion[0] + "." + assertion[1]), staffPublicKey, Buffer.from(assertion[2], "base64url")),
      digestOk: claims.request_digest === S.requestDigest("GET", req.url),
      claims,
    };
    behaviour(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, state, port: server.address().port };
}

function bridgeConfig(pki, port, staffPrivateKey) {
  return {
    enabled: true, hostname: pki.serverName, port, address: "127.0.0.1",
    market: "NG-LAGOS", organization: "cfmeet-ng", acr: "mfa", serviceKid: "svc-1", staffKid: "staff-1",
    issuer: "cosmicforge-hq", audience: "cfmeet-bridge", roleMap: { "cfmeet.capabilities.viewer": "hq.cfmeet.read" },
    zones: ["production"], tenants: ["tenant-a"],
    serverCa: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey, serviceKey: secret, staffPrivateKey,
  };
}

test("live bridge read over TLS 1.3 mutual TLS to a pinned private address", async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.cfmeet.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let mode = "ok";
  const fake = await fakeBridge(pki, publicKey, (req, res) => {
    if (mode === "ok") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ product: "cfmeet", result: { capabilities: [{ id: "bridge.capabilities", state: "READ_ONLY" }] } })); }
    if (mode === "big") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ product: "cfmeet", pad: "x".repeat(300 * 1024) })); }
    if (mode === "redirect") { res.writeHead(302, { Location: "https://evil.example/" }); return res.end(); }
    if (mode === "wrong-product") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ product: "healthnet" })); }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "capability_blocked" } }));
  });
  t.after(() => { fake.server.close(); pki.cleanup(); });
  const bridge = bridgeConfig(pki, fake.port, privateKey);
  const client = createBridgeClient(bridge);
  const ctx = { sub: "staff-17", sessionId: "session-17", authTime: Math.floor(Date.now() / 1000) - 20, acr: "mfa", role: "hq.cfmeet.read", market: "NG-LAGOS", organization: "cfmeet-ng", zone: "production", tenant: "tenant-a" };

  const payload = await client.capabilities(ctx);
  assert.equal(payload.product, "cfmeet");
  assert.equal(fake.state.last.tls, "TLSv1.3");
  assert.equal(fake.state.last.clientCn, "cosmicforge-hq-product-integration-core");
  assert.equal(fake.state.last.host, "bridge.cfmeet.internal:" + fake.port, "SNI/Host from configured origin while connecting to the pinned IP");
  assert.equal(fake.state.last.url, "/internal/cfmeet-admin/v1/capabilities?market=NG-LAGOS&organization=cfmeet-ng&zone=production&tenant=tenant-a&purpose=admin-ui-capabilities");
  assert.deepEqual(fake.state.last.claims.zone_scopes, ["production"]);
  assert.ok(fake.state.last.hmacOk && fake.state.last.assertionOk && fake.state.last.digestOk);
  assert.deepEqual(fake.state.last.claims.roles, ["hq.cfmeet.read"]);

  // Discovery without an enrolled zone/tenant never leaves the process.
  const before = fake.state.requests;
  await assert.rejects(client.capabilities({ ...ctx, zone: undefined }), (e) => e.reason === "STAFF_CONTEXT_REQUIRED");
  assert.equal(fake.state.requests, before);
  for (const [m, reason] of [["big", "BRIDGE_RESPONSE_TOO_LARGE"], ["redirect", "BRIDGE_UNAVAILABLE"], ["wrong-product", "BRIDGE_RESPONSE_INVALID"], ["blocked", "BRIDGE_UNAVAILABLE"]]) {
    mode = m;
    await assert.rejects(client.capabilities(ctx), (e) => e.reason === reason, m);
  }
  const otherPki = generatePki({ serverName: "bridge.cfmeet.internal" });
  t.after(otherPki.cleanup);
  const wrongCa = createBridgeClient({ ...bridge, serverCa: otherPki.ca });
  await assert.rejects(wrongCa.capabilities(ctx), (e) => e.reason === "BRIDGE_UNAVAILABLE");
  const wrongName = createBridgeClient({ ...bridge, hostname: "other.cfmeet.internal" });
  await assert.rejects(wrongName.capabilities(ctx), (e) => e.reason === "BRIDGE_UNAVAILABLE");
});

test("capabilities endpoint uses the bridge only with a valid staff delegation", async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.cfmeet.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let up = true;
  const fake = await fakeBridge(pki, publicKey, (req, res) => {
    if (!up) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end("{}"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ product: "cfmeet", result: { capabilities: [] } }));
  });
  const m = F.material();
  t.after(() => { fake.server.close(); pki.cleanup(); m.cleanup(); });
  const config = { ...F.loadConfig(F.enabledEnv(m)), bridge: bridgeConfig(pki, fake.port, privateKey) };
  const app = await F.startApp(config);
  t.after(app.close);
  const client = F.hqClient(app.target, m.hqKey);
  const uri = F.contracts.BASE_PATH + "/capabilities";
  const granted = { market: ["NG-LAGOS"], organization: ["cfmeet-ng"], zone: ["production"], tenant: ["tenant-a"] };
  const mk = (claims = {}) => F.delegation(m, { uri, action: "product.capabilities.read", scope: granted, ...claims });

  const live = await client.getCapabilities({ delegation: mk() });
  assert.equal(live.status, 200);
  assert.equal(live.json.result.bridge_live.state, "READ_ONLY");
  assert.equal(live.json.result.bridge_live.discovery.product, "cfmeet");
  assert.equal(live.json.result.capabilities.find((c) => c.id === "cfmeet.bridge.capabilities.read").state, "READ_ONLY");
  assert.equal(fake.state.requests, 1);

  assert.equal((await client.getCapabilities()).json.result.bridge_live, null, "no staff context, no bridge call");
  const noMfa = await client.getCapabilities({ delegation: mk({ mfa_at: null }) });
  assert.deepEqual(noMfa.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "RECENT_MFA_REQUIRED" });
  const unmapped = await client.getCapabilities({ delegation: mk({ role: "cfmeet.unknown.role" }) });
  assert.deepEqual(unmapped.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "ROLE_NOT_APPROVED" });
  const outOfScope = await client.getCapabilities({ delegation: mk({ scope: { ...granted, market: ["NG-ABUJA"] } }) });
  assert.deepEqual(outOfScope.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "SCOPE_NOT_GRANTED" });
  const noZone = await client.getCapabilities({ delegation: mk({ scope: { market: ["NG-LAGOS"], organization: ["cfmeet-ng"] } }) });
  assert.deepEqual(noZone.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "ZONE_TENANT_NOT_GRANTED" }, "never 'every zone'");
  assert.equal(fake.state.requests, 1, "policy denials never reach the network");
  up = false;
  const down = await client.getCapabilities({ delegation: mk() });
  assert.deepEqual(down.json.result.bridge_live, { state: "UNAVAILABLE", reason: "BRIDGE_UNAVAILABLE" });
  const forged = F.identity.signDelegation({ iss: "product-integration-core", aud: "cfmeet:" + F.INSTANCE, sub: "staff-17", sid: "s", auth_time: Math.floor(Date.now() / 1000) - 5, product_id: "cfmeet", action: "product.capabilities.read", bnd: F.identity.requestBinding("GET", uri, Buffer.alloc(0)) }, { key: randomBytes(32), kid: "d1", typ: F.identity.TYPES.PRODUCT });
  assert.equal((await client.getCapabilities({ delegation: forged })).json.error.reason, "DELEGATION_INVALID");
});
