"use strict";

// HQ product gateway: session/MFA enforcement, strict route allowlist,
// disabled-by-default behaviour, request-bound delegation compatible with
// packages/identity-and-permissions, bounded PIC transport, no tier bypass,
// and legacy direct-database isolation.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const express = require("express");
const ApiError = require("../src/shared/utils/ApiError");
const { requestContext } = require("../src/shared/middlewares/request-context.middleware");
const { errorHandler } = require("../src/shared/middlewares/error.middleware");
const { requireRecentMfa } = require("../src/shared/middlewares/auth.middleware");
const { createProductGateway } = require("../src/modules/product-gateway");
const { loadGatewayConfig } = require("../src/modules/product-gateway/config");
const { signHqDelegation, requestBinding } = require("../src/modules/product-gateway/delegation");
const { callPic } = require("../src/modules/product-gateway/pic-client");
const { closeServer } = require("./helpers/server-close");
const guard = require("./helpers/network-guard");
// Contract compatibility is proven against the shared package (test-only import).
const I = require("../../../packages/identity-and-permissions");

const KID = "hq-gw-test-1";
const KEY = randomBytes(32);
const STAFF_ID = "3f0b0c1e-8a7d-4a43-9d0e-1b2c3d4e5f60";
const SESSION_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const INTEGRATION_ID = "0b6c7d8e-9f01-4a23-8b45-67890abcdef1";
const SUB_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cf-gw-"));
}

function writeKey(dir, key = KEY) {
  const file = path.join(dir, "hq-delegation.key");
  fs.writeFileSync(file, key.toString("base64url") + "\n", { mode: 0o600 });
  return file;
}

// Stand-in for the real `authenticate`: identity comes from test headers.
function fakeAuthenticate(req, _res, next) {
  const who = req.get("x-test-user");
  if (!who) return next(new ApiError(401, "No token provided"));
  const now = Date.now();
  req.adminUser = { id: STAFF_ID, tier: who, department: "Operations", status: "ACTIVE" };
  const sessionless = req.get("x-test-sessionless") === "1";
  const mfaAgeMs = Number(req.get("x-test-mfa-age-ms") || 30000);
  req.authSession = sessionless
    ? { id: null, mfaVerifiedAt: null, authMethod: "LEGACY_TOKEN", tokenIssuedAt: Math.floor(now / 1000) - 60 }
    : { id: SESSION_ID, mfaVerifiedAt: new Date(now - mfaAgeMs), authMethod: "PASSWORD", tokenIssuedAt: Math.floor(now / 1000) - 120 };
  return next();
}

const passThrough = (_req, _res, next) => next();

function buildApp(gatewayDeps) {
  const gateway = createProductGateway({ authenticate: fakeAuthenticate, requireAuthSchema: passThrough, requireRecentMfa, ...gatewayDeps });
  const app = express();
  app.use(requestContext);
  app.use(express.json({ limit: "10kb" }));
  app.use("/api/products", gateway.productsRouter);
  app.use("/api/admin/product-integrations", gateway.adminRouter);
  app.use("/api/admin/product-integration-grants", gateway.adminRouter);
  app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));
  app.use(errorHandler);
  return { app, gateway };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Fake Product Integration Core: verifies every token with the shared
// package, exactly as the real PIC does, and echoes what it received.
function fakePic({ respond } = {}) {
  const seen = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const tokens = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "x-cf-hq-delegation") tokens.push(req.rawHeaders[i + 1]);
      let claims = null;
      let verifyError = null;
      try {
        if (tokens.length !== 1) throw new Error("token_count_" + tokens.length);
        claims = I.verifyDelegation(tokens[0], { keys: { [KID]: { key: KEY } }, typ: I.TYPES.HQ, issuer: "central-admin-api", audience: "product-integration-core", binding: I.requestBinding(req.method, req.url, body) });
      } catch (err) {
        verifyError = err.reason || err.message;
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8"), claims, verifyError };
      seen.push(record);
      if (respond) return respond(req, res, record);
      res.writeHead(verifyError ? 401 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(verifyError ? { success: false, error: { code: "UNAUTHENTICATED", reason: verifyError } } : { success: true, data: { url: req.url } }));
    });
  };
  return { seen, handler };
}

