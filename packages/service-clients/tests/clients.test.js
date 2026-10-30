"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { once } = require("node:events");
const S = require("../src");
const C = require("../../admin-contracts");
const { generatePki } = require("./helpers/pki");

const key = Buffer.alloc(32, 9);
const auth = { serviceId: "hq-product-integration-core", keyId: "pic-k1", key };
const keys = { "pic-k1": { serviceId: "hq-product-integration-core", key } };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function rawHeaders(headers) {
  return Object.entries(headers).flatMap(([k, v]) => [k, v]);
}

test("service signatures verify once and reject replay, duplicates, skew and wrong keys", async () => {
  const store = S.memoryNonceStore();
  const headers = S.signServiceRequest({ ...auth, method: "GET", uri: "/internal/product-admin/v1/manifest" });
  const input = { rawHeaders: rawHeaders(headers), method: "GET", uri: "/internal/product-admin/v1/manifest", keys, nonceStore: store };
  assert.deepEqual(await S.verifyServiceRequest(input), { serviceId: "hq-product-integration-core", keyId: "pic-k1" });
  await assert.rejects(S.verifyServiceRequest(input), (e) => e.reason === "REPLAYED");
  const fresh = S.signServiceRequest({ ...auth, method: "GET", uri: "/x" });
  await assert.rejects(S.verifyServiceRequest({ ...input, rawHeaders: [...rawHeaders(fresh), "X-CF-Nonce", fresh["x-cf-nonce"]], uri: "/x" }), (e) => e.reason === "DUPLICATE_HEADER");
  await assert.rejects(S.verifyServiceRequest({ ...input, rawHeaders: rawHeaders(fresh), uri: "/y" }), (e) => e.reason === "SIGNATURE_INVALID");
  const old = S.signServiceRequest({ ...auth, method: "GET", uri: "/x", now: Date.now() - 120000 });
  await assert.rejects(S.verifyServiceRequest({ ...input, rawHeaders: rawHeaders(old), uri: "/x" }), (e) => e.reason === "TIMESTAMP_SKEW");
  const other = S.signServiceRequest({ serviceId: "karryam-admin", keyId: "pic-k1", key, method: "GET", uri: "/x" });
  await assert.rejects(S.verifyServiceRequest({ ...input, rawHeaders: rawHeaders(other), uri: "/x" }), (e) => e.reason === "KEY_UNKNOWN");
  const body = S.signServiceRequest({ ...auth, method: "POST", uri: "/x", body: Buffer.from("{\"a\":1}") });
  await assert.rejects(S.verifyServiceRequest({ ...input, rawHeaders: rawHeaders(body), method: "POST", uri: "/x", body: Buffer.from("{\"a\":2}") }), (e) => e.reason === "SIGNATURE_INVALID");
  await assert.rejects(S.verifyServiceRequest({ ...input, rawHeaders: rawHeaders(S.signServiceRequest({ ...auth, method: "GET", uri: "/z" })), uri: "/z", nonceStore: null }), (e) => e.reason === "REPLAY_STORE_UNAVAILABLE");
});

test("fixed targets refuse public, metadata, credentialed and non-HTTPS destinations", () => {
  const tls = { ca: "x", cert: "x", key: "x" };
  const bad = [
    { ref: "a", transport: "https", origin: "https://karryam-admin.internal", address: "8.8.8.8", tls },
    { ref: "a", transport: "https", origin: "https://karryam-admin.internal", address: "169.254.169.254", tls },
    { ref: "a", transport: "https", origin: "https://karryam-admin.internal", address: "100.64.0.1", tls },
    { ref: "a", transport: "https", origin: "https://user:pw@karryam-admin.internal", address: "10.0.0.5", tls },
    { ref: "a", transport: "https", origin: "https://karryam-admin.internal/redirect", address: "10.0.0.5", tls },
    { ref: "a", transport: "https", origin: "https://karryam-admin.internal", address: "karryam-admin.internal", tls },
    { ref: "a", transport: "https", origin: "http://karryam-admin.internal", address: "10.0.0.5", tls },
    { ref: "a", transport: "https", origin: "https://karryam-admin.internal", address: "10.0.0.5" },
    { ref: "a", transport: "http-loopback", origin: "http://10.0.0.5:4000", address: "10.0.0.5" },
    { ref: "a", transport: "unix", socketPath: "relative.sock" },
    { ref: "a", transport: "unix", socketPath: "/run/../etc/passwd" },
  ];
  for (const spec of bad) assert.throws(() => S.createFixedTarget(spec, { allowInsecureLoopback: true }), S.TargetError, JSON.stringify(spec));
  assert.throws(() => S.createFixedTarget({ ref: "a", transport: "http-loopback", origin: "http://127.0.0.1:4000", address: "127.0.0.1" }), (e) => e.reason === "INSECURE_TRANSPORT_REFUSED");
  assert.equal(S.createFixedTarget({ ref: "a", transport: "https", origin: "https://karryam-admin.internal:8443", address: "10.20.0.5", tls }).port, 8443);
  assert.equal(S.isPrivateAddress("fd00::1"), true);
  assert.equal(S.isPrivateAddress("2001:4860::1"), false);
  assert.equal(S.isPrivateAddress("::ffff:169.254.169.254"), false);
});

