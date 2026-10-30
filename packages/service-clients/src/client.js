"use strict";

const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { randomUUID } = require("node:crypto");
const { signServiceRequest } = require("./service-auth");

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const SAFE_PATH = /^\/[A-Za-z0-9._~:@-]+(?:\/[A-Za-z0-9._~:@-]+)*$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

class ServiceClientError extends Error {
  constructor(code, retry, detail) {
    super(code);
    this.name = "ServiceClientError";
    this.code = code;
    this.retry = retry; // RETRYABLE | FATAL | UNKNOWN_OUTCOME
    this.detail = detail;
  }
}

// Retry classification of an HTTP status. Callers decide whether to retry;
// the client itself never retries (a POST may not be safe to repeat).
function classifyStatus(status) {
  if (status >= 200 && status < 300) return "OK";
  if ([429, 502, 503, 504].includes(status)) return "RETRYABLE";
  return "FATAL";
}

function classifyTransportError(err, method, requestSent) {
  const code = err && (err.code || err.message);
  if (code === "TIMEOUT") return method === "GET" ? "RETRYABLE" : "UNKNOWN_OUTCOME";
  if (["ECONNREFUSED", "ENOENT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "RETRYABLE";
  if (String(code).startsWith("ERR_TLS") || ["CERT_HAS_EXPIRED", "FINGERPRINT_MISMATCH", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION"].includes(code)) return "FATAL";
  return requestSent && method !== "GET" ? "UNKNOWN_OUTCOME" : "RETRYABLE";
}

function buildUri(path, query) {
  if (typeof path !== "string" || !SAFE_PATH.test(path) || path.includes("..") || path.length > 512) {
    throw new ServiceClientError("PATH_REFUSED", "FATAL");
  }
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new ServiceClientError("QUERY_REFUSED", "FATAL");
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? path + "?" + qs : path;
}

/**
 * A client bound to exactly one fixed target and one service identity.
 * There is no way to pass a URL, host or port per request.
 */
function createServiceClient({ target, auth, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, now = Date.now }) {
  if (!target || !target.transport) throw new ServiceClientError("TARGET_REQUIRED", "FATAL");
  if (!auth || !Buffer.isBuffer(auth.key)) throw new ServiceClientError("AUTH_REQUIRED", "FATAL");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new ServiceClientError("TIMEOUT_INVALID", "FATAL");

  function request({ method = "GET", path, query, body, correlationId, delegation }) {
    method = String(method).toUpperCase();
    if (!["GET", "POST"].includes(method)) return Promise.reject(new ServiceClientError("METHOD_REFUSED", "FATAL"));
    let uri;
    try { uri = buildUri(path, query); } catch (err) { return Promise.reject(err); }
    const corr = correlationId && CORRELATION.test(correlationId) ? correlationId : randomUUID();
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    if (payload.length > MAX_REQUEST_BYTES) return Promise.reject(new ServiceClientError("REQUEST_TOO_LARGE", "FATAL"));
    const headers = {
      Accept: "application/json",
      Host: target.hostHeader,
      "X-Correlation-Id": corr,
      ...signServiceRequest({ serviceId: auth.serviceId, keyId: auth.keyId, key: auth.key, method, uri, body: payload, now: now() }),
    };
    if (delegation) {
      if (typeof delegation !== "string" || delegation.length > 8192) return Promise.reject(new ServiceClientError("DELEGATION_INVALID", "FATAL"));
      headers["X-CF-Delegation"] = delegation;
    }
    if (payload.length) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }

    const options = { method, path: uri, headers, agent: false };
    let transport = http;
    if (target.transport === "unix") {
      options.socketPath = target.socketPath;
    } else if (target.transport === "http-loopback") {
      options.host = target.address;
      options.port = target.port;
    } else {
      transport = https;
      Object.assign(options, {
        host: target.address, port: target.port, servername: target.serverName,
        ca: target.tls.ca, cert: target.tls.cert, key: target.tls.key,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) => {
          const err = tls.checkServerIdentity(target.serverName, cert);
          if (err) return err;
          const fp = String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
          if (target.tls.serverFingerprint256 && fp !== target.tls.serverFingerprint256) {
            const pinErr = new Error("FINGERPRINT_MISMATCH");
            pinErr.code = "FINGERPRINT_MISMATCH";
            return pinErr;
          }
          return undefined;
        },
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = false;
      const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const req = transport.request(options, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(reject, new ServiceClientError("REDIRECT_REFUSED", "FATAL"));
        }
        const type = String(res.headers["content-type"] || "");
        if (!/^application\/json(?:;|$)/i.test(type)) {
          res.resume();
          return finish(reject, new ServiceClientError("CONTENT_TYPE_REFUSED", status >= 500 ? "RETRYABLE" : "FATAL"));
        }
        const declared = Number(res.headers["content-length"] || 0);
        if (declared > maxResponseBytes) {
          res.destroy();
          return finish(reject, new ServiceClientError("RESPONSE_TOO_LARGE", "FATAL"));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            res.destroy();
            finish(reject, new ServiceClientError("RESPONSE_TOO_LARGE", "FATAL"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err) => finish(reject, new ServiceClientError("RESPONSE_ABORTED", classifyTransportError(err, method, true))));
        res.on("end", () => {
          let json;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { return finish(reject, new ServiceClientError("RESPONSE_NOT_JSON", "FATAL")); }
          finish(resolve, { status, retry: classifyStatus(status), json, correlationId: corr });
        });
      });
      const timer = setTimeout(() => {
        const err = new Error("TIMEOUT");
        err.code = "TIMEOUT";
        req.destroy(err);
      }, timeoutMs);
      req.on("error", (err) => {
        const code = err.code === "TIMEOUT" ? "TIMEOUT" : err.code === "FINGERPRINT_MISMATCH" ? "FINGERPRINT_MISMATCH" : "TRANSPORT_ERROR";
        finish(reject, new ServiceClientError(code, classifyTransportError(err, method, sent), err.code));
      });
      req.on("finish", () => { sent = true; });
      req.end(payload.length ? payload : undefined);
    });
  }

  return Object.freeze({ request, target: Object.freeze({ ref: target.ref, transport: target.transport }) });
}

module.exports = { ServiceClientError, createServiceClient, classifyStatus, classifyTransportError, buildUri };
