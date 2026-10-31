"use strict";

// Product Integration Core process: private listener, internal API, optional
// scheduled synchronization and health/drift checks, graceful shutdown.

const fs = require("node:fs");
const http = require("node:http");
const { Pool } = require("pg");
const { loadConfig } = require("../config");
const { createApp } = require("../api/app");
const { createNonceStore } = require("../db");
const { createSyncEngine } = require("../sync/engine");
const { createHealthChecker } = require("../registry/health");

const log = (entry) => process.stdout.write(JSON.stringify({ service: "product-integration-core", at: new Date().toISOString(), ...entry }) + "\n");

function start(env = process.env) {
  const config = loadConfig(env);
  let pool = null;
  let syncEngine = null;
  let timer = null;
  let running = false;
  let handler;

  if (config.enabled) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, application_name: "product-integration-core" });
    pool.on("error", () => log({ event: "database_pool_error" }));
    syncEngine = createSyncEngine({ pool, endpoints: config.endpoints, environment: config.environment, trustStore: config.trustStore, workerId: config.sync.workerId || undefined, leaseSeconds: config.sync.leaseSeconds, logger: log });
    handler = createApp({ pool, endpoints: config.endpoints, trustStore: config.trustStore, hqDelegationKeys: config.hqDelegationKeys, environment: config.environment, nonceStore: createNonceStore(pool), logger: log, syncEngine });
    if (config.sync.enabled) {
      const health = createHealthChecker({ pool, endpoints: config.endpoints, trustStore: config.trustStore });
      timer = setInterval(async () => {
        if (running) return;
        running = true;
        try { await health.checkAll(); await syncEngine.tick({ scheduled: true }); } catch (err) { log({ event: "sync_tick_failed", error: err && err.name }); } finally { running = false; }
      }, config.sync.intervalSeconds * 1000);
    }
  } else {
    handler = createApp({ enabled: false, pool: null, endpoints: new Map(), trustStore: {}, hqDelegationKeys: {}, environment: "disabled", nonceStore: null, logger: log });
  }

  const server = http.createServer(handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  if (config.listen.kind === "unix") {
    try { fs.unlinkSync(config.listen.path); } catch {}
    server.listen(config.listen.path, () => {
      fs.chmodSync(config.listen.path, 0o660);
      log({ event: "listening", transport: "unix", enabled: config.enabled, sync: Boolean(config.sync && config.sync.enabled) });
    });
  } else {
    server.listen(config.listen.port, config.listen.host, () => log({ event: "listening", transport: "tcp-loopback", enabled: config.enabled }));
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    server.close(async () => {
      if (pool) await pool.end().catch(() => {});
      if (config.listen.kind === "unix") { try { fs.unlinkSync(config.listen.path); } catch {} }
      log({ event: "stopped" });
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (require.main === module) {
  try { start(); } catch (err) {
    log({ event: "startup_refused", reason: err.reason || "CONFIGURATION_INVALID" });
    process.exit(1);
  }
}

module.exports = { start };
