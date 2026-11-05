"use strict";

// Synthetic third Product Admin — TEST-ONLY. Distinct from Karryam and
// HealthNet; implements Universal Product Admin Protocol v1 using the same
// shared server kit every real Product Admin uses. It exists to prove that
// HQ onboards and synchronizes a new product with zero product-specific code.

const http = require("node:http");
const { once } = require("node:events");
const { randomUUID, randomBytes } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");
const T = require("../../../../packages/admin-contracts/src/testing");
const E = require("../../../../packages/event-contracts");
const S = require("../../../../packages/service-clients");

const PRODUCT_ID = "synthetic-third";
const INSTANCE_ID = "synthetic-third-test-1";
const DATASET_ID = "synthetic.daily_activity";
const FAMILY = "synthetic.metric_observation";
// A second, non-metric standard event family: stored and sequenced by HQ but
// never projected (projection NONE). Proves generic events, not only metrics.
const STATUS_FAMILY = "synthetic.order_status_changed";
const { standardMetricObservationFamily } = require("../../../../packages/admin-contracts/src/catalog");
const statusFamily = () => ({
  family: STATUS_FAMILY, schema_id: "synthetic.order-status", schema_version: "1.0.0", dataset_id: DATASET_ID,
  classification: "INTERNAL", projection: "NONE",
  payload_schema: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["CREATED", "COMPLETED", "CANCELLED"] } } },
  status: "ACTIVE", sunset_at: null, version_policy: "MAJOR_FOR_BREAKING",
});

