"use strict";

// Product Admin Protocol v1 endpoint handlers for Karryam. These are
// Product Admin -> HQ endpoints, not aliases for Backoffice Bridge routes.
//
// Honesty rules: no endpoint claims data it does not have. Event and
// snapshot sources are not certified, so they answer UNAVAILABLE rather than
// an empty (fabricated) success. Operation submissions are durably recorded
// as REJECTED and never executed.

const { contracts } = require("../packages");
const { findCapability } = require("./catalog");
const { bridgeContractSummary } = require("../bridge/contracts");
const { bridgeStaffContext, StaffContextError } = require("../bridge/capabilities");

const P = contracts.ProtocolError;
const validateAck = contracts.compile(contracts.schemas.SCHEMAS["events-ack.v1"]);
const validateCommand = contracts.compile(contracts.schemas.SCHEMAS["operation-command.v1"]);
const validateSyncStatus = contracts.compile(contracts.schemas.SCHEMAS["sync-status.v1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function createHandlers({ config, catalog, manifest, bridgeClient, operations, audit, dbReady, logger = () => {}, now = Date.now }) {
  const productId = config.productId;
  const ok = (ctx, result, extra = {}) => ({ body: contracts.okEnvelope({ productId, correlationId: ctx.correlationId, result, ...extra }, now()) });
  const datasetIds = new Set(catalog.datasets.map((d) => d.dataset_id));
  const requireKnownDataset = (id) => { if (!datasetIds.has(id)) throw new P("NOT_FOUND", "UNKNOWN_DATASET"); };

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
        bridge_contract: bridgeContractSummary(),
        bridge_live: await bridgeLive(ctx),
      });
    },

    async datasets(ctx) {
      return ok(ctx, { datasets: catalog.datasets });
    },

    async datasetSnapshots(ctx) {
      contracts.parseQuery(ctx.query, SNAPSHOT_QUERY);
      requireKnownDataset(ctx.params.datasetId);
      throw new P("UNAVAILABLE", "SOURCE_NOT_CERTIFIED");
    },

    async events(ctx) {
      const query = contracts.parseQuery(ctx.query, EVENTS_QUERY);
      requireKnownDataset(query.dataset_id);
      throw new P("UNAVAILABLE", "EVENT_SOURCE_NOT_CERTIFIED");
    },

    async eventsAck(ctx) {
      if (!ctx.body || !validateAck(ctx.body).valid) throw new P("INVALID_REQUEST", "ACK_INVALID");
      requireKnownDataset(ctx.body.dataset_id);
      throw new P("UNAVAILABLE", "EVENT_SOURCE_NOT_CERTIFIED");
    },

    async syncStatus(ctx) {
      const result = {
        event_source: "NOT_CERTIFIED",
        partitions: [],
        datasets: catalog.datasets.map((d) => ({ dataset_id: d.dataset_id, readiness: d.readiness, blockers: d.blockers })),
        last_source_observation: null,
      };
      if (!validateSyncStatus(result).valid) throw new P("INTERNAL", "SYNC_STATUS_INVALID");
      return ok(ctx, result, { freshness: "UNKNOWN", coverage: "NONE" });
    },

    async operationGet(ctx) {
      const id = ctx.params.operationId;
      const operation = UUID.test(id) ? await operations.get(id) : null;
      if (!operation) throw new P("NOT_FOUND", "OPERATION_NOT_FOUND");
      return ok(ctx, {
        operation_id: operation.operation_id,
        capability_id: operation.capability_id,
        status: operation.status,
        reason_code: operation.reason_code,
        created_at: operation.created_at,
        executed: false,
      });
    },

    async operationSubmit(ctx) {
      if (!ctx.body || !validateCommand(ctx.body).valid) throw new P("INVALID_REQUEST", "COMMAND_INVALID");
      if (!ctx.delegation || ctx.delegation.action !== "operation.submit") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
      const command = ctx.body;
      const cap = findCapability(catalog, command.capability_id);
      if (!cap) throw new P("NOT_FOUND", "UNKNOWN_CAPABILITY");
      if (cap.kind !== "COMMAND") throw new P("INVALID_REQUEST", "CAPABILITY_NOT_COMMAND");
      // There is no executor in this service: every command is rejected.
      const code = cap.state === "BLOCKED_POLICY" ? "BLOCKED_POLICY" : "DISABLED";
      const reasonCode = cap.state === "BLOCKED_POLICY" ? "CAPABILITY_BLOCKED_POLICY" : cap.state === "DISABLED" ? "CAPABILITY_DISABLED" : "COMMAND_EXECUTION_NOT_IMPLEMENTED";
      const outcome = await operations.recordRejection({
        id: command.command_id,
        serviceId: ctx.service.serviceId,
        idempotencyKey: command.idempotency_key,
        requestDigest: contracts.digestOf(command),
        capabilityId: cap.id,
        staffRef: ctx.delegation.sub,
        reasonCode,
      }, {
        correlation_id: ctx.correlationId, request_id: ctx.requestId, endpoint: "operationSubmit", method: "POST",
        service_id: ctx.service.serviceId, staff_ref: ctx.delegation.sub, action: "operation.submit",
        outcome: "OPERATION_REJECTED", reason_code: reasonCode, metadata: { capability_id: cap.id, risk: cap.risk },
      });
      if (outcome.kind === "KEY_CONFLICT") throw new P("CONFLICT", "IDEMPOTENCY_KEY_REUSED");
      if (outcome.kind === "COMMAND_CONFLICT") throw new P("CONFLICT", "COMMAND_ID_REUSED");
      const prior = outcome.operation;
      const priorCode = prior.reason_code === "CAPABILITY_BLOCKED_POLICY" ? "BLOCKED_POLICY" : code;
      throw new P(priorCode, prior.reason_code, { operationId: prior.operation_id, retryable: false });
    },

    async auditGet(ctx) {
      const id = ctx.params.operationId;
      const rows = UUID.test(id) ? await audit.listForOperation(id) : [];
      if (rows.length === 0) throw new P("NOT_FOUND", "OPERATION_NOT_FOUND");
      return ok(ctx, { operation_id: id, records: rows });
    },
  };
}

module.exports = { createHandlers, EVENTS_QUERY };
