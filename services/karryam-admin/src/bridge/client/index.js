"use strict";

// Read-only Karryam Backoffice Bridge client. Fixed destination (pinned
// private IP, TLS server name from the configured origin, no DNS), TLS 1.3
// mutual TLS, HMAC v2 + Ed25519 staff assertion, one fixed path, bounded
// response, no redirects. Any failure is reported as unavailable; nothing
// is retried and no data is fabricated.

const https = require("node:https");
const S = require("./signing");

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;

class BridgeError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BridgeError";
    this.reason = reason;
  }
}

function createBridgeClient(bridge, { now = () => Math.floor(Date.now() / 1000), timeoutMs = TIMEOUT_MS } = {}) {
  if (!bridge || !bridge.enabled) throw new BridgeError("BRIDGE_DISABLED");

  // staff: { sub, sessionId, authTime, acr, role, market, organization }
  function capabilities(staff) {
    const uri = S.capabilitiesUri(bridge.market, bridge.organization);
    const headers = S.bridgeHeaders({
      serviceKey: bridge.serviceKey, serviceKid: bridge.serviceKid, privateKey: bridge.staffPrivateKey,
      staffKid: bridge.staffKid, issuer: bridge.issuer, audience: bridge.audience, staff, method: "GET", uri, now: now(),
    });
    headers.Host = bridge.port === 443 ? bridge.hostname : bridge.hostname + ":" + bridge.port;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
      const req = https.request({
        host: bridge.address, port: bridge.port, servername: bridge.hostname, path: uri, method: "GET", headers,
        cert: bridge.clientCert, key: bridge.clientKey, ca: bridge.serverCa,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true, agent: false,
      }, (res) => {
        if (res.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(String(res.headers["content-type"] || ""))) {
          res.resume();
          return finish(reject, new BridgeError("BRIDGE_UNAVAILABLE"));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { res.destroy(); finish(reject, new BridgeError("BRIDGE_RESPONSE_TOO_LARGE")); return; }
          chunks.push(chunk);
        });
        res.on("error", () => finish(reject, new BridgeError("BRIDGE_UNAVAILABLE")));
        res.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.product !== S.PRODUCT || payload.error) throw new Error();
            finish(resolve, payload);
          } catch {
            finish(reject, new BridgeError("BRIDGE_RESPONSE_INVALID"));
          }
        });
      });
      const timer = setTimeout(() => req.destroy(new BridgeError("BRIDGE_TIMEOUT")), timeoutMs);
      req.on("error", () => finish(reject, new BridgeError("BRIDGE_UNAVAILABLE")));
      req.end();
    });
  }

  return Object.freeze({ capabilities });
}

module.exports = { createBridgeClient, BridgeError, MAX_RESPONSE_BYTES };
