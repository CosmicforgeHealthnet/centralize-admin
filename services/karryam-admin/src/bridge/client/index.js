"use strict";

// Karryam Backoffice Bridge connector. Fixed destination (pinned private IP,
// TLS server name from the operator-configured origin, no DNS), TLS 1.3
// mutual TLS with optional server-certificate fingerprint pinning and a
// revocation list, HMAC v2 + Ed25519 staff assertion, exact paths from the
// pinned registry only, bounded responses, no redirects, strict envelope and
// result-schema validation. The client never retries: callers decide, and an
// irreversible command is never resubmitted (see bridge/errors.js).

const https = require("node:https");
const tls = require("node:tls");
const S = require("./signing");
const R = require("../contracts/registry");
const { BridgeError, fromResponse } = require("../errors");

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 4000;
const BINARY_TYPES = /^(?:image\/(?:jpeg|png|webp)|application\/pdf)$/i;

function fingerprintOf(cert) {
  return String(cert && cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
}

function tlsOptions(bridge) {
  return {
    host: bridge.address, port: bridge.port, servername: bridge.hostname,
    cert: bridge.clientCert, key: bridge.clientKey, ca: bridge.serverCa,
    minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true, agent: false,
    checkServerIdentity: (_host, cert) => {
      const err = tls.checkServerIdentity(bridge.hostname, cert);
      if (err) return err;
      const fp = fingerprintOf(cert);
      if ((bridge.revokedServerFingerprints || []).includes(fp)) return Object.assign(new Error("SERVER_CERT_REVOKED"), { code: "SERVER_CERT_REVOKED" });
      const pins = bridge.serverFingerprints || [];
      if (pins.length && !pins.includes(fp)) return Object.assign(new Error("FINGERPRINT_MISMATCH"), { code: "FINGERPRINT_MISMATCH" });
      return undefined;
    },
  };
}

const SECURITY_CODES = new Set(["EPROTO", "SERVER_CERT_REVOKED", "FINGERPRINT_MISMATCH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION"]);

function createBridgeClient(bridge, { now = () => Math.floor(Date.now() / 1000), nowMs = () => Date.now(), timeoutMs = TIMEOUT_MS, commandTimeoutMs = 8000, metrics = null } = {}) {
  if (!bridge || !bridge.enabled) throw new BridgeError("BRIDGE_DISABLED");
  const hostHeader = bridge.port === 443 ? bridge.hostname : bridge.hostname + ":" + bridge.port;
  const count = (name) => { if (metrics) metrics[name] = (metrics[name] || 0) + 1; };

  function send({ method, uri, body, staff, permissions, mutating, binary }) {
    const headers = S.bridgeHeaders({
      serviceKey: bridge.serviceKey, serviceKid: bridge.serviceKid, privateKey: bridge.staffPrivateKey,
      staffKid: bridge.staffKid, issuer: bridge.issuer, audience: bridge.audience, staff, method, uri, body, permissions, now: now(),
    });
    headers.Host = hostHeader;
    if (binary) headers.Accept = "application/json, image/jpeg, image/png, image/webp, application/pdf";
    return new Promise((resolve, reject) => {
      let done = false;
      let sent = false;
      const finish = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
      const req = https.request({ ...tlsOptions(bridge), path: uri, method, headers }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) { res.resume(); return finish(reject, new BridgeError(mutating ? "UNKNOWN_OUTCOME" : "CONTRACT_MISMATCH", { status, reason: "BRIDGE_REDIRECT_REFUSED" })); }
        const type = String(res.headers["content-type"] || "").split(";")[0].trim();
        const isJson = /^application\/json$/i.test(type);
        const limit = isJson ? MAX_RESPONSE_BYTES : MAX_BINARY_BYTES;
        if (!isJson && !(binary && status === 200 && BINARY_TYPES.test(type))) {
          res.resume();
          return finish(reject, mutating ? new BridgeError("UNKNOWN_OUTCOME", { status }) : new BridgeError(status >= 500 ? "BRIDGE_UNAVAILABLE" : "CONTRACT_MISMATCH", { status, reason: "BRIDGE_CONTENT_TYPE_REFUSED" }));
        }
        if (Number(res.headers["content-length"] || 0) > limit) { res.destroy(); return finish(reject, new BridgeError(mutating ? "UNKNOWN_OUTCOME" : "RESPONSE_TOO_LARGE", { status })); }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit) { res.destroy(); finish(reject, new BridgeError(mutating ? "UNKNOWN_OUTCOME" : "RESPONSE_TOO_LARGE", { status })); return; }
          chunks.push(chunk);
        });
        res.on("error", () => finish(reject, new BridgeError(mutating ? "UNKNOWN_OUTCOME" : "BRIDGE_UNAVAILABLE", { status })));
        res.on("end", () => finish(resolve, { status, type, isJson, bytes: Buffer.concat(chunks), bridgeCorrelationId: String(res.headers["x-correlation-id"] || "") }));
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" })), mutating ? commandTimeoutMs : timeoutMs);
      req.on("finish", () => { sent = true; });
      req.on("error", (err) => {
        const code = err && err.code;
        if (code && (SECURITY_CODES.has(code) || String(code).startsWith("ERR_TLS") || String(code).startsWith("ERR_SSL"))) return finish(reject, new BridgeError("TRANSPORT_SECURITY", { reason: "BRIDGE_TRANSPORT_SECURITY_FAILURE" }));
        if (mutating && sent) return finish(reject, new BridgeError("UNKNOWN_OUTCOME"));
        finish(reject, new BridgeError(code === "TIMEOUT" ? "BRIDGE_TIMEOUT" : "BRIDGE_UNAVAILABLE"));
      });
      req.end(body.length ? body : undefined);
    });
  }

  /**
   * One request to one pinned capability.
   *   staff:      verified staff context (see capabilities.js)
   *   query:      values for the capability's query shape only
   *   pathParams: values for the capability's path parameters only
   *   body:       object validated against the pinned request schema
   * Resolves { capability, result, asOf, freshness, bridgeCorrelationId, status }
   * or { binary: Buffer, contentType } for binary retrievals.
   */
  async function call(capabilityId, { staff, query = {}, pathParams = {}, body } = {}) {
    let cap;
    let uri;
    let bytes = Buffer.alloc(0);
    try {
      cap = R.requireCapability(capabilityId);
      uri = R.buildUri(cap, { query, pathParams, now: nowMs() });
      if (cap.request_body) {
        if (!R.validateBody(cap, body).valid) throw new R.ContractError("REQUEST_BODY_INVALID");
        bytes = Buffer.from(JSON.stringify(body));
      } else if (body !== undefined) {
        throw new R.ContractError("REQUEST_BODY_NOT_ALLOWED");
      }
    } catch (err) {
      throw new BridgeError("REQUEST_REFUSED", { reason: err.reason || "REQUEST_OUTSIDE_PINNED_CONTRACT" });
    }
    if (!staff || !staff.sub || !staff.role || !staff.market || !staff.organization) throw new BridgeError("REQUEST_REFUSED", { reason: "STAFF_CONTEXT_REQUIRED" });
    if (R.needsZoneTenant(cap) && (staff.zone !== query.zone || staff.tenant !== query.tenant || staff.market !== query.market || staff.organization !== query.organization)) {
      throw new BridgeError("REQUEST_REFUSED", { reason: "STAFF_SCOPE_MUST_EQUAL_REQUEST_SCOPE" });
    }
    const mutating = cap.kind === "COMMAND" || cap.kind === "RETRIEVAL" || cap.kind === "SYNC" && cap.method !== "GET";
    const binary = cap.success_media && cap.success_media !== "application/json";
    count("requests_total");
    let res;
    try {
      res = await send({ method: cap.method, uri, body: bytes, staff, permissions: R.permissionsFor(cap), mutating, binary });
    } catch (err) {
      count(err.category === "UNKNOWN_OUTCOME" ? "unknown_outcomes_total" : "failures_total");
      throw err;
    }
    if (!res.isJson) {
      if (res.status !== cap.success_status) throw new BridgeError(mutating ? "UNKNOWN_OUTCOME" : "CONTRACT_MISMATCH", { status: res.status });
      count("success_total");
      return { capability: cap, binary: res.bytes, contentType: res.type, status: res.status };
    }
    let envelope;
    try { envelope = JSON.parse(res.bytes.toString("utf8")); } catch { envelope = null; }
    const envErrors = R.envelopeErrors(envelope);
    if (envErrors.length) {
      count("contract_mismatch_total");
      throw new BridgeError(mutating && res.status >= 200 && res.status < 300 ? "UNKNOWN_OUTCOME" : res.status >= 500 && !mutating ? "BRIDGE_UNAVAILABLE" : mutating ? "UNKNOWN_OUTCOME" : "CONTRACT_MISMATCH", { status: res.status, reason: "BRIDGE_ENVELOPE_INVALID" });
    }
    if (envelope.error || res.status !== cap.success_status) {
      const e = envelope.error && typeof envelope.error === "object" ? envelope.error : {};
      count("failures_total");
      throw fromResponse(res.status, typeof e.code === "string" ? e.code : null, { mutating, operationId: typeof e.operation_id === "string" ? e.operation_id : null });
    }
    const check = R.validateResult(cap, envelope.result);
    if (!check.valid) {
      count("contract_mismatch_total");
      throw new BridgeError(mutating ? "UNKNOWN_OUTCOME" : "CONTRACT_MISMATCH", { status: res.status, reason: "BRIDGE_RESULT_SCHEMA_MISMATCH" });
    }
    count("success_total");
    return { capability: cap, result: envelope.result, asOf: envelope.as_of, freshness: envelope.freshness, bridgeCorrelationId: envelope.correlation_id, status: res.status };
  }

  // Legacy metadata discovery (Sections 1-5): one fixed path, minimal checks.
  function capabilities(staff) {
    const uri = S.capabilitiesUri(bridge.market, bridge.organization);
    const headers = S.bridgeHeaders({
      serviceKey: bridge.serviceKey, serviceKid: bridge.serviceKid, privateKey: bridge.staffPrivateKey,
      staffKid: bridge.staffKid, issuer: bridge.issuer, audience: bridge.audience, staff, method: "GET", uri, now: now(),
    });
    headers.Host = hostHeader;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
      const req = https.request({ ...tlsOptions(bridge), path: uri, method: "GET", headers }, (res) => {
        if (res.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(String(res.headers["content-type"] || ""))) {
          res.resume();
          return finish(reject, new BridgeError("BRIDGE_UNAVAILABLE", { reason: "BRIDGE_UNAVAILABLE" }));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { res.destroy(); finish(reject, new BridgeError("RESPONSE_TOO_LARGE", { reason: "BRIDGE_RESPONSE_TOO_LARGE" })); return; }
          chunks.push(chunk);
        });
        res.on("error", () => finish(reject, new BridgeError("BRIDGE_UNAVAILABLE", { reason: "BRIDGE_UNAVAILABLE" })));
        res.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.product !== S.PRODUCT || payload.error) throw new Error();
            finish(resolve, payload);
          } catch {
            finish(reject, new BridgeError("CONTRACT_MISMATCH", { reason: "BRIDGE_RESPONSE_INVALID" }));
          }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("TIMEOUT")), timeoutMs);
      req.on("error", () => finish(reject, new BridgeError("BRIDGE_UNAVAILABLE", { reason: "BRIDGE_UNAVAILABLE" })));
      req.end();
    });
  }

  return Object.freeze({ call, capabilities, metrics });
}

module.exports = { createBridgeClient, BridgeError, MAX_RESPONSE_BYTES, fingerprintOf };