async function startSyntheticProductAdmin({ environment = "test" } = {}) {
  const signer = T.generateSigner("synthetic-signer-1");
  const serviceKey = randomBytes(32);
  const delegationKey = randomBytes(32);
  let manifestOptions = { productId: PRODUCT_ID, serviceInstanceId: INSTANCE_ID, environment, ttlMs: 6 * 3600 * 1000,
    eventFamilies: [standardMetricObservationFamily({ family: FAMILY, datasetId: DATASET_ID }), statusFamily()] };
  let signed = T.signedSampleManifest(signer, manifestOptions);

  const partitions = new Map(); // partition -> [{ sequence, event }]
  const state = {
    requests: 0,
    acks: [],
    ackFailuresRemaining: 0,
    extraDeliveries: [], // events appended to the next page (replays / tampering)
    hiddenSequences: new Set(),
    onAck: null,
    snapshotThroughOverride: null,
  };

  function partitionEvents(key) {
    if (!partitions.has(key)) partitions.set(key, []);
    return partitions.get(key);
  }

  // Appends a standard metric observation event and returns it.
  function emitMetric({ partitionKey = "NG-LAGOS", metricId = "synthetic.completed_orders", value = 1, valueState = "OBSERVED", entityVersion, windowStart = "2026-10-01T00:00:00Z", windowEnd = "2026-10-02T00:00:00Z", scope = { market: "NG", organization: "cosmicforge", tenant: "tenant-a" }, skip = false, overrides = {} } = {}) {
    const list = partitionEvents(partitionKey);
    const sequence = (list.length ? list[list.length - 1].sequence : 0) + 1;
    const metric = signed.manifest.datasets[0].metrics.find((m) => m.metric_id === metricId) || { version: "1.0.0", unit: "count", currency: null };
    const observedAt = new Date(Date.now() - 1000).toISOString();
    const event = E.createEvent({
      schema_id: "cosmicforge.metric-observation", schema_version: "1.0.0", family: FAMILY,
      event_id: randomUUID(), source_id: INSTANCE_ID, product_id: PRODUCT_ID, dataset_id: DATASET_ID,
      partition_key: partitionKey, sequence,
      entity: { type: "synthetic.metric_window", id: metricId + ":" + windowStart.slice(0, 10) + ":" + (scope.tenant || "all"), version: entityVersion ?? sequence },
      scope, classification: "INTERNAL", occurred_at: observedAt, emitted_at: new Date().toISOString(),
      payload: { metric_id: metricId, definition_version: metric.version, window_start: windowStart, window_end: windowEnd, value: valueState === "OBSERVED" ? value : null, value_state: valueState, unit: metric.unit, currency: metric.currency, coverage: valueState === "OBSERVED" ? "COMPLETE" : "NONE", observed_at: valueState === "OBSERVED" ? observedAt : null },
      ...overrides,
    });
    if (overrides.payload) event.payload_digest = E.payloadDigest(event.payload);
    list.push({ sequence, event });
    if (skip) state.hiddenSequences.add(partitionKey + ":" + sequence);
    return event;
  }

  // Appends a standard non-metric status event and returns it.
  function emitStatus({ partitionKey = "NG-LAGOS", status = "COMPLETED", entityId = "order-1", entityVersion, scope = { market: "NG", organization: "cosmicforge", tenant: "tenant-a" }, payload } = {}) {
    const list = partitionEvents(partitionKey);
    const sequence = (list.length ? list[list.length - 1].sequence : 0) + 1;
    const at = new Date(Date.now() - 1000).toISOString();
    const event = E.createEvent({
      schema_id: "synthetic.order-status", schema_version: "1.0.0", family: STATUS_FAMILY,
      event_id: randomUUID(), source_id: INSTANCE_ID, product_id: PRODUCT_ID, dataset_id: DATASET_ID,
      partition_key: partitionKey, sequence,
      entity: { type: "synthetic.order", id: entityId, version: entityVersion ?? sequence },
      scope, classification: "INTERNAL", occurred_at: at, emitted_at: new Date().toISOString(),
      payload: payload || { status },
    });
    list.push({ sequence, event });
    return event;
  }

  const ok = (ctx, result, fields = {}) => ({ body: C.okEnvelope({ productId: PRODUCT_ID, correlationId: ctx.correlationId, result, ...fields }) });
  const fail = (ctx, code, reason) => ({ body: C.errorEnvelope({ productId: PRODUCT_ID, correlationId: ctx.correlationId, code, reason }) });

  const handlers = {
    healthLive: async () => ({ body: { status: "live" } }),
    healthReady: async () => ({ body: { status: "READY", upstream_certified: true } }),
    manifest: async (ctx) => ok(ctx, signed),
    capabilities: async (ctx) => ok(ctx, { capabilities: signed.manifest.capabilities, delegated_staff: ctx.delegation ? ctx.delegation.sub : null, delegated_scope: ctx.delegation ? ctx.delegation.scope : null }),
    datasets: async (ctx) => ok(ctx, { datasets: signed.manifest.datasets }),
    syncStatus: async (ctx) => ok(ctx, {
      event_source: "CERTIFIED",
      partitions: [...partitions.entries()].map(([key, list]) => ({ dataset_id: DATASET_ID, partition_key: key, head_sequence: list.length ? list[list.length - 1].sequence : 0 })),
      last_source_observation: new Date(Date.now() - 1000).toISOString(),
    }),
    events: async (ctx) => {
      const q = C.parseQuery(ctx.query, { dataset_id: { type: "id", required: true }, partition_key: { type: "partition", required: true }, after_sequence: { type: "int", min: 0, required: true }, limit: { type: "int", min: 1, max: 100, default: 50 } });
      if (q.dataset_id !== DATASET_ID) return fail(ctx, "NOT_FOUND", "UNKNOWN_DATASET");
      const list = partitionEvents(q.partition_key);
      const events = list.filter((e) => e.sequence > q.after_sequence && !state.hiddenSequences.has(q.partition_key + ":" + e.sequence)).slice(0, q.limit).map((e) => e.event);
      const extras = state.extraDeliveries.splice(0).filter((e) => e.partition_key === q.partition_key);
      return ok(ctx, { dataset_id: DATASET_ID, partition_key: q.partition_key, events: [...extras, ...events].slice(0, q.limit), head_sequence: list.length ? list[list.length - 1].sequence : 0 });
    },
    eventsAck: async (ctx) => {
      if (state.onAck) await state.onAck(ctx.body);
      if (state.ackFailuresRemaining > 0) { state.ackFailuresRemaining -= 1; return fail(ctx, "UNAVAILABLE", "ACK_STORE_UNAVAILABLE"); }
      state.acks.push({ ...ctx.body, at: Date.now() });
      return ok(ctx, { acknowledged: ctx.body.sequence });
    },
    datasetSnapshots: async (ctx) => {
      if (ctx.params.datasetId !== DATASET_ID) return fail(ctx, "NOT_FOUND", "UNKNOWN_DATASET");
      const q = C.parseQuery(ctx.query, { partition_key: { type: "partition" }, limit: { type: "int", min: 1, max: 100 }, cursor: { type: "cursor" } });
      const keys = q.partition_key ? [q.partition_key] : [...partitions.keys()];
      const latest = new Map();
      for (const key of keys) for (const { event } of partitionEvents(key)) {
        const prev = latest.get(event.entity.id);
        if (!prev || prev.entity.version < event.entity.version) latest.set(event.entity.id, event);
      }
      const asOf = new Date(Date.now() - 500).toISOString();
      return ok(ctx, {
        snapshot_id: "snap-" + randomUUID().slice(0, 8), dataset_id: DATASET_ID, dataset_version: signed.manifest.datasets[0].version,
        partitions: keys.map((key) => { const list = partitionEvents(key); return { partition_key: key, through_sequence: state.snapshotThroughOverride ?? (list.length ? list[list.length - 1].sequence : 0) }; }),
        records: [...latest.values()].map((e) => ({ entity: e.entity, scope: e.scope, payload: e.payload })),
        complete: true,
      }, { asOf, coverage: "COMPLETE", freshness: "FRESH" });
    },
    operationGet: async (ctx) => fail(ctx, "NOT_FOUND", "UNKNOWN_OPERATION"),
    operationSubmit: async (ctx) => fail(ctx, "DISABLED", "CAPABILITY_DISABLED"),
    auditGet: async (ctx) => fail(ctx, "NOT_FOUND", "UNKNOWN_OPERATION"),
  };

  const handler = S.createProductAdminHandler({
    productId: PRODUCT_ID, serviceInstanceId: INSTANCE_ID,
    serviceKeys: { "pic-synthetic-k1": { serviceId: "hq-product-integration-core", key: serviceKey } },
    nonceStore: S.memoryNonceStore(),
    delegationKeys: { "pic-synthetic-d1": { key: delegationKey } },
    audit: async () => {},
    logger: () => {},
    handlers,
  });
  const server = http.createServer((req, res) => { state.requests += 1; handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  return {
    PRODUCT_ID, INSTANCE_ID, DATASET_ID, signer, state, port,
    get manifest() { return signed; },
    // Operator configuration HQ would hold for this product (test values).
    endpointConfig(ref = "synthetic-third-test") {
      return { [ref]: { product_id: PRODUCT_ID, environment, transport: "http-loopback", origin: "http://127.0.0.1:" + port, address: "127.0.0.1", service_auth: { key_id: "pic-synthetic-k1", key_b64url: serviceKey.toString("base64url") }, delegation: { kid: "pic-synthetic-d1", key_b64url: delegationKey.toString("base64url") } } };
    },
    signerConfig() {
      return { [signer.kid]: { product_id: PRODUCT_ID, environment, public_key_pem: signer.publicKey.export({ type: "spki", format: "pem" }), not_after: new Date(Date.now() + 86400000).toISOString() } };
    },
    emitMetric,
    emitStatus,
    partitionEvents,
    republishManifest(options) {
      manifestOptions = { ...manifestOptions, ...options };
      signed = T.signedSampleManifest(signer, manifestOptions);
      return signed;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startSyntheticProductAdmin, PRODUCT_ID, INSTANCE_ID, DATASET_ID, STATUS_FAMILY };
