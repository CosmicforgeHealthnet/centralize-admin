"use strict";

// Staff-facing product reads. Product-neutral: every product, including
// Karryam, HealthNet and future products, is served from the same registry
// model. Nothing here returns zero or "complete" without a source observation.

const { randomUUID } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");
const I = require("../../../../packages/identity-and-permissions");
const { T } = require("../db");
const { loadGrants, authorizeStaff, AuthorizationError } = require("../authz");
const { resolveEndpoint, clientFor } = require("../registry/endpoints");
const { integrationStatus } = require("../monitoring");
const { scopeKey, freshnessOf } = require("../projections/metrics");
const policy = require("../registry/sync-policy");

const DIMS = ["market", "organization", "zone", "tenant"];

class ProductError extends Error {
  constructor(code, reason, status) {
    super(code + ":" + reason);
    this.code = code;
    this.reason = reason;
    this.status = status || C.ERROR_CODES[code] || 500;
  }
}

function createProducts({ pool, endpoints, environment, trustStore = false, now = Date.now, clientOptions = {} }) {
  // Same gate as the sync engine: a product that may not synchronize is not
  // offered for live reads either, so navigation, reads and runtime state
  // cannot disagree. Committed history is kept; it is served again once the
  // product passes the gate.
  const gateReason = (row, contract) => policy.syncBlock({ row, contract, trustStore, environment, nowMs: now() });

  async function liveRegistration(productId) {
    if (!new RegExp(C.PATTERNS.productId).test(String(productId))) throw new ProductError("NOT_FOUND", "UNKNOWN_PRODUCT");
    const { rows } = await pool.query(`SELECT * FROM ${T}hq_product_admins WHERE product_id = $1 AND environment = $2 AND lifecycle_status NOT IN ('REJECTED','REVOKED') ORDER BY created_at DESC LIMIT 1`, [productId, environment]);
    return rows[0] || null;
  }

  async function enabledRegistration(productId, { requireSyncGate = true } = {}) {
    const row = await liveRegistration(productId);
    if (!row) throw new ProductError("NOT_FOUND", "PRODUCT_NOT_REGISTERED");
    if (row.lifecycle_status !== "ENABLED") throw new ProductError("UNAVAILABLE", "PRODUCT_NOT_ENABLED");
    const { rows } = await pool.query(`SELECT * FROM ${T}hq_product_admin_contracts WHERE id = $1 AND status = 'ACTIVE'`, [row.current_contract_id]);
    if (!rows[0]) throw new ProductError("UNAVAILABLE", "NO_ACTIVE_CONTRACT");
    if (requireSyncGate) {
      const reason = policy.availabilityReason(gateReason(row, rows[0]));
      if (reason) throw new ProductError("UNAVAILABLE", reason);
    }
    return { row, contract: rows[0] };
  }

  function authorize(subject, action, ctx, extra) {
    return authorizeStaff(pool, { subject, action, correlationId: ctx.correlationId, now: now(), ...extra });
  }

  const envelope = (productId, ctx, fields) => C.okEnvelope({ productId, correlationId: ctx.correlationId, ...fields });

  // Short-lived (30 s) product delegation bound to one GET request, so the
  // Product Admin can check the staff member, action and scope itself.
  function productDelegation(subject, row, decision, action, uri) {
    const endpoint = resolveEndpoint(endpoints, row);
    return I.signDelegation({
      iss: "product-integration-core", aud: row.product_id + ":" + row.service_instance_id, sub: subject.staffId, sid: subject.sessionId,
      auth_time: subject.authTime, mfa_at: subject.mfaAt ?? null, product_id: row.product_id, action,
      scope: decision.effectiveScope, role: decision.role, grant_id: decision.grantId, bnd: I.requestBinding("GET", uri, Buffer.alloc(0)),
    }, { key: endpoint.delegation.key, kid: endpoint.delegation.kid, typ: I.TYPES.PRODUCT, now: now(), ttlSeconds: 30 });
  }

  return {
    // Navigation contract: which products this staff member can see and why.
    async list(subject, ctx) {
      const grants = await loadGrants(pool, subject.staffId);
      if (grants === null) throw new AuthorizationError("POLICY_UNAVAILABLE", 503);
      const productIds = [...new Set(grants.filter((g) => g.grant_kind === "PRODUCT").map((g) => g.product_id))].sort();
      const items = [];
      for (const productId of productIds) {
        const decision = I.authorize({ subject, productId, action: "product.view", grants, now: now() });
        if (!decision.allowed) continue;
        const row = await liveRegistration(productId);
        if (!row) { items.push({ product_id: productId, available: false, reason: "NOT_REGISTERED", navigation: null }); continue; }
        const { rows: [contract] } = row.current_contract_id
          ? await pool.query(`SELECT catalog, revision, protocol_major, protocol_minor, status FROM ${T}hq_product_admin_contracts WHERE id = $1`, [row.current_contract_id])
          : { rows: [] };
        const enabled = row.lifecycle_status === "ENABLED" && contract && contract.status === "ACTIVE";
        const reason = !enabled ? "NOT_ENABLED" : policy.availabilityReason(gateReason(row, { ...contract, id: row.current_contract_id }));
        // Same decision as the read path: expiry, explicit deny, dataset and scope all apply.
        const datasets = enabled ? contract.catalog.datasets.map((d) => ({ dataset_id: d.dataset_id, title: d.title, granted: I.authorize({ subject, productId, action: "metric.read", datasetId: d.dataset_id, grants, productScope: row.allowed_scope, now: now() }).allowed })) : [];
        const states = {};
        if (enabled) for (const cap of contract.catalog.capabilities) states[cap.state] = (states[cap.state] || 0) + 1;
        items.push({
          product_id: productId,
          display_name: row.display_name,
          available: reason === null,
          reason,
          lifecycle_status: row.lifecycle_status,
          contract_revision: enabled ? contract.revision : null,
          protocol: enabled ? { major: contract.protocol_major, minor: contract.protocol_minor } : null,
          effective_scope: decision.effectiveScope,
          role: decision.role,
          capability_states: states,
          datasets,
          navigation: reason === null ? { section: "products", key: productId, label: row.display_name } : null,
        });
      }
      return { products: items };
    },

    async manifest(subject, productId, ctx) {
      // Diagnostic: the approved contract and the recorded drift stay readable.
      const { row, contract } = await enabledRegistration(productId, { requireSyncGate: false });
      await authorize(subject, "product.manifest.read", ctx, { productId, productAdminId: row.id, productScope: row.allowed_scope });
      return envelope(productId, ctx, { result: {
        product_id: productId, display_name: row.display_name, environment: row.environment, contract_revision: contract.revision,
        protocol: { major: contract.protocol_major, minor: contract.protocol_minor }, build_sha: contract.build_sha, manifest_revision: row.manifest_revision,
        manifest_digest: row.manifest_digest, catalog_digest: contract.catalog_digest, manifest_expires_at: row.manifest_expires_at, drift_status: row.drift_status,
        capabilities: contract.catalog.capabilities.map(({ request_schema, ...cap }) => cap), event_families: contract.catalog.event_families.map(({ payload_schema, ...f }) => f),
      } });
    },

    // Live capability discovery through the Product Admin with a short-lived,
    // request-bound product delegation (never browser-held keys).
    async capabilities(subject, productId, ctx) {
      const { row } = await enabledRegistration(productId);
      const decision = await authorize(subject, "product.capabilities.read", ctx, { productId, productAdminId: row.id, productScope: row.allowed_scope });
      const token = productDelegation(subject, row, decision, "product.capabilities.read", C.endpointPath("capabilities"));
      let res;
      try { res = await clientFor(endpoints, row, clientOptions).getCapabilities({ delegation: token, correlationId: ctx.correlationId }); }
      catch { throw new ProductError("UNAVAILABLE", "PRODUCT_ADMIN_UNREACHABLE"); }
      return res.json;
    },

    async datasets(subject, productId, ctx) {
      const { row, contract } = await enabledRegistration(productId);
      await authorize(subject, "dataset.list", ctx, { productId, productAdminId: row.id, productScope: row.allowed_scope });
      const grants = await loadGrants(pool, subject.staffId);
      const { rows } = await pool.query(`SELECT d.dataset_id, d.version, d.privacy_class, d.semantic_grain, d.currency, d.freshness_target_seconds, d.scope_dimensions, d.authorized_departments, d.metrics, d.approval_status,
                                                s.coverage, s.gap_status, s.last_source_observation_at
                                         FROM ${T}hq_product_admin_datasets d LEFT JOIN ${T}hq_product_admin_subscriptions s ON s.dataset_row_id = d.id
                                         WHERE d.product_admin_id = $1 AND d.approval_status = 'APPROVED' ORDER BY d.dataset_id`, [row.id]);
      const visible = rows.filter((d) => I.authorize({ subject, productId, action: "metric.read", datasetId: d.dataset_id, grants, productScope: row.allowed_scope, now: now() }).allowed);
      return envelope(productId, ctx, { result: { contract_revision: contract.revision, datasets: visible.map((d) => ({
        dataset_id: d.dataset_id, version: d.version, privacy_class: d.privacy_class, semantic_grain: d.semantic_grain, currency: d.currency,
        freshness_target_seconds: d.freshness_target_seconds, scope_dimensions: d.scope_dimensions,
        metrics: d.metrics.map((m) => ({ metric_id: m.metric_id, version: m.version, unit: m.unit, currency: m.currency, grain: m.grain, aggregation: m.aggregation, definition: m.definition })),
        synchronization: { coverage: d.coverage || "NONE", gap_status: d.gap_status || "NONE", last_source_observation_at: d.last_source_observation_at || null },
      })) } });
    },

    // Exact-scope metric reads. No aggregation across scopes, products or
    // currencies; a missing observation is UNAVAILABLE, never zero.
    async metric(subject, productId, metricId, query, ctx) {
      const { row, contract } = await enabledRegistration(productId);
      if (!new RegExp(C.PATTERNS.catalogId).test(String(metricId))) throw new ProductError("INVALID_REQUEST", "METRIC_ID_INVALID");
      const found = C.findMetric(contract.catalog, metricId);
      if (!found) throw new ProductError("NOT_FOUND", "UNKNOWN_METRIC");
      const q = C.parseQuery(query, {
        window_start: { type: "datetime" }, window_end: { type: "datetime" },
        market: { type: "scope" }, organization: { type: "scope" }, zone: { type: "scope" }, tenant: { type: "scope" },
        limit: { type: "int", min: 1, max: 100, default: 31 },
      });
      const requested = {};
      for (const dim of DIMS) if (q[dim] !== undefined) requested[dim] = q[dim];
      const decision = await authorize(subject, "metric.read", ctx, { productId, productAdminId: row.id, datasetId: found.dataset.dataset_id, requestedScope: requested, productScope: row.allowed_scope });
      // The effective scope must resolve to one exact scope (single value per dimension).
      const exact = {};
      for (const dim of DIMS) {
        const values = decision.effectiveScope[dim];
        if (!values) continue;
        if (values.length !== 1) throw new ProductError("INVALID_REQUEST", "SCOPE_AMBIGUOUS");
        exact[dim] = values[0];
      }
      const params = [row.id, metricId, found.metric.version, scopeKey(exact)];
      let where = "";
      if (q.window_start) { params.push(q.window_start); where += ` AND window_start >= $${params.length}`; }
      if (q.window_end) { params.push(q.window_end); where += ` AND window_end <= $${params.length}`; }
      params.push(q.limit);
      const { rows } = await pool.query(
        `SELECT m.window_start, m.window_end, m.value, m.value_state, m.unit, m.currency, m.grain, m.source_observed_at, m.coverage, m.source_entity_version, m.version, c.revision AS contract_revision, s.freshness_target_seconds, s.coverage AS stream_coverage, s.gap_status
         FROM ${T}hq_product_admin_metrics m JOIN ${T}hq_product_admin_contracts c ON c.id = m.contract_id JOIN ${T}hq_product_admin_subscriptions s ON s.id = m.subscription_id
         WHERE m.product_admin_id = $1 AND m.metric_id = $2 AND m.definition_version = $3 AND m.scope_key = $4${where}
         ORDER BY m.window_start DESC LIMIT $${params.length}`, params);
      if (rows.length === 0) {
        return { status: 503, body: C.errorEnvelope({ productId, correlationId: ctx.correlationId, code: "UNAVAILABLE", reason: "NO_SOURCE_OBSERVATION", retryable: true }) };
      }
      const observations = rows.map((r) => ({
        window_start: r.window_start.toISOString(), window_end: r.window_end.toISOString(), grain: r.grain, unit: r.unit, currency: r.currency,
        value: r.value_state === "OBSERVED" ? Number(r.value) : null, value_state: r.value_state,
        source_observed_at: r.source_observed_at ? r.source_observed_at.toISOString() : null,
        freshness: freshnessOf(r.source_observed_at && r.source_observed_at.toISOString(), r.freshness_target_seconds, now()),
        coverage: r.coverage, source_entity_version: Number(r.source_entity_version), projection_version: r.version, contract_revision: r.contract_revision,
      }));
      const observedTimes = observations.map((o) => o.source_observed_at).filter(Boolean).sort();
      const partial = rows.some((r) => r.coverage !== "COMPLETE" || r.stream_coverage === "PARTIAL" || r.gap_status === "GAP_DETECTED");
      const asOf = observedTimes.length ? observedTimes[0] : null;
      return envelope(productId, ctx, {
        asOf, coverage: asOf ? (partial ? "PARTIAL" : "COMPLETE") : "UNKNOWN",
        freshness: asOf ? (observations.every((o) => o.freshness === "FRESH") ? "FRESH" : "STALE") : "UNKNOWN",
        result: { metric: { ...found.metric, dataset_id: found.dataset.dataset_id }, scope: exact, observations },
      });
    },

    async eventsStatus(subject, productId, ctx) {
      const row = await liveRegistration(productId);
      if (!row) throw new ProductError("NOT_FOUND", "PRODUCT_NOT_REGISTERED");
      await authorize(subject, "events.status.read", ctx, { productId, productAdminId: row.id, productScope: row.allowed_scope });
      const status = await integrationStatus(pool, row.id, { now: now() });
      return envelope(productId, ctx, { result: {
        registry: status.registry, connection: status.connection, drift: status.drift, sync: status.sync, quarantine: status.quarantine,
        subscriptions: status.subscriptions.map((s) => ({ dataset_id: s.dataset_id, enabled: s.enabled, status: s.status, coverage: s.coverage, gap_status: s.gap_status, quarantined_count: s.quarantined_count, last_success_at: s.last_success_at, last_source_observation_at: s.last_source_observation_at, lag_seconds: s.lag_seconds })),
        cursors: status.cursors.map((c) => ({ partition_key: c.partition_key, last_sequence: Number(c.last_sequence), acked_sequence: Number(c.acked_sequence), head_sequence: c.head_sequence === null ? null : Number(c.head_sequence), sequence_lag: c.sequence_lag, gap: c.gap_from === null ? null : { from: Number(c.gap_from), to: Number(c.gap_to) } })),
      } });
    },

    async operation(subject, productId, operationId, ctx) {
      const { row } = await enabledRegistration(productId);
      const decision = await authorize(subject, "operation.read", ctx, { productId, productAdminId: row.id, productScope: row.allowed_scope });
      if (!new RegExp(C.PATTERNS.pathParam).test(String(operationId))) throw new ProductError("INVALID_REQUEST", "OPERATION_ID_INVALID");
      try {
        const delegation = productDelegation(subject, row, decision, "operation.read", C.endpointPath("operationGet", { operationId }));
        const res = await clientFor(endpoints, row, clientOptions).getOperation(operationId, { correlationId: ctx.correlationId, delegation });
        return { status: res.status, body: res.json };
      } catch {
        throw new ProductError("UNAVAILABLE", "PRODUCT_ADMIN_UNREACHABLE");
      }
    },

    // Command submission stays disabled in this phase. The request is
    // authorized and checked against the certified contract, then refused;
    // no request body is ever forwarded as an arbitrary command.
    async submitOperation(subject, productId, body, ctx) {
      const { row, contract } = await enabledRegistration(productId);
      await authorize(subject, "operation.submit", ctx, { productId, productAdminId: row.id, productScope: row.allowed_scope });
      const capabilityId = body && typeof body.capability_id === "string" ? body.capability_id : null;
      const capability = capabilityId ? contract.catalog.capabilities.find((c) => c.id === capabilityId) : null;
      const reason = !capability ? "UNKNOWN_CAPABILITY"
        : capability.kind !== "COMMAND" ? "NOT_A_COMMAND"
        : capability.state !== "AVAILABLE" ? "CAPABILITY_" + capability.state
        : !row.operations_enabled ? "OPERATIONS_NOT_ENABLED_FOR_PRODUCT"
        : "COMMAND_EXECUTION_NOT_CERTIFIED";
      return { status: 403, body: C.errorEnvelope({ productId, correlationId: ctx.correlationId, code: "DISABLED", reason, retryable: false }) };
    },
  };
}

module.exports = { createProducts, ProductError, randomUUID };