async function startPicTcp(options) {
  const pic = fakePic(options);
  const server = http.createServer(pic.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { ...pic, server, url: "http://127.0.0.1:" + server.address().port };
}

function enabledEnv(extra = {}) {
  return { PRODUCT_INTEGRATION_ENABLED: "true", PRODUCT_INTEGRATION_HQ_DELEGATION_KID: KID, ...extra };
}

async function request(base, method, p, { headers = {}, body } = {}) {
  const res = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

function rawRequest(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("configuration is disabled by default and never throws", () => {
  assert.deepEqual(loadGatewayConfig({}), { enabled: false, configured: false, reason: "PRODUCT_INTEGRATION_DISABLED" });
  const notConfigured = [
    enabledEnv(),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "http://10.0.0.5:4300", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "https://127.0.0.1:4300", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "http://user:pw@127.0.0.1:4300", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "http://127.0.0.1:4300/internal", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "http://localhost:4300", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_SOCKET_PATH: "relative.sock", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_SOCKET_PATH: "/run/../etc/x.sock", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_SOCKET_PATH: "/run/pic.sock", PRODUCT_INTEGRATION_CORE_URL: "http://127.0.0.1:4300", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_SOCKET_PATH: "/run/pic.sock", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "relative.key" }),
    enabledEnv({ PRODUCT_INTEGRATION_CORE_SOCKET_PATH: "/run/pic.sock", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k", PRODUCT_INTEGRATION_HQ_DELEGATION_KID: "bad kid" }),
  ];
  for (const env of notConfigured) {
    const config = loadGatewayConfig(env);
    assert.equal(config.enabled, true);
    assert.equal(config.configured, false, JSON.stringify(env));
    assert.equal(config.reason, "PRODUCT_INTEGRATION_NOT_CONFIGURED");
  }
  const ok = loadGatewayConfig(enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "http://[::1]:4300", PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: "/run/k" }));
  assert.equal(ok.configured, true);
  assert.deepEqual(ok.transport, { kind: "tcp", host: "::1", port: 4300 });
});

test("gateway delegation tokens are verified by the shared identity package", () => {
  const binding = requestBinding("POST", "/internal/pic/v1/admin/product-integrations?x=1", Buffer.from('{"a":1}'));
  assert.equal(binding, I.requestBinding("POST", "/internal/pic/v1/admin/product-integrations?x=1", Buffer.from('{"a":1}')));
  const now = Date.now();
  const token = signHqDelegation({ claims: { sub: STAFF_ID, sid: SESSION_ID, auth_time: Math.floor(now / 1000) - 10, mfa_at: Math.floor(now / 1000) - 5, tier: "SUPER", dept: "Operations", bnd: binding }, key: KEY, kid: KID, now });
  const claims = I.verifyDelegation(token, { keys: { [KID]: { key: KEY } }, typ: I.TYPES.HQ, issuer: "central-admin-api", audience: "product-integration-core", binding, now });
  assert.equal(claims.sub, STAFF_ID);
  assert.equal(claims.exp - claims.iat, 30);
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(token.split(".")[0], "base64url"))).sort(), ["alg", "kid", "typ"]);
  // A caller cannot override issuer/audience or add claims.
  const forced = signHqDelegation({ claims: { sub: STAFF_ID, sid: SESSION_ID, auth_time: 1, bnd: binding, iss: "evil", aud: "evil" }, key: KEY, kid: KID, now });
  assert.equal(I.verifyDelegation(forced, { keys: { [KID]: { key: KEY } }, typ: I.TYPES.HQ, issuer: "central-admin-api", audience: "product-integration-core", binding, now }).iss, "central-admin-api");
  assert.throws(() => signHqDelegation({ claims: { role: "SUPER" }, key: KEY, kid: KID, now }), /CLAIM_NOT_ALLOWED/);
  assert.throws(() => signHqDelegation({ claims: {}, key: Buffer.alloc(8), kid: KID, now }), /KEY_INVALID/);
  // Another binding (different body) is refused by the verifier.
  assert.throws(() => I.verifyDelegation(token, { keys: { [KID]: { key: KEY } }, typ: I.TYPES.HQ, issuer: "central-admin-api", audience: "product-integration-core", binding: I.requestBinding("POST", "/internal/pic/v1/admin/product-integrations?x=1", Buffer.from('{"a":2}')), now }), (e) => e.reason === "BINDING_MISMATCH");
});

