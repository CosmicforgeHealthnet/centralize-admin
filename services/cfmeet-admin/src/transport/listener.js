"use strict";

// Creates the HTTP(S) server for a validated listen spec.
//  - unix:  host-private socket, mode 0660; a stale socket file is replaced,
//           any other file type at that path is refused.
//  - tcp loopback: plain HTTP allowed (same-host only).
//  - tcp private:  TLS 1.3 only, client certificate required from the
//           configured CA AND its SHA-256 fingerprint must be allowlisted.

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const LIMITS = Object.freeze({ maxHeaderSize: 16 * 1024, requestTimeout: 10000, headersTimeout: 8000, keepAliveTimeout: 5000, maxHeadersCount: 64, maxRequestsPerSocket: 1000 });

function normalizeFingerprint(value) {
  return String(value || "").replace(/:/g, "").toLowerCase();
}

function createServer(handler, { listen, tls }) {
  let server;
  if (tls) {
    server = https.createServer({
      cert: tls.cert, key: tls.key, ca: tls.clientCa,
      requestCert: true, rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      maxHeaderSize: LIMITS.maxHeaderSize,
    }, handler);
    const allowed = new Set(tls.allowedClientFingerprints);
    server.on("secureConnection", (socket) => {
      const cert = socket.getPeerCertificate();
      if (!cert || !allowed.has(normalizeFingerprint(cert.fingerprint256))) socket.destroy();
    });
  } else {
    if (listen.kind === "tcp" && !listen.loopback) throw new Error("NON_LOOPBACK_TCP_REQUIRES_MTLS");
    server = http.createServer({ maxHeaderSize: LIMITS.maxHeaderSize }, handler);
  }
  server.requestTimeout = LIMITS.requestTimeout;
  server.headersTimeout = LIMITS.headersTimeout;
  server.keepAliveTimeout = LIMITS.keepAliveTimeout;
  server.maxHeadersCount = LIMITS.maxHeadersCount;
  server.maxRequestsPerSocket = LIMITS.maxRequestsPerSocket;
  return server;
}

function listen(server, spec) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (spec.kind === "unix") {
      try {
        const stat = fs.lstatSync(spec.path);
        if (!stat.isSocket()) return reject(new Error("LISTEN_PATH_NOT_A_SOCKET"));
        fs.unlinkSync(spec.path);
      } catch (err) {
        if (err.code !== "ENOENT") return reject(err);
      }
      server.listen(spec.path, () => {
        try { fs.chmodSync(spec.path, 0o660); } catch (err) { return reject(err); }
        server.off("error", reject);
        resolve({ kind: "unix" });
      });
    } else {
      server.listen(spec.port, spec.host, () => {
        server.off("error", reject);
        resolve({ kind: "tcp", port: server.address().port });
      });
    }
  });
}

module.exports = { createServer, listen, LIMITS };
