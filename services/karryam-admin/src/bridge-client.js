"use strict";
const https = require("node:https");
const { URL } = require("node:url");
const { bridgeHeaders } = require("./protocol");

function bridgeOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("invalid_bridge_origin");
  }
  return origin;
}
async function capabilities(config, delegation) {
  const origin = bridgeOrigin(config.bridgeOrigin);
  const uri = "/internal/karryam-admin/v1/capabilities?market=" +
    encodeURIComponent(config.market) + "&organization=" + encodeURIComponent(config.organization) +
    "&purpose=admin_ui_capabilities";
  const headers = bridgeHeaders({
    serviceKey: config.serviceKey, serviceKid: config.serviceKid, privateKey: config.staffPrivateKey,
    staffKid: config.staffKid, issuer: config.issuer, audience: config.audience,
    role: config.roles[delegation.role], delegation, method: "GET", uri
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: "https:", hostname: origin.hostname, port: origin.port || 443,
      servername: origin.hostname, path: uri, method: "GET", headers,
      cert: config.clientCert, key: config.clientKey, ca: config.serverCa,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
      timeout: 4000, agent: false
    }, (res) => {
      if (res.statusCode !== 200 || /(?:^|,)\s*text\/html/i.test(String(res.headers["content-type"] || ""))) {
        res.resume(); reject(new Error("bridge_unavailable")); return;
      }
      let size = 0, chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 262144) { req.destroy(new Error("bridge_response_too_large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!payload || typeof payload !== "object" || payload.product !== "karryam" || payload.error) throw new Error("invalid_bridge_response");
          resolve(payload);
        } catch { reject(new Error("invalid_bridge_response")); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("bridge_timeout")));
    req.on("error", reject);
    req.end();
  });
}
module.exports = { bridgeOrigin, capabilities };
