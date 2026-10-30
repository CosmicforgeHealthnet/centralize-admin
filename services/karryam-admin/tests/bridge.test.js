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
const staff = { sub: "staff-01", sessionId: "session-01", authTime: nowS - 2, acr: "mfa", role: "hq.karryam.read", market: "LAGOS", organization: "COSMICFORGE" };

test("HMAC v2 matches the KarryGo serviceauth canonical line protocol", () => {
  const uri = "/internal/karryam-admin/v1/capabilities?market=LAGOS&organization=COSMICFORGE&purpose=admin_ui_capabilities";
  const nonce = "abcdef0123456789";
  const canonical = ["2", "cosmicforge-hq-karryam-admin", "GET", uri, String(nowS), nonce, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"].join("\n");
  assert.equal(S.bridgeSignature({ secret, method: "GET", uri, timestamp: nowS, nonce }), createHmac("sha256", secret).update(canonical).digest("hex"));
  assert.equal(S.capabilitiesUri("LAGOS", "COSMICFORGE"), uri);
});

test("request_digest matches KarryGo security.Digest", () => {
  const uri = "/internal/karryam-admin/v1/capabilities?market=LAGOS&organization=COSMICFORGE&purpose=admin_ui_capabilities";
  const expected = S.sha(["GET", uri, "karryam", S.sha(Buffer.alloc(0))].join("\n"));
  assert.equal(S.requestDigest("GET", uri), expected);
  assert.match(S.requestDigest("GET", uri), /^[0-9a-f]{64}$/);
});

test("Ed25519 assertion uses exact bridge claims and signed request binding", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const uri = S.capabilitiesUri("LAGOS", "COSMICFORGE");
  const h = S.bridgeHeaders({ serviceKey: secret, serviceKid: "kid-1", privateKey, staffKid: "staff-1", issuer: "hq-issuer", audience: "karryam-private", staff, method: "GET", uri, now: nowS });
  const [rawHeader, rawClaims, rawSignature] = h.Authorization.slice(7).split(".");
  const header = JSON.parse(Buffer.from(rawHeader, "base64url"));
  const claims = JSON.parse(Buffer.from(rawClaims, "base64url"));
  assert.deepEqual(header, { alg: "EdDSA", typ: "JWT", kid: "staff-1" });
  assert.deepEqual(Object.keys(claims).sort(), ["acr", "aud", "auth_time", "exp", "iat", "iss", "jti", "market_scopes", "nbf", "organization_scopes", "permissions", "product", "request_digest", "roles", "session_id", "sub"].sort());
  assert.equal(claims.product, "karryam");
  assert.deepEqual(claims.permissions, ["bridge.capabilities.read"]);
  assert.deepEqual(claims.roles, ["hq.karryam.read"]);
  assert.equal(claims.request_digest, S.requestDigest("GET", uri));
  assert.equal(claims.auth_time, staff.authTime);
  assert.ok(claims.iat <= claims.nbf && claims.exp - claims.iat <= 300);
  assert.equal(verify(null, Buffer.from(rawHeader + "." + rawClaims), publicKey, Buffer.from(rawSignature, "base64url")), true);
  assert.equal(h["X-Service-Name"], "cosmicforge-hq-karryam-admin");
  assert.equal(h["X-Service-Signature-Version"], "2");
  assert.equal(h["X-HQ-Key-ID"], "kid-1");
});

test("staff context: recent MFA, mapped product role and granted scope are required locally", () => {
  const bridge = { market: "LAGOS", organization: "COSMICFORGE", acr: "mfa", roleMap: { "karryam.capabilities.viewer": "hq.karryam.read" } };
  const d = { sub: "s1", sid: "sess", mfa_at: nowS - 10, role: "karryam.capabilities.viewer", scope: { market: ["LAGOS"], organization: ["COSMICFORGE"] } };
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
    market: "NG-LAGOS", organization: "karryam-ng", acr: "mfa", serviceKid: "svc-1", staffKid: "staff-1",
    issuer: "cosmicforge-hq", audience: "karryam-bridge", roleMap: { "karryam.capabilities.viewer": "hq.karryam.read" },
    serverCa: pki.ca, clientCert: pki.clientCert, clientKey: pki.clientKey, serviceKey: secret, staffPrivateKey,
  };
}

