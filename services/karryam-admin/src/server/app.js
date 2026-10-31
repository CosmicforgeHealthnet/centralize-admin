"use strict";

// Request handler assembly. Disabled (default): health only, and every
// protocol path answers an honest INTEGRATION_DISABLED envelope with no
// authentication surface and no data. Enabled: the shared Product Admin
// protocol kit (service auth, delegation, audit-before-execute, envelope
// validation) with Karryam handlers.

const { randomUUID } = require("node:crypto");
const { contracts, clients } = require("../packages");
const { buildCatalog } = require("../protocol/catalog");
const { createManifestProvider } = require("../protocol/manifest");
const { createHandlers } = require("../protocol/handlers");
const { createBridgeClient } = require("../bridge/client");
const { createContinuation } = require("../modules/continuation");
const { createReads } = require("../modules/reads");
const { createReports } = require("../modules/reports");
const { createOperations } = require("../operations/service");
const { memoryAccessLog } = require("../db/access-log");
const { memoryApprovals } = require("../db/approvals");

function disabledHandler({ logger = () => {} } = {}) {
  return function handler(req, res) {
    const requestId = randomUUID();
    const pathname = String(req.url || "").split("?")[0];
    const send = (status, body) => {
      res.writeHead(status, { ...clients.SECURITY_HEADERS, "X-Request-Id": requestId });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && (pathname === "/health/live" || pathname === contracts.BASE_PATH + "/health/live")) {
      return send(200, { status: "live", service: "karryam-admin" });
    }
    if (req.method === "GET" && (pathname === "/health/ready" || pathname === contracts.BASE_PATH + "/health/ready")) {
      return send(503, { status: "DISABLED", service: "karryam-admin", upstream_certified: false });
    }
    if (pathname === contracts.BASE_PATH || pathname.startsWith(contracts.BASE_PATH + "/")) {
      logger({ event: "request_refused_disabled", correlation_id: requestId });
      return send(503, contracts.errorEnvelope({ productId: "karryam", correlationId: requestId, code: "UNAVAILABLE", reason: "INTEGRATION_DISABLED", retryable: false }));
    }
    return send(404, contracts.errorEnvelope({ productId: "karryam", correlationId: requestId, code: "NOT_FOUND", reason: "UNKNOWN_ENDPOINT" }));
  };
}

/**
 * deps: { nonceStore, audit, operations, approvals, accessLog, pipeline, dbReady, bridgeClient?, logger, now }
 */
function createApp(config, deps) {
  if (!config.enabled) return disabledHandler(deps);
  const now = deps.now || Date.now;
  const catalog = buildCatalog(config);
  const manifest = createManifestProvider({ config, catalog, now });
  const bridgeMetrics = deps.bridgeMetrics || {};
  const bridgeClient = deps.bridgeClient !== undefined ? deps.bridgeClient : (config.bridge.enabled ? createBridgeClient(config.bridge, { metrics: bridgeMetrics }) : null);
  const continuation = config.cursorKey ? createContinuation(config.cursorKey, { now }) : null;
  const accessLog = deps.accessLog || memoryAccessLog();
  const approvals = deps.approvals || memoryApprovals({ now });
  const reads = createReads({ config, bridgeClient, continuation, audit: deps.audit, accessLog, now, logger: deps.logger });
  const reports = createReports({ config, bridgeClient, store: deps.pipeline || null, audit: deps.audit, bridgeMetrics, now });
  const operationsService = createOperations({ config, catalog, operations: deps.operations, approvals, bridgeClient, now, logger: deps.logger });
  const handlers = createHandlers({ config, catalog, manifest, bridgeClient, operations: deps.operations, operationsService, reads, reports, pipeline: deps.pipeline || null, audit: deps.audit, dbReady: deps.dbReady, logger: deps.logger, now });
  return clients.createProductAdminHandler({
    productId: config.productId,
    serviceInstanceId: config.serviceInstanceId,
    serviceKeys: config.serviceKeys,
    allowedServices: config.allowedServices,
    nonceStore: deps.nonceStore,
    delegationKeys: config.delegationKeys,
    delegationIssuer: "product-integration-core",
    handlers,
    audit: (record) => deps.audit.record(record),
    logger: deps.logger,
    now,
  });
}

module.exports = { createApp, disabledHandler };