test("client refuses redirects, oversized and non-JSON responses; classifies retries", async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/redirect")) { res.writeHead(302, { Location: "http://169.254.169.254/" }); return res.end(); }
    if (req.url.startsWith("/big")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ x: "y".repeat(5000) })); }
    if (req.url.startsWith("/html")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>"); }
    if (req.url.startsWith("/slow")) return setTimeout(() => res.end("{}"), 1000);
    if (req.url.startsWith("/busy")) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end("{}"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ headers: req.headers, url: req.url }));
  });
  const port = await listen(server);
  try {
    const target = S.createFixedTarget({ ref: "t", transport: "http-loopback", origin: "http://127.0.0.1:" + port, address: "127.0.0.1" }, { allowInsecureLoopback: true });
    const client = S.createServiceClient({ target, auth, timeoutMs: 300, maxResponseBytes: 2048 });
    const ok = await client.request({ path: "/echo", query: { a: "1" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.url, "/echo?a=1");
    assert.equal(ok.json.headers["x-cf-service-id"], "hq-product-integration-core");
    assert.ok(ok.json.headers["x-correlation-id"]);
    await assert.rejects(client.request({ path: "/redirect" }), (e) => e.code === "REDIRECT_REFUSED");
    await assert.rejects(client.request({ path: "/big" }), (e) => e.code === "RESPONSE_TOO_LARGE");
    await assert.rejects(client.request({ path: "/html" }), (e) => e.code === "CONTENT_TYPE_REFUSED");
    await assert.rejects(client.request({ path: "/slow" }), (e) => e.code === "TIMEOUT" && e.retry === "RETRYABLE");
    await assert.rejects(client.request({ method: "POST", path: "/slow", body: {} }), (e) => e.code === "TIMEOUT" && e.retry === "UNKNOWN_OUTCOME");
    await assert.rejects(client.request({ path: "/../etc" }), (e) => e.code === "PATH_REFUSED");
    await assert.rejects(client.request({ path: "http://evil/" }), (e) => e.code === "PATH_REFUSED");
    await assert.rejects(client.request({ method: "DELETE", path: "/x" }), (e) => e.code === "METHOD_REFUSED");
    assert.equal((await client.request({ path: "/busy" })).retry, "RETRYABLE");
  } finally {
    server.close();
  }
  const closed = S.createServiceClient({ target: S.createFixedTarget({ ref: "t", transport: "http-loopback", origin: "http://127.0.0.1:1", address: "127.0.0.1" }, { allowInsecureLoopback: true }), auth });
  await assert.rejects(closed.request({ path: "/x" }), (e) => e.retry === "RETRYABLE");
});

test("TLS 1.3 mutual TLS with pinned server identity", async (t) => {
  let pki;
  try { pki = generatePki(); } catch { t.skip("openssl unavailable"); return; }
  const server = https.createServer({ cert: pki.serverCert, key: pki.serverKey, ca: pki.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ client: req.socket.getPeerCertificate().subject.CN, tls: req.socket.getProtocol() }));
  });
  const rogue = https.createServer({ cert: pki.rogueCert, key: pki.rogueKey, ca: pki.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  const port = await listen(server);
  const roguePort = await listen(rogue);
  try {
    const pin = S.fingerprint256(pki.serverCert);
    const tls = { ca: pki.ca, cert: pki.clientCert, key: pki.clientKey, serverFingerprint256: pin };
    const client = S.createServiceClient({ target: S.createFixedTarget({ ref: "k", transport: "https", origin: "https://" + pki.serverName + ":" + port, address: "127.0.0.1", tls }), auth });
    const res = await client.request({ path: "/internal/product-admin/v1/manifest" });
    assert.equal(res.json.tls, "TLSv1.3");
    assert.equal(res.json.client, "cosmicforge-hq-product-integration-core");
    // Same CA, same name, different certificate: the pin refuses it.
    const pinned = S.createServiceClient({ target: S.createFixedTarget({ ref: "k", transport: "https", origin: "https://" + pki.serverName + ":" + roguePort, address: "127.0.0.1", tls }), auth });
    await assert.rejects(pinned.request({ path: "/x" }), (e) => e.code === "FINGERPRINT_MISMATCH" && e.retry === "FATAL");
    // Wrong server name is refused even with a valid chain.
    const misnamed = S.createServiceClient({ target: S.createFixedTarget({ ref: "k", transport: "https", origin: "https://other.internal:" + port, address: "127.0.0.1", tls: { ...tls, serverFingerprint256: null } }), auth });
    await assert.rejects(misnamed.request({ path: "/x" }));
  } finally {
    server.close();
    rogue.close();
    pki.cleanup();
  }
});

test("product admin client validates envelopes against the expected product", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const productId = req.url.includes("capabilities") ? "karryam" : "synthetic-third";
    res.end(JSON.stringify(C.okEnvelope({ productId, result: { ok: true } })));
  });
  const port = await listen(server);
  try {
    const target = S.createFixedTarget({ ref: "t", transport: "http-loopback", origin: "http://127.0.0.1:" + port, address: "127.0.0.1" }, { allowInsecureLoopback: true });
    const client = S.createProductAdminClient({ productId: "synthetic-third", target, auth });
    assert.equal((await client.getManifest()).json.result.ok, true);
    await assert.rejects(client.getCapabilities(), (e) => e.code === "ENVELOPE_INVALID");
    await assert.rejects(client.getDatasetSnapshot("../admin"), (e) => e.code === "PATH_PARAM_INVALID");
  } finally {
    server.close();
  }
});
