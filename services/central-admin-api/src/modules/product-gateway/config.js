"use strict";

// Product gateway configuration. Disabled by default and never throws:
// an enabled-but-invalid configuration makes only the product routes answer
// 503 PRODUCT_INTEGRATION_NOT_CONFIGURED; the rest of the API is unaffected.
//
// Transport to the Product Integration Core (PIC) is private only:
//   PRODUCT_INTEGRATION_CORE_SOCKET_PATH  absolute Unix socket path, or
//   PRODUCT_INTEGRATION_CORE_URL          http://127.0.0.1:<port> or http://[::1]:<port>
// A PIC on another host needs TLS 1.3 mutual TLS, which is a later
// infrastructure step; non-loopback URLs are refused in this phase.

const fs = require("node:fs");
const path = require("node:path");

const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const KEY_CACHE_MS = 60 * 1000;

function parseTransport(env) {
  const socketPath = env.PRODUCT_INTEGRATION_CORE_SOCKET_PATH;
  const url = env.PRODUCT_INTEGRATION_CORE_URL;
  if (socketPath && url) throw new Error("AMBIGUOUS_TRANSPORT");
  if (socketPath) {
    if (!path.isAbsolute(socketPath) || socketPath.includes("..") || socketPath.includes("\0") || socketPath.length > 107) throw new Error("SOCKET_PATH_INVALID");
    return Object.freeze({ kind: "unix", socketPath });
  }
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("URL_INVALID"); }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "http:" || !loopback || !parsed.port || parsed.username || parsed.password ||
        (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
      throw new Error("URL_NOT_LOOPBACK");
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("URL_INVALID");
    return Object.freeze({ kind: "tcp", host: parsed.hostname === "[::1]" ? "::1" : "127.0.0.1", port });
  }
  throw new Error("TRANSPORT_MISSING");
}

function loadGatewayConfig(env = process.env) {
  const enabled = String(env.PRODUCT_INTEGRATION_ENABLED || "false").trim().toLowerCase() === "true";
  if (!enabled) return Object.freeze({ enabled: false, configured: false, reason: "PRODUCT_INTEGRATION_DISABLED" });
  try {
    const transport = parseTransport(env);
    const keyFile = env.PRODUCT_INTEGRATION_HQ_DELEGATION_KEY_FILE;
    if (!keyFile || !path.isAbsolute(keyFile) || keyFile.includes("..") || keyFile.includes("\0")) throw new Error("KEY_FILE_INVALID");
    const kid = env.PRODUCT_INTEGRATION_HQ_DELEGATION_KID;
    if (!KID.test(String(kid || ""))) throw new Error("KID_INVALID");
    return Object.freeze({ enabled: true, configured: true, transport, keyFile, kid });
  } catch (err) {
    return Object.freeze({ enabled: true, configured: false, reason: "PRODUCT_INTEGRATION_NOT_CONFIGURED", detail: err.message });
  }
}

// Reads the HQ delegation key at use time with a short cache, so rotation
// takes effect without a restart. Returns null if the key is unusable.
function createKeyReader(keyFile, { now = Date.now, readFile = fs.promises.readFile } = {}) {
  let cached = null;
  return async function readKey() {
    if (cached && now() - cached.loadedAt < KEY_CACHE_MS) return cached.key;
    try {
      const raw = String(await readFile(keyFile, "utf8")).trim();
      if (!/^[A-Za-z0-9_-]+$/.test(raw)) { cached = null; return null; }
      const key = Buffer.from(raw, "base64url");
      if (key.length < 32) { cached = null; return null; }
      cached = { key, loadedAt: now() };
      return key;
    } catch {
      cached = null;
      return null;
    }
  };
}

module.exports = { loadGatewayConfig, parseTransport, createKeyReader, KEY_CACHE_MS };
