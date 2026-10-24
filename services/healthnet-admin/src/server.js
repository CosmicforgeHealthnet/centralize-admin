"use strict";

const http = require("node:http");
const { createHandler } = require("./app");
const { loadConfig } = require("./config");

function start() {
  const config = loadConfig(process.env);
  const host = process.env.HOST || "127.0.0.1";
  const server = http.createServer(createHandler());
  server.requestTimeout = 12000;
  server.headersTimeout = 10000;
  server.listen(config.port, host, () => {
    console.info(JSON.stringify({ service: "healthnet-admin", event: "listening", port: config.port, configured: config.ready }));
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
if (require.main === module) start();
module.exports = { start };
