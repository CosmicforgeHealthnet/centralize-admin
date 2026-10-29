"use strict";
const http = require("node:http");
const fs = require("node:fs");
const { loadConfig } = require("./config");
const { verifyDelegation } = require("./protocol");
const { capabilities } = require("./bridge-client");

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function createHandler(config, fetchCapabilities = capabilities) {
  return async (req, res) => {
    if (req.method === "GET" && req.url === "/health/live") return json(res, 200, { service: "karryam-admin", status: "live" });
    if (req.method === "GET" && req.url === "/health/ready") return json(res, config.enabled ? 200 : 503, { service: "karryam-admin", configured: config.enabled, upstream_certified: false });
    if (req.method !== "GET" || req.url !== "/v1/capabilities") return json(res, 404, { error: "not_found" });
    if (!config.enabled) return json(res, 503, { error: "integration_disabled" });
    // Duplicate delegation headers are always ambiguous and therefore denied.
    const delegated = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "x-cf-hq-delegation");
    if (delegated.length !== 1) return json(res, 403, { error: "delegation_denied" });
    let actor;
    try {
      actor = verifyDelegation(req.headers["x-cf-hq-delegation"], config.delegationSecret, config);
      if (!Object.prototype.hasOwnProperty.call(config.roles, actor.role)) throw new Error("role_not_approved");
    } catch {
      return json(res, 403, { error: "delegation_denied" });
    }
    try {
      const result = await fetchCapabilities(config, actor);
      return json(res, 200, result);
    } catch {
      return json(res, 503, { error: "bridge_unavailable" });
    }
  };
}
function start(env = process.env) {
  const config = loadConfig(env);
  const path = config.enabled ? config.socketPath : env.KARRYAM_ADMIN_SOCKET_PATH;
  if (!path || !path.startsWith("/") || path.includes("..")) throw new Error("private unix socket is required");
  const server = http.createServer(createHandler(config));
  server.requestTimeout = 6000;
  server.headersTimeout = 5000;
  server.listen(path, () => {
    fs.chmodSync(path, 0o660);
    console.info(JSON.stringify({ service: "karryam-admin", status: "listening_private_socket", enabled: config.enabled }));
  });
  const shutdown = () => server.close(() => {
    try { fs.unlinkSync(path); } catch {}
    process.exit(0);
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}
if (require.main === module) start();
module.exports = { createHandler, start };