test("live bridge read over TLS 1.3 mutual TLS to a pinned private address", async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.karryam.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let mode = "ok";
  const fake = await fakeBridge(pki, publicKey, (req, res) => {
    if (mode === "ok") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ product: "karryam", result: { capabilities: [{ id: "bridge.capabilities", state: "READ_ONLY" }] } })); }
    if (mode === "big") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ product: "karryam", pad: "x".repeat(300 * 1024) })); }
    if (mode === "redirect") { res.writeHead(302, { Location: "https://evil.example/" }); return res.end(); }
    if (mode === "wrong-product") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ product: "healthnet" })); }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "capability_blocked" } }));
  });
  t.after(() => { fake.server.close(); pki.cleanup(); });
  const bridge = bridgeConfig(pki, fake.port, privateKey);
  const client = createBridgeClient(bridge);
  const ctx = { sub: "staff-17", sessionId: "session-17", authTime: Math.floor(Date.now() / 1000) - 20, acr: "mfa", role: "hq.karryam.read", market: "NG-LAGOS", organization: "karryam-ng" };

  const payload = await client.capabilities(ctx);
  assert.equal(payload.product, "karryam");
  assert.equal(fake.state.last.tls, "TLSv1.3");
  assert.equal(fake.state.last.clientCn, "cosmicforge-hq-product-integration-core");
  assert.equal(fake.state.last.host, "bridge.karryam.internal:" + fake.port, "SNI/Host from configured origin while connecting to the pinned IP");
  assert.equal(fake.state.last.url, "/internal/karryam-admin/v1/capabilities?market=NG-LAGOS&organization=karryam-ng&purpose=admin_ui_capabilities");
  assert.ok(fake.state.last.hmacOk && fake.state.last.assertionOk && fake.state.last.digestOk);
  assert.deepEqual(fake.state.last.claims.roles, ["hq.karryam.read"]);

  for (const [m, reason] of [["big", "BRIDGE_RESPONSE_TOO_LARGE"], ["redirect", "BRIDGE_UNAVAILABLE"], ["wrong-product", "BRIDGE_RESPONSE_INVALID"], ["blocked", "BRIDGE_UNAVAILABLE"]]) {
    mode = m;
    await assert.rejects(client.capabilities(ctx), (e) => e.reason === reason, m);
  }
  const otherPki = generatePki({ serverName: "bridge.karryam.internal" });
  t.after(otherPki.cleanup);
  const wrongCa = createBridgeClient({ ...bridge, serverCa: otherPki.ca });
  await assert.rejects(wrongCa.capabilities(ctx), (e) => e.reason === "BRIDGE_UNAVAILABLE");
  const wrongName = createBridgeClient({ ...bridge, hostname: "other.karryam.internal" });
  await assert.rejects(wrongName.capabilities(ctx), (e) => e.reason === "BRIDGE_UNAVAILABLE");
});

test("capabilities endpoint uses the bridge only with a valid staff delegation", async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "bridge.karryam.internal" }); } catch { t.skip("openssl unavailable"); return; }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let up = true;
  const fake = await fakeBridge(pki, publicKey, (req, res) => {
    if (!up) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end("{}"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ product: "karryam", result: { capabilities: [] } }));
  });
  const m = F.material();
  t.after(() => { fake.server.close(); pki.cleanup(); m.cleanup(); });
  const config = { ...F.loadConfig(F.enabledEnv(m)), bridge: bridgeConfig(pki, fake.port, privateKey) };
  const app = await F.startApp(config);
  t.after(app.close);
  const client = F.hqClient(app.target, m.hqKey);
  const uri = F.contracts.BASE_PATH + "/capabilities";
  const mk = (claims = {}) => F.delegation(m, { uri, action: "product.capabilities.read", ...claims });

  const live = await client.getCapabilities({ delegation: mk() });
  assert.equal(live.status, 200);
  assert.equal(live.json.result.bridge_live.state, "READ_ONLY");
  assert.equal(live.json.result.bridge_live.discovery.product, "karryam");
  assert.equal(live.json.result.capabilities.find((c) => c.id === "karryam.bridge.capabilities.read").state, "READ_ONLY");
  assert.equal(fake.state.requests, 1);

  assert.equal((await client.getCapabilities()).json.result.bridge_live, null, "no staff context, no bridge call");
  const noMfa = await client.getCapabilities({ delegation: mk({ mfa_at: null }) });
  assert.deepEqual(noMfa.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "RECENT_MFA_REQUIRED" });
  const unmapped = await client.getCapabilities({ delegation: mk({ role: "karryam.unknown.role" }) });
  assert.deepEqual(unmapped.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "ROLE_NOT_APPROVED" });
  const outOfScope = await client.getCapabilities({ delegation: mk({ scope: { market: ["NG-ABUJA"], organization: ["karryam-ng"] } }) });
  assert.deepEqual(outOfScope.json.result.bridge_live, { state: "BLOCKED_POLICY", reason: "SCOPE_NOT_GRANTED" });
  assert.equal(fake.state.requests, 1, "policy denials never reach the network");
  up = false;
  const down = await client.getCapabilities({ delegation: mk() });
  assert.deepEqual(down.json.result.bridge_live, { state: "UNAVAILABLE", reason: "BRIDGE_UNAVAILABLE" });
  const forged = F.identity.signDelegation({ iss: "product-integration-core", aud: "karryam:" + F.INSTANCE, sub: "staff-17", sid: "s", auth_time: Math.floor(Date.now() / 1000) - 5, product_id: "karryam", action: "product.capabilities.read", bnd: F.identity.requestBinding("GET", uri, Buffer.alloc(0)) }, { key: randomBytes(32), kid: "d1", typ: F.identity.TYPES.PRODUCT });
  assert.equal((await client.getCapabilities({ delegation: forged })).json.error.reason, "DELEGATION_INVALID");
});
