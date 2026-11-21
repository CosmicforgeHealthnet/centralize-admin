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
const { createKarryamMetrics } = require("../observability/metrics");
const { createSyncStatus } = require("../observability/sync-status");

// Private operator routes on this service's own listener (Unix socket 0660 /
// mTLS): Prometheus metrics and sanitized sync status. Never proxied by HQ.
function withObservability(handler, { observability, syncStatus, enabled }) {
  return async function observed(req, res) {
    const pathname = String(req.url || "").split("?")[0];
    if (pathname !== "/metrics" && pathname !== "/sync/status") return handler(req, res);
    const headers = { ...clients.SECURITY_HEADERS, "X-Request-Id": randomUUID() };
    if (req.method !== "GET") { res.writeHead(405, headers); return res.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" })); }
    if (pathname === "/metrics") {
      let text;
      try { text = await observability.render(); } catch { res.writeHead(500, headers); return res.end(JSON.stringify({ error: "METRICS_UNAVAILABLE" })); }
      res.writeHead(200, { ...headers, "Content-Type": clients.METRICS_CONTENT_TYPE });
      return res.end(text);
    }
    if (!enabled || !syncStatus) { res.writeHead(503, headers); return res.end(JSON.stringify({ status: "DISABLED", service: "karryam-admin" })); }
    try {
      const body = await syncStatus();
      res.writeHead(200, headers);
      return res.end(JSON.stringify(body));
    } catch {
      res.writeHead(503, headers);
      return res.end(JSON.stringify({ status: "UNAVAILABLE", service: "karryam-admin", reason: "SYNC_STATUS_UNAVAILABLE" }));
    }
  };
}

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
 * deps: { nonceStore, audit, operations, approvals, accessLog, pipeline, governance?, dbReady, bridgeClient?, logger, now }
 */
function createApp(config, deps) {
  const observability = deps.observability || createKarryamMetrics({ config, pool: deps.pool || null });
  if (!config.enabled) return withObservability(disabledHandler(deps), { observability, enabled: false });
  const now = deps.now || Date.now;
  const catalog = buildCatalog(config);
  const manifest = createManifestProvider({ config, catalog, now });
  const bridgeMetrics = deps.bridgeMetrics || {};
  const bridgeClient = deps.bridgeClient !== undefined ? deps.bridgeClient : (config.bridge.enabled ? createBridgeClient(config.bridge, { metrics: bridgeMetrics, observe: observability.observeBridge }) : null);
  const continuation = config.cursorKey ? createContinuation(config.cursorKey, { now }) : null;
  const accessLog = deps.accessLog || memoryAccessLog();
  const approvals = deps.approvals || memoryApprovals({ now });
  const reads = createReads({ config, bridgeClient, continuation, audit: deps.audit, accessLog, now, logger: deps.logger });
  const reports = createReports({ config, bridgeClient, store: deps.pipeline || null, audit: deps.audit, bridgeMetrics, now });
  const operationsService = createOperations({ config, catalog, operations: deps.operations, approvals, bridgeClient, certifications: deps.certifications || null, governance: deps.governance || null, now, logger: deps.logger, signal: observability.signal });
  const syncStatus = createSyncStatus({ config, store: deps.pipeline || null, lastBridgeOutcome: observability.lastBridgeOutcome, now });
  const handlers = createHandlers({ config, catalog, manifest, bridgeClient, operations: deps.operations, operationsService, reads, reports, pipeline: deps.pipeline || null, audit: deps.audit, governance: deps.governance || null, dbReady: deps.dbReady, readinessDetail: syncStatus.readiness, logger: deps.logger, now });
  return withObservability(clients.createProductAdminHandler({
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
    observe: observability.observeRequest,
    now,
  }), { observability, syncStatus: syncStatus.full, enabled: true });
}

module.exports = { createApp, disabledHandler };
