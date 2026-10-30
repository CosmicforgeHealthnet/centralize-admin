"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { createServer, listen } = require("../src/transport/listener");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");
const { clients } = require("../src/packages");

const ok = (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"ok\":true}"); };

test("unix socket listener is created with mode 0660 and replaces only a stale socket", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ka-sock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = { kind: "unix", path: path.join(dir, "karryam-admin.sock") };
  const server = createServer(ok, { listen: spec, tls: null });
  await listen(server, spec);
  assert.equal(fs.statSync(spec.path).mode & 0o777, 0o660);
  const body = await new Promise((resolve, reject) => http.get({ socketPath: spec.path, path: "/x" }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); }).on("error", reject));
  assert.equal(body, "{\"ok\":true}");
  await new Promise((r) => server.close(r));
  const notSocket = { kind: "unix", path: path.join(dir, "regular-file") };
  fs.writeFileSync(notSocket.path, "x");
  await assert.rejects(listen(createServer(ok, { listen: notSocket, tls: null }), notSocket), /LISTEN_PATH_NOT_A_SOCKET/);
  assert.throws(() => createServer(ok, { listen: { kind: "tcp", host: "10.0.0.5", port: 1, loopback: false }, tls: null }), /NON_LOOPBACK_TCP_REQUIRES_MTLS/);
});

test("private TCP listener enforces TLS 1.3 mutual TLS and a client fingerprint allowlist", async (t) => {
  let pki;
  try { pki = generatePki({ serverName: "karryam-admin.internal" }); } catch { t.skip("openssl unavailable"); return; }
  t.after(pki.cleanup);
  const allowed = clients.fingerprint256(pki.clientCert);
  const run = async (fingerprints) => {
    const spec = { kind: "tcp", host: "127.0.0.1", port: 0, loopback: true };
    const server = createServer(ok, { listen: spec, tls: { cert: pki.serverCert, key: pki.serverKey, clientCa: pki.ca, allowedClientFingerprints: fingerprints } });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const request = (opts) => new Promise((resolve) => {
      const req = https.request({ host: "127.0.0.1", port: server.address().port, servername: pki.serverName, path: "/x", ca: pki.ca, agent: false, ...opts }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", (e) => resolve("error:" + (e.code || e.message)));
      req.end();
    });
    const results = {
      withCert: await request({ cert: pki.clientCert, key: pki.clientKey }),
      noCert: await request({}),
      tls12: await request({ cert: pki.clientCert, key: pki.clientKey, maxVersion: "TLSv1.2" }),
    };
    await new Promise((r) => server.close(r));
    return results;
  };
  const accepted = await run([allowed]);
  assert.equal(accepted.withCert, 200);
  assert.match(String(accepted.noCert), /^error:/);
  assert.match(String(accepted.tls12), /^error:/);
  const refused = await run(["0".repeat(64)]);
  assert.match(String(refused.withCert), /^error:/, "valid chain but non-allowlisted fingerprint is dropped");
});
