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
const { pgApprovals } = require("../db/approvals");
const { pgAccessLog } = require("../db/access-log");
const { createPipelineStore } = require("../sync/store");
const { createGovernanceStore } = require("../db/governance");
const { pgCertifications } = require("../db/certifications");
const { contractRevision } = require("../sync/bridge-consumer");

async function start(env = process.env, { logger = createLogger() } = {}) {
  let config = loadConfig(env);
  let pool = null;
  let deps = { logger };
  if (config.enabled) {
    pool = createPool(config.databaseUrl);
    // High-risk exposure is evaluated at startup from certifications in force
    // (fail closed: none when the store cannot be read); every submission
    // re-checks the certification, so a revocation takes effect immediately.
    const certifications = pgCertifications(pool);
    const listed = config.enabledCommands.filter((id) => { const c = require("../bridge/contracts/registry").capability(id.slice("karryam.".length)); return c && (c.risk === "R3" || c.risk === "R4"); });
    const highRiskCertified = listed.length ? await certifications.activeIds(contractRevision()).catch(() => []) : [];
    config = Object.freeze({ ...config, highRiskCertified: Object.freeze(listed.filter((id) => highRiskCertified.includes(id))) });
    const audit = pgAudit(pool);
    deps = {
      logger, audit, nonceStore: pgNonceStore(pool), operations: pgOperations(pool), approvals: pgApprovals(pool), accessLog: pgAccessLog(pool),
      pipeline: createPipelineStore(pool, { serviceInstanceId: config.serviceInstanceId }), governance: createGovernanceStore(pool), certifications, dbReady: () => ping(pool),
    };
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
