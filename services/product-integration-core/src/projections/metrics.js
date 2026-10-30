"use strict";

// Domain-neutral metric projection. The only projection HQ applies: a
// standard METRIC_OBSERVATION payload checked against the metric definition
// pinned in the product's ACTIVE contract. No product semantics are assumed:
// two products' metrics are never merged, and currencies are never combined.

const { randomUUID } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");
const { T } = require("../db");

const DIMS = ["market", "organization", "zone", "tenant"];

function scopeKey(scope) {
  return DIMS.filter((d) => scope[d] !== undefined).map((d) => d + "=" + scope[d]).join("|") || "global";
}

function freshnessOf(observedAt, targetSeconds, now) {
  if (!observedAt) return "UNKNOWN";
  return now - Date.parse(observedAt) <= targetSeconds * 1000 ? "FRESH" : "STALE";
}

/**
 * Validates an observation against the dataset's pinned metric definitions.
 * Returns { ok: true, metric } or { ok: false, reason }.
 */
function checkObservation(dataset, payload) {
  if (C.metricObservationErrors(payload).length) return { ok: false, reason: "PAYLOAD_INVALID" };
  const metric = (dataset.metrics || []).find((m) => m.metric_id === payload.metric_id);
  if (!metric) return { ok: false, reason: "METRIC_UNKNOWN" };
  if (metric.version !== payload.definition_version) return { ok: false, reason: "METRIC_DEFINITION_MISMATCH" };
  if (metric.unit !== payload.unit) return { ok: false, reason: "METRIC_UNIT_MISMATCH" };
  if ((metric.currency || null) !== (payload.currency || null)) return { ok: false, reason: "METRIC_CURRENCY_MISMATCH" };
  return { ok: true, metric };
}

/**
 * Applies one observation inside the caller's transaction. Never replaces a
 * newer authoritative entity version. Returns
 *   { application: "APPLIED", metricRowId } | { application: "STALE_IGNORED" }
 */
async function applyObservation(client, { productAdmin, subscription, contractId, dataset, metric, payload, scope, entityVersion, sequence, now }) {
  const id = randomUUID();
  const definitionDigest = C.digestOf(metric);
  const freshness = freshnessOf(payload.observed_at, subscription.freshness_target_seconds, now);
  const { rows } = await client.query(
    `INSERT INTO ${T}hq_product_admin_metrics (id, product_admin_id, product_id, subscription_id, contract_id, dataset_id, metric_id, definition_version, definition_digest, scope_key, scope, window_start, window_end, grain, unit, currency, value, value_state, source_observed_at, freshness, coverage, source_sequence, source_entity_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (product_admin_id, metric_id, definition_version, scope_key, window_start, window_end) DO UPDATE SET
       value = EXCLUDED.value, value_state = EXCLUDED.value_state, source_observed_at = EXCLUDED.source_observed_at,
       freshness = EXCLUDED.freshness, coverage = EXCLUDED.coverage, source_sequence = EXCLUDED.source_sequence,
       source_entity_version = EXCLUDED.source_entity_version, contract_id = EXCLUDED.contract_id, subscription_id = EXCLUDED.subscription_id,
       definition_digest = EXCLUDED.definition_digest
     WHERE ${T}hq_product_admin_metrics.source_entity_version < EXCLUDED.source_entity_version
     RETURNING id`,
    [id, productAdmin.id, productAdmin.product_id, subscription.id, contractId, dataset.dataset_id, metric.metric_id, metric.version, definitionDigest, scopeKey(scope), JSON.stringify(scope),
      payload.window_start, payload.window_end, metric.grain, metric.unit, metric.currency || null, payload.value, payload.value_state, payload.observed_at, freshness, payload.coverage, sequence, entityVersion]);
  if (!rows[0]) return { application: "STALE_IGNORED" };
  return { application: "APPLIED", metricRowId: rows[0].id };
}

module.exports = { scopeKey, freshnessOf, checkObservation, applyObservation };