test("unauthenticated, disabled, session-less and stale-MFA requests never reach PIC", async () => {
  const pic = await startPicTcp();
  const dir = tempDir();
  const keyFile = writeKey(dir);
  const disabled = buildApp({ env: {} });
  const enabled = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: pic.url, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: keyFile }) });
  const missingKey = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: pic.url, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: path.join(dir, "missing.key") }) });
  const servers = await Promise.all([listen(disabled.app), listen(enabled.app), listen(missingKey.app)]);
  const [d, e, m] = servers.map((s) => "http://127.0.0.1:" + s.address().port);
  try {
    const unauth = await request(e, "GET", "/api/products");
    assert.equal(unauth.status, 401);
    const off = await request(d, "GET", "/api/products", { headers: { "x-test-user": "SUPER" } });
    assert.equal(off.status, 503);
    assert.equal(off.json.code, "PRODUCT_INTEGRATION_DISABLED");
    const offAdmin = await request(d, "POST", `/api/admin/product-integrations/${INTEGRATION_ID}/approve`, { headers: { "x-test-user": "SUPER" }, body: { expected_revision: 6 } });
    assert.equal(offAdmin.status, 503);
    assert.equal(offAdmin.json.code, "PRODUCT_INTEGRATION_DISABLED");
    const noKey = await request(m, "GET", "/api/products", { headers: { "x-test-user": "EMPLOYEE" } });
    assert.equal(noKey.status, 503);
    assert.equal(noKey.json.code, "PRODUCT_INTEGRATION_NOT_CONFIGURED");
    const sessionless = await request(e, "GET", "/api/products", { headers: { "x-test-user": "SUPER", "x-test-sessionless": "1" } });
    assert.equal(sessionless.status, 403);
    assert.equal(sessionless.json.code, "SESSION_REQUIRED");
    const staleMfa = await request(e, "POST", `/api/admin/product-integrations/${INTEGRATION_ID}/approve`, { headers: { "x-test-user": "SUPER", "x-test-mfa-age-ms": String(10 * 60 * 1000) }, body: { expected_revision: 6 } });
    assert.equal(staleMfa.status, 403);
    assert.equal(staleMfa.json.code, "MFA_STEP_UP_REQUIRED");
    assert.equal(pic.seen.length, 0, "PIC was never contacted");
  } finally {
    await Promise.all([...servers, pic.server].map(closeServer));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only allowlisted route shapes and metric query keys are forwarded", async () => {
  const pic = await startPicTcp();
  const dir = tempDir();
  const { app } = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: pic.url, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: writeKey(dir) }) });
  const server = await listen(app);
  const base = "http://127.0.0.1:" + server.address().port;
  const h = { "x-test-user": "SUPER" };
  try {
    for (const [method, p] of [
      ["GET", "/api/products/karryam/bridge"],
      ["GET", "/api/products/karryam/capabilities/extra"],
      ["GET", "/api/products/KARRYAM/manifest"],
      ["DELETE", "/api/products/karryam/manifest"],
      ["POST", "/api/products/karryam/manifest"],
      ["GET", "/api/products/karryam/datasets/x/snapshots"],
      ["POST", "/api/admin/product-integrations/not-a-uuid/approve"],
      ["POST", `/api/admin/product-integrations/${INTEGRATION_ID}/enable-everything`],
      ["POST", `/api/admin/product-integrations/${INTEGRATION_ID}/subscriptions/not-a-uuid/enable`],
      ["GET", "/api/admin/product-integration-grants"],
      ["POST", "/api/admin/product-integration-grants/not-a-uuid/revoke"],
    ]) {
      const res = await request(base, method, p, { headers: h, body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 404, method + " " + p);
    }
    for (const p of ["/api/products/../x", "/api/products/karryam/%2e%2e/manifest", "/api/products//karryam/manifest", "/api/products/karryam/operations/%2F..%2Finternal"]) {
      const res = await rawRequest(server.address().port, "GET", p, h);
      assert.equal(res.status, 404, p);
    }
    for (const query of ["?market=NG&market=GH", "?bridge=1", "?market=NG;DROP", "?window_start=" + "1".repeat(80)]) {
      const res = await request(base, "GET", "/api/products/karryam/metrics/trips_completed" + query, { headers: h });
      assert.equal(res.status, 400, query);
      assert.equal(res.json.code, "INVALID_QUERY");
    }
    assert.equal(pic.seen.length, 0, "nothing reached PIC");
  } finally {
    await closeServer(server);
    await closeServer(pic.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("allowlisted requests reach PIC over loopback with a request-bound delegation and no client headers", async () => {
  const pic = await startPicTcp({
    respond: (req, res, record) => {
      if (record.verifyError) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ success: false, error: { code: "UNAUTHENTICATED", reason: record.verifyError } })); }
      if (req.url.startsWith("/internal/pic/v1/products/karryam/metrics")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ contract_version: "1.0", product_id: "karryam", correlation_id: "c-1234567", as_of: null, freshness: "UNKNOWN", coverage: "UNKNOWN", result: null, error: { code: "UNAVAILABLE", reason: "NO_SOURCE_OBSERVATION" } }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true, data: { url: req.url } }));
    },
  });
  const dir = tempDir();
  const { app } = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: pic.url, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: writeKey(dir) }) });
  const server = await listen(app);
  const base = "http://127.0.0.1:" + server.address().port;
  const h = { "x-test-user": "EMPLOYEE", authorization: "Bearer browser-token", "x-role": "SUPER", cookie: "cf_session=abc", "x-request-id": "corr-12345678" };
  try {
    const list = await request(base, "GET", "/api/products?cachebust=1", { headers: h });
    assert.equal(list.status, 200);
    assert.equal(list.json.data.url, "/internal/pic/v1/products", "unknown query on non-metric routes is dropped");
    assert.equal(list.headers.get("cache-control"), "no-store");

    const metric = await request(base, "GET", "/api/products/karryam/metrics/trips_completed?market=NG&window_start=2026-10-01T00:00:00Z&limit=7", { headers: h });
    assert.equal(metric.status, 503, "PIC status passes through");
    assert.equal(metric.json.error.reason, "NO_SOURCE_OBSERVATION", "PIC envelope passes through unchanged");
    assert.equal(metric.json.contract_version, "1.0");

    const approve = await request(base, "POST", `/api/admin/product-integrations/${INTEGRATION_ID}/approve`, { headers: h, body: { expected_revision: 6 } });
    assert.equal(approve.status, 200);
    const sub = await request(base, "POST", `/api/admin/product-integrations/${INTEGRATION_ID}/subscriptions/${SUB_ID}/enable`, { headers: h, body: {} });
    assert.equal(sub.status, 200);
    const grant = await request(base, "POST", "/api/admin/product-integration-grants", { headers: h, body: { grant_kind: "PRODUCT", product_id: "karryam" } });
    assert.equal(grant.status, 200);
    assert.equal(grant.json.data.url, "/internal/pic/v1/admin/product-integration-grants");

    assert.equal(pic.seen.length, 5);
    for (const record of pic.seen) {
      assert.equal(record.verifyError, null, record.url + ": " + record.verifyError);
      assert.equal(record.claims.sub, STAFF_ID);
      assert.equal(record.claims.sid, SESSION_ID);
      assert.equal(record.claims.tier, "EMPLOYEE");
      assert.equal(record.claims.dept, "Operations");
      assert.ok(Number.isInteger(record.claims.mfa_at));
      assert.ok(record.claims.auth_time <= record.claims.iat);
      assert.equal(record.headers.authorization, undefined, "browser credential is never forwarded");
      assert.equal(record.headers.cookie, undefined);
      assert.equal(record.headers["x-role"], undefined);
      assert.equal(record.headers["x-correlation-id"], "corr-12345678");
    }
    assert.equal(pic.seen[1].url, "/internal/pic/v1/products/karryam/metrics/trips_completed?market=NG&window_start=2026-10-01T00%3A00%3A00Z&limit=7");
    assert.equal(pic.seen[2].url, `/internal/pic/v1/admin/product-integrations/${INTEGRATION_ID}/approve`);
    assert.deepEqual(JSON.parse(pic.seen[2].body), { expected_revision: 6 });
    assert.equal(pic.seen[0].method, "GET");
    assert.equal(pic.seen[0].body, "");
  } finally {
    await closeServer(server);
    await closeServer(pic.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SUPER tier gets no gateway bypass: PIC's denial passes through", async () => {
  const pic = await startPicTcp({
    respond: (_req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: { code: "FORBIDDEN", reason: "MISSING_PRODUCT_GRANT" } })); },
  });
  const dir = tempDir();
  const { app } = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: pic.url, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: writeKey(dir) }) });
  const server = await listen(app);
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (const tier of ["SUPER", "EXECUTIVE", "ADMIN"]) {
      const res = await request(base, "GET", "/api/products/karryam/manifest", { headers: { "x-test-user": tier } });
      assert.equal(res.status, 403);
      assert.equal(res.json.error.reason, "MISSING_PRODUCT_GRANT");
    }
    assert.equal(pic.seen.length, 3);
    assert.ok(pic.seen.every((r) => r.verifyError === null));
  } finally {
    await closeServer(server);
    await closeServer(pic.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PIC over a private Unix socket", async () => {
  const dir = tempDir();
  const socketPath = path.join(dir, "pic.sock");
  const pic = fakePic();
  const picServer = http.createServer(pic.handler);
  await new Promise((resolve) => picServer.listen(socketPath, resolve));
  // The test network guard models http.request({socketPath}) as localhost:80.
  const unregister = guard.registerLocalPort(80);
  const { app } = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_SOCKET_PATH: socketPath, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: writeKey(dir) }) });
  const server = await listen(app);
  try {
    const res = await request("http://127.0.0.1:" + server.address().port, "GET", "/api/products/karryam/events/status", { headers: { "x-test-user": "EMPLOYEE" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.url, "/internal/pic/v1/products/karryam/events/status");
    assert.equal(pic.seen[0].verifyError, null);
  } finally {
    unregister();
    await closeServer(server);
    await closeServer(picServer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PIC transport failures are bounded: redirect 502, oversized 502, non-JSON 502, refused/timeout 503", async () => {
  const pic = await startPicTcp({
    respond: (req, res) => {
      if (req.url.endsWith("/manifest")) { res.writeHead(302, { Location: "http://169.254.169.254/" }); return res.end(); }
      if (req.url.endsWith("/datasets")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) })); }
      if (req.url.endsWith("/capabilities")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>"); }
      if (req.url.endsWith("/events/status")) return setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); }, 1500);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("{}");
    },
  });
  const dir = tempDir();
  const keyFile = writeKey(dir);
  const { app } = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: pic.url, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: keyFile }), call: (t, o) => callPic(t, { ...o, timeoutMs: 300 }) });
  const closedPort = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const refused = buildApp({ env: enabledEnv({ PRODUCT_INTEGRATION_CORE_URL: "http://127.0.0.1:" + closedPort, PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE: keyFile }) });
  const unregister = guard.registerLocalPort(closedPort);
  const server = await listen(app);
  const refusedServer = await listen(refused.app);
  const base = "http://127.0.0.1:" + server.address().port;
  const h = { "x-test-user": "EMPLOYEE" };
  try {
    const redirect = await request(base, "GET", "/api/products/karryam/manifest", { headers: h });
    assert.equal(redirect.status, 502);
    assert.equal(redirect.json.code, "PRODUCT_INTEGRATION_REDIRECT_REFUSED");
    const big = await request(base, "GET", "/api/products/karryam/datasets", { headers: h });
    assert.equal(big.status, 502);
    assert.equal(big.json.code, "PRODUCT_INTEGRATION_RESPONSE_TOO_LARGE");
    const html = await request(base, "GET", "/api/products/karryam/capabilities", { headers: h });
    assert.equal(html.status, 502);
    assert.equal(html.json.code, "PRODUCT_INTEGRATION_INVALID_RESPONSE");
    const slow = await request(base, "GET", "/api/products/karryam/events/status", { headers: h });
    assert.equal(slow.status, 503);
    assert.equal(slow.json.code, "PRODUCT_INTEGRATION_UNAVAILABLE");
    const down = await request("http://127.0.0.1:" + refusedServer.address().port, "GET", "/api/products", { headers: h });
    assert.equal(down.status, 503);
    assert.equal(down.json.code, "PRODUCT_INTEGRATION_UNAVAILABLE");
    assert.equal(down.json.retryable, true);
  } finally {
    unregister();
    await closeServer(server);
    await closeServer(refusedServer);
    await closeServer(pic.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("app.js mounts the gateway disabled by default without changing existing routes", async () => {
  const { createApp } = require("../src/app");
  const app = createApp({
    env: { ...process.env, NODE_ENV: "test", PRODUCT_INTEGRATION_ENABLED: "false" },
    passportInstance: { initialize: () => (req, res, next) => next() },
    googleStrategyRegistrar: () => ({ enabled: false }),
    cloudinaryConfigurator: () => ({ configured: false }),
    mailHttpFactory: () => ({ application: { stub: true }, router: express.Router(), webhookHandler: (req, res) => res.json({ success: true }) }),
  });
  const server = await listen(app);
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const health = await request(base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.service, "cosmicforge-admin-api");
    for (const p of ["/api/products", "/api/products/karryam/manifest", `/api/admin/product-integrations/${INTEGRATION_ID}`]) {
      const res = await request(base, "GET", p);
      assert.equal(res.status, 401, p + " requires the existing staff authentication");
    }
    const grants = await request(base, "POST", "/api/admin/product-integration-grants", { body: {} });
    assert.equal(grants.status, 401);
    const legacyAlias = await request(base, "GET", "/api/karryam/capabilities");
    assert.equal(legacyAlias.status, 404, "no PR #36 compatibility alias or second bridge caller");
    const unknown = await request(base, "GET", "/api/definitely-not-a-route");
    assert.equal(unknown.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("gateway has no direct database or bridge access and the legacy dispatch router stays unmounted", () => {
  const root = path.join(__dirname, "..", "src", "modules", "product-gateway");
  const files = fs.readdirSync(root).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 5);
  const forbidden = [/prisma/i, /dispatchDatabase/, /mainDatabase/, /config\/database/, /DISPATCH_DATABASE_URL/, /MAIN_DATABASE_URL/, /DATABASE_URL/, /\/internal\/karryam-admin/, /require\(["'][^"']*packages\//];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const pattern of forbidden) assert.ok(!pattern.test(source), file + " must not match " + pattern);
    for (const [, spec] of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      assert.ok(spec.startsWith("node:") || spec === "express" || spec.startsWith("./") || spec.startsWith("../../shared/"), file + " requires " + spec);
    }
  }
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  assert.ok(!/modules\/karrygo/.test(appSource), "legacy direct-DB dispatch router must not be mounted without a reviewed change");
  assert.ok(!/dispatchDatabase|dispatchPrisma/.test(appSource));
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "karrygo", "dispatch", "dispatch.routes.js"), "utf8");
  assert.ok(/legacyDirectDbTelemetry\("karrygo-dispatch"\)/.test(routes), "legacy router carries routing telemetry");
});

test("legacy dispatch telemetry logs coarse route data only", () => {
  const { legacyDirectDbTelemetry } = require("../src/modules/karrygo/dispatch/legacy-telemetry");
  const logged = [];
  const mw = legacyDirectDbTelemetry("karrygo-dispatch", { log: { warn: (msg, meta) => logged.push({ msg, meta }) } });
  let called = false;
  mw({ path: "/providers/2b1c-secret-id/verify/approve", method: "POST", correlationId: "c-1" }, {}, () => { called = true; });
  assert.ok(called);
  assert.equal(logged[0].msg, "legacy_direct_db_route");
  assert.deepEqual(logged[0].meta, { event: "legacy_direct_db_route", route: "karrygo-dispatch", resource: "providers", method: "POST", correlation_id: "c-1" });
  assert.ok(!JSON.stringify(logged).includes("secret-id"));
});
