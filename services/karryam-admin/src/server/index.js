"use strict";

// Independent Karryam Admin runtime. Startup is fail-closed: invalid or
// missing configuration exits non-zero with a sanitized reason code and no
// listener is opened.

const fs = require("node:fs");
const { loadConfig, describeConfig } = require("../config");
const { createLogger } = require("../logger");
const { createApp } = require("./app");
const { createServer, listen } = require("../transport/listener");
const { createPool, ping } = require("../db/pool");
const { pgNonceStore } = require("../security/nonce-store");
const { pgAudit } = require("../audit");
const { pgOperations } = require("../db/operations");

async function start(env = process.env, { logger = createLogger() } = {}) {
  const config = loadConfig(env);
  let pool = null;
  let deps = { logger };
  if (config.enabled) {
    pool = createPool(config.databaseUrl);
    const audit = pgAudit(pool);
    deps = { logger, audit, nonceStore: pgNonceStore(pool), operations: pgOperations(pool), dbReady: () => ping(pool) };
  }
  const server = createServer(createApp(config, deps), config);
  await listen(server, config.listen);
  logger({ event: "listening", ...describeConfig(config) });

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    logger({ event: "shutdown", signal });
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    await new Promise((resolve) => { server.close(() => resolve()); server.closeIdleConnections?.(); });
    if (pool) await pool.end().catch(() => {});
    if (config.listen.kind === "unix") { try { fs.unlinkSync(config.listen.path); } catch { /* already gone */ } }
    clearTimeout(force);
  }
  return { server, config, stop };
}

if (require.main === module) {
  const logger = createLogger();
  start(process.env, { logger }).then(({ stop }) => {
    process.once("SIGTERM", () => stop("SIGTERM").then(() => process.exit(0)));
    process.once("SIGINT", () => stop("SIGINT").then(() => process.exit(0)));
  }).catch((err) => {
    logger({ event: "startup_failed", reason: err && err.reason ? err.reason : (err && err.code) || "STARTUP_FAILED" });
    process.exit(1);
  });
}

module.exports = { start };
