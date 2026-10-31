"use strict";

// Product Admin Protocol v1.1 endpoint handlers for Karryam. These are
// Product Admin -> HQ endpoints, not aliases for Backoffice Bridge routes.
//
// Honesty rules: no endpoint claims data it does not have. Stage B events,
// snapshots and sync status come only from the durable derived outbox; a
// dataset the product has not certified, or a pipeline that is not running,
// answers UNAVAILABLE rather than an empty success. Commands go through the
// governed pipeline (operations/service.js); module reads and reports go
// through modules/reads.js and modules/reports.js.

const { contracts } = require("../packages");
const { bridgeContractSummary } = require("../bridge/contracts");
const R = require("../bridge/contracts/registry");
const { bridgeStaffContext, StaffContextError } = require("../bridge/capabilities");
const { capabilityMap, MODULES, collectionsOf, readExposure } = require("../modules/catalog");
const { REPORTS } = require("../modules/reports");
const { withinScope } = require("../operations/service");

const P = contracts.ProtocolError;
const validateAck = contracts.compile(contracts.schemas.SCHEMAS["events-ack.v1"]);
const validateSyncStatus = contracts.compile(contracts.schemas.SCHEMAS["sync-status.v1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRESH_MS = 3600 * 1000;

const EVENTS_QUERY = {
  dataset_id: { type: "id", required: true },
  partition_key: { type: "partition", required: true },
  after_sequence: { type: "int", min: 0, required: true },
  limit: { type: "int", min: 1, max: 100, default: 50 },
};
const SNAPSHOT_QUERY = {
  partition_key: { type: "partition" },
  limit: { type: "int", min: 1, max: 100, default: 50 },
  cursor: { type: "cursor", max: 512 },
};

function createHandlers({ config, catalog, manifest, bridgeClient, operations, operationsService, reads, reports, pipeline, audit, dbReady, logger = () => {}, now = Date.now }) {
  const productId = config.productId;
  const ok = (ctx, result, extra = {}) => ({ body: contracts.okEnvelope({ productId, correlationId: ctx.correlationId, result, ...extra }, now()) });
  const datasetIds = new Set(catalog.datasets.map((d) => d.dataset_id));
  const certified = new Set(config.certifiedDatasets || []);
  const requireKnownDataset = (id) => { if (!datasetIds.has(id)) throw new P("NOT_FOUND", "UNKNOWN_DATASET"); };
  const pipelineLive = () => Boolean(pipeline && config.feed && config.feed.enabled);
  const requireCertified = (id) => {
    requireKnownDataset(id);
    if (!certified.has(id)) throw new P("UNAVAILABLE", "DATASET_NOT_CERTIFIED");
    if (!pipelineLive()) throw new P("UNAVAILABLE", "EVENT_SOURCE_NOT_CERTIFIED");
  };

  async function bridgeLive(ctx) {
    if (!config.bridge.enabled || !bridgeClient) return { state: "BLOCKED_DEPENDENCY", reason: "BRIDGE_TRUST_NOT_ENROLLED" };
    if (!ctx.delegation || ctx.delegation.action !== "product.capabilities.read") return null;
    let staff;
    try {
      staff = bridgeStaffContext(ctx.delegation, config.bridge, Math.floor(now() / 1000));
    } catch (err) {
      return { state: "BLOCKED_POLICY", reason: err instanceof StaffContextError ? err.reason : "STAFF_CONTEXT_INVALID" };
    }
    try {
      const discovery = await bridgeClient.capabilities(staff);
      return { state: "READ_ONLY", observed_at: new Date(now()).toISOString(), discovery };
    } catch (err) {
      logger({ event: "bridge_unavailable", reason: err.reason || "BRIDGE_UNAVAILABLE", correlation_id: ctx.correlationId });
      return { state: "UNAVAILABLE", reason: "BRIDGE_UNAVAILABLE" };
    }
  }

  // Operation and audit reads need a staff delegation for operation.read and
  // return only operations that staff member requested. Unknown and foreign
  // operations answer identically, so existence is not disclosed.
  async function ownOperation(ctx) {
    if (!ctx.delegation || ctx.delegation.action !== "operation.read") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
    const id = ctx.params.operationId;
    const operation = UUID.test(id) ? await operations.get(id) : null;
    if (!operation || operation.staff_ref !== ctx.delegation.sub) throw new P("NOT_FOUND", "OPERATION_NOT_FOUND");
    return operation;
  }

  function modulesSummary() {
    return MODULES.map((m) => {
      const collections = collectionsOf(m);
      const exposures = collections.map((c) => readExposure(c, config).state);
      const inventory = R.capabilitiesFor(m.id);
      return {
        module: m.id, title: m.title, read_capability_id: m.read, rules: m.rules,
        inventory_capabilities: inventory.length,
        collections: collections.map((c, i) => ({ collection_id: c.id, detail: c.path_params.length > 0, exposure_state: exposures[i], privacy: c.privacy, risk: c.risk })),
        commands: inventory.filter((c) => c.kind === "COMMAND" || c.kind === "RETRIEVAL").map((c) => "karryam." + c.id),
      };
    });
  }

  return {
    async healthLive() {
      return { status: 200, body: { status: "live", service: "karryam-admin" } };
    },

    async healthReady() {
      const database = (await dbReady()) ? "OK" : "UNAVAILABLE";
      return {
        status: database === "OK" ? 200 : 503,
        body: {
          status: database === "OK" ? "CONFIGURED" : "NOT_READY",
          service: "karryam-admin",
          database,
          manifest_signer: manifest.signerProvisioned ? "PROVISIONED" : "NOT_PROVISIONED",
          bridge: config.bridge.enabled ? "CONFIGURED_NOT_CERTIFIED" : "DISABLED",
          bridge_feed: config.feed && config.feed.enabled ? "CONFIGURED_NOT_CERTIFIED" : "DISABLED",
          upstream_certified: false,
        },
      };
    },

    async manifest(ctx) {
      return ok(ctx, manifest.current());
    },

    async capabilities(ctx) {
      return ok(ctx, {
        capabilities: catalog.capabilities,
        bridge_contract: { ...bridgeContractSummary(), registry: R.summary() },
        bridge_live: await bridgeLive(ctx),
        modules: modulesSummary(),
        reports: REPORTS.map((r) => ({ report_id: "karryam.report." + r.id, kind: r.kind, grain: r.grain, units: r.units, definition: r.definition })),
        capability_map: capabilityMap(config),
      });
    },

    async datasets(ctx) {
      return ok(ctx, { datasets: catalog.datasets });
    },

    async datasetSnapshots(ctx) {
      const query = contracts.parseQuery(ctx.query, SNAPSHOT_QUERY);
      requireCertified(ctx.params.datasetId);
      if (!query.partition_key) throw new P("INVALID_REQUEST", "PARTITION_KEY_REQUIRED");
      const snap = await pipeline.snapshot(ctx.params.datasetId, query.partition_key);
      if (!snap.partition) throw new P("NOT_FOUND", "UNKNOWN_PARTITION");
      if (snap.rows.length === 0) throw new P("UNAVAILABLE", "NO_SOURCE_OBSERVATION", { retryable: true });
      const p = snap.partition;
      const records = snap.rows.map((r) => ({
        entity: { type: "metric_observation", id: r.metric_id + ":" + r.window_start.toISOString().slice(0, 10), version: Number(r.entity_version) },
        scope: { market: p.market, organization: p.organization, zone: p.zone, tenant: p.tenant },
        payload: {
          metric_id: r.metric_id, definition_version: "1.0.0", window_start: r.window_start.toISOString(), window_end: r.window_end.toISOString(),
          value: r.value === null ? null : Number(r.value), value_state: r.value_state, unit: "count", currency: null, coverage: r.coverage,
          observed_at: r.observed_at ? r.observed_at.toISOString() : null,
        },
      }));
      const observed = snap.rows.map((r) => r.updated_at).sort((a, b) => a - b)[0];
      return ok(ctx, {
        snapshot_id: "snap-" + ctx.correlationId.slice(0, 32).replace(/[^A-Za-z0-9._:-]/g, ""), dataset_id: ctx.params.datasetId, dataset_version: "1.0.0",
        partitions: [{ partition_key: query.partition_key, through_sequence: snap.headSequence }], records, complete: snap.complete,
      }, { asOf: observed.toISOString(), freshness: now() - observed.getTime() <= FRESH_MS ? "FRESH" : "STALE", coverage: snap.complete ? "COMPLETE" : "PARTIAL" });
    },

    async events(ctx) {
      const query = contracts.parseQuery(ctx.query, EVENTS_QUERY);
      requireCertified(query.dataset_id);
      const page = await pipeline.outboxEvents(query.dataset_id, query.partition_key, query.after_sequence, query.limit);
      return ok(ctx, { dataset_id: query.dataset_id, partition_key: query.partition_key, events: page.events, head_sequence: page.headSequence });
    },

    async eventsAck(ctx) {
      if (!ctx.body || !validateAck(ctx.body).valid) throw new P("INVALID_REQUEST", "ACK_INVALID");
      requireCertified(ctx.body.dataset_id);
      const outcome = await pipeline.outboxAck(ctx.service.serviceId, ctx.body.dataset_id, ctx.body.partition_key, ctx.body.sequence);
      if (outcome === "UNKNOWN_PARTITION") throw new P("NOT_FOUND", "UNKNOWN_PARTITION");
      if (outcome === "BEYOND_HEAD") throw new P("CONFLICT", "ACK_BEYOND_HEAD");
      if (outcome === "REGRESSION") throw new P("CONFLICT", "ACK_REGRESSION");
      return ok(ctx, { dataset_id: ctx.body.dataset_id, partition_key: ctx.body.partition_key, acknowledged_sequence: ctx.body.sequence });
    },

    async syncStatus(ctx) {
      const live = pipelineLive() && certified.size > 0;
      let partitions = [];
      let lastObservation = null;
      let partial = false;
      if (pipelineLive()) {
        partitions = (await pipeline.outboxPartitions()).filter((p) => certified.has(p.dataset_id));
        const summary = await pipeline.pipelineSummary();
        const times = summary.partitions.map((p) => p.last_success_at).filter(Boolean).sort((a, b) => b - a);
        lastObservation = times.length ? times[0].toISOString() : null;
        partial = summary.partitions.some((p) => p.hold_sequence !== null || p.open_gaps > 0 || p.open_quarantine > 0);
      }
      const result = {
        event_source: live ? "CERTIFIED" : "NOT_CERTIFIED",
        partitions,
        datasets: catalog.datasets.map((d) => ({ dataset_id: d.dataset_id, readiness: d.readiness, blockers: d.blockers })),
        last_source_observation: lastObservation,
      };
      if (!validateSyncStatus(result).valid) throw new P("INTERNAL", "SYNC_STATUS_INVALID");
      return ok(ctx, result, lastObservation
        ? { asOf: lastObservation, freshness: now() - Date.parse(lastObservation) <= FRESH_MS ? "FRESH" : "STALE", coverage: partial ? "PARTIAL" : "COMPLETE" }
        : { freshness: "UNKNOWN", coverage: live ? "UNKNOWN" : "NONE" });
    },

    async operationGet(ctx) {
      const operation = await ownOperation(ctx);
      const { operation: current, readback } = await operationsService.readback(ctx, operation);
      return ok(ctx, { ...operationsService.view(current), readback });
    },

    async operationSubmit(ctx) {
      return operationsService.submit(ctx);
    },

    async auditGet(ctx) {
      const operation = await ownOperation(ctx);
      const rows = await audit.listForOperation(operation.operation_id);
      if (rows.length === 0) throw new P("NOT_FOUND", "OPERATION_NOT_FOUND");
      return ok(ctx, { operation_id: operation.operation_id, records: rows });
    },

    resourceList: (ctx) => reads.list(ctx),
    resourceGet: (ctx) => reads.get(ctx),
    reportGet: (ctx) => reports.get(ctx),
  };
}

module.exports = { createHandlers, EVENTS_QUERY, withinScope };
