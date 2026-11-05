"use strict";

// Approved datasets Karryam Admin publishes to Headquarters (Stage B). Every
// metric is derived only from minimized projections of real Bridge source
// events (or from Karryam Admin's own pipeline state for sync health), with
// an exact definition, unit, grain and lineage.
//
// Truthfulness rule: a count derived from projections is OBSERVED only when
// the projection coverage for its source is COMPLETE (consumed from the
// start of the Bridge feed, no hold, no open entity-version gap, no open
// quarantine, and the Bridge itself reports COMPLETE source coverage).
// Otherwise the observation is published as UNAVAILABLE with coverage
// PARTIAL: missing data is never zero.

const { contracts } = require("../packages");

const LINEAGE = { source_system: "karryam-backoffice-bridge", source_owner: "karryam-native-owner-services" };
const COUNT = { aggregation: "GAUGE", grain: "DAY", unit: "count", currency: null, version: "1.0.0" };

const SUPPORT_OPEN = ["OPEN", "UNDER_REVIEW", "AWAITING_EVIDENCE", "ESCALATED"];

const DEFINITIONS = Object.freeze([
  {
    dataset_id: "karryam.support_operations",
    title: "Karryam support and safety queue gauges",
    departments: ["support", "operations"],
    source: { source_service: "support-dispute-service", entity_type: "support_case" },
    derivation: "Counts of current support-case projections (support.case.changed.v1 via the Bridge), latest source version per case, tombstones excluded",
    metrics: [
      { metric_id: "karryam.support.cases_open", definition: "Support cases whose current source status is OPEN, UNDER_REVIEW, AWAITING_EVIDENCE or ESCALATED, as of the observation", count: (p) => SUPPORT_OPEN.includes(p.status) },
      { metric_id: "karryam.support.cases_emergency_open", definition: "Open support cases (as above) with source priority EMERGENCY (SOS)", count: (p) => SUPPORT_OPEN.includes(p.status) && p.priority === "EMERGENCY" },
      { metric_id: "karryam.support.cases_escalated", definition: "Support cases whose current source status is ESCALATED", count: (p) => p.status === "ESCALATED" },
    ],
  },
  {
    dataset_id: "karryam.verification_pipeline",
    title: "Karryam vendor verification pipeline gauges",
    departments: ["operations", "compliance"],
    source: { source_service: "verification-compliance-service", entity_type: "vendor_verification_case" },
    derivation: "Counts of current vendor verification case projections (verification.vendor_case.changed.v1 via the Bridge); automated recommendations are not counted as decisions",
    metrics: [
      { metric_id: "karryam.verification.cases_pending_review", definition: "Verification cases whose current source status is PENDING_REVIEW", count: (p) => p.status === "PENDING_REVIEW" },
      { metric_id: "karryam.verification.cases_in_progress", definition: "Verification cases whose current source status is IN_PROGRESS", count: (p) => p.status === "IN_PROGRESS" },
      { metric_id: "karryam.verification.cases_verified", definition: "Verification cases whose current source status is VERIFIED (a human/source decision, never an automated recommendation)", count: (p) => p.status === "VERIFIED" },
      { metric_id: "karryam.verification.cases_rejected", definition: "Verification cases whose current source status is REJECTED", count: (p) => p.status === "REJECTED" },
    ],
  },
  {
    dataset_id: "karryam.marketing_campaigns",
    title: "Karryam campaign execution evidence",
    departments: ["marketing"],
    source: { source_service: "notification-service", entity_type: "campaign_revision" },
    derivation: "Sums over the latest projected revision of each campaign (notification.campaign.changed.v1 via the Bridge). LOGGED_ONLY is never delivered; delivered is observed only when every included campaign has provider receipts",
    metrics: [
      { metric_id: "karryam.marketing.messages_sent", definition: "Sum of sent_count over current campaign revisions (handed to a provider; not delivery)", sum: (p) => p.sent_count },
      { metric_id: "karryam.marketing.messages_logged_only", definition: "Sum of logged_only_count over current campaign revisions (recorded without a provider send; never delivered)", sum: (p) => p.logged_only_count },
      { metric_id: "karryam.marketing.messages_failed", definition: "Sum of failed_count over current campaign revisions", sum: (p) => p.failed_count },
      { metric_id: "karryam.marketing.messages_suppressed", definition: "Sum of suppressed_count over current campaign revisions (consent or policy suppression by the source)", sum: (p) => p.suppressed_count },
      { metric_id: "karryam.marketing.messages_delivered", definition: "Sum of delivered_count over current campaign revisions, observed only when every campaign reports PROVIDER_RECEIPTS", sum: (p) => p.delivered_count, requires: (rows) => rows.every((p) => p.delivery_confirmation === "PROVIDER_RECEIPTS" && Number.isInteger(p.delivered_count)) },
    ],
  },
  {
    dataset_id: "karryam.sync_health",
    title: "Karryam Admin synchronization health",
    departments: ["operations", "engineering"],
    source: null,
    derivation: "Karryam Admin pipeline state for this Bridge feed partition (cursor, Bridge head, open entity gaps, open quarantine)",
    lineage: { source_system: "karryam-admin", source_owner: "karryam-admin" },
    metrics: [
      { metric_id: "karryam.sync.bridge_lag_events", definition: "Bridge feed head sequence minus the committed Karryam Admin cursor for this partition at the observation", pipeline: "lag" },
      { metric_id: "karryam.sync.open_entity_gaps", definition: "Open entity-version gaps recorded for this partition", pipeline: "gaps" },
      { metric_id: "karryam.sync.open_quarantine", definition: "Unresolved quarantined Bridge events for this partition", pipeline: "quarantine" },
    ],
  },
]);

const BY_DATASET = new Map(DEFINITIONS.map((d) => [d.dataset_id, d]));
const BY_SOURCE = new Map(DEFINITIONS.filter((d) => d.source).map((d) => [d.source.source_service + "|" + d.source.entity_type, d]));

function familyId(datasetId) {
  return datasetId + ".metric_observation";
}

function manifestDatasets(certified = []) {
  return DEFINITIONS.map((d) => {
    const isCertified = certified.includes(d.dataset_id);
    return contracts.withSchemaDigest({
      dataset_id: d.dataset_id,
      version: "1.0.0",
      schema_id: d.dataset_id,
      schema_digest: "sha256:" + "0".repeat(64),
      title: d.title,
      privacy_class: "INTERNAL",
      scope_dimensions: ["market", "organization", "zone", "tenant"],
      authorized_departments: d.departments,
      semantic_grain: "DAY",
      units: ["count"],
      currency: null,
      freshness_target_seconds: 3600,
      lineage: { ...(d.lineage || LINEAGE), derivation: d.derivation },
      allowed_fields: [
        { name: "metric_id", type: "string", classification: "INTERNAL", meaning: "Approved metric identifier", unit: null },
        { name: "value", type: "integer", classification: "INTERNAL", meaning: "Gauge value at the observation; null when unavailable", unit: "count" },
      ],
      metrics: d.metrics.map((m) => ({ metric_id: m.metric_id, version: COUNT.version, definition: m.definition, aggregation: COUNT.aggregation, grain: COUNT.grain, unit: COUNT.unit, currency: null })),
      retention_days: 730,
      readiness: isCertified ? "CERTIFIED_BY_PRODUCT" : "NOT_CERTIFIED",
      blockers: isCertified ? [] : [{ code: "STAGING_CERTIFICATION_PENDING", detail: "Pipeline implemented and tested; live Bridge enrollment and staging certification are pending" }],
    });
  });
}

function manifestFamilies(certified = []) {
  return DEFINITIONS.map((d) => contracts.standardMetricObservationFamily({ family: familyId(d.dataset_id), datasetId: d.dataset_id, classification: "INTERNAL", status: certified.includes(d.dataset_id) ? "ACTIVE" : "NOT_CERTIFIED" }));
}

// UTC day window containing `at`.
function dayWindow(at) {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { window_start: new Date(start).toISOString(), window_end: new Date(start + 86400000).toISOString() };
}

// Derives every metric of one projection-backed dataset from current
// (non-tombstoned) payloads. A row may carry `_n` (a SQL group count) so
// count metrics are computed from grouped rows. `complete` is the coverage
// decision: without it every value is UNAVAILABLE.
function deriveFromProjections(def, rows, { complete, observedAt }) {
  return def.metrics.map((m) => {
    let value = null;
    if (complete && (!m.requires || m.requires(rows))) {
      if (m.count) value = rows.filter(m.count).reduce((n, p) => n + (Number.isInteger(p._n) ? p._n : 1), 0);
      else if (rows.every((p) => Number.isInteger(m.sum(p)))) value = rows.reduce((sum, p) => sum + m.sum(p), 0);
    }
    return observation(m.metric_id, value, complete ? "COMPLETE" : "PARTIAL", observedAt);
  });
}

function observation(metricId, value, coverage, observedAt) {
  const w = dayWindow(Date.parse(observedAt));
  return {
    metric_id: metricId, definition_version: COUNT.version, ...w,
    value, value_state: value === null ? "UNAVAILABLE" : "OBSERVED", unit: "count", currency: null,
    coverage, observed_at: value === null ? null : observedAt,
  };
}

module.exports = { DEFINITIONS, BY_DATASET, BY_SOURCE, familyId, manifestDatasets, manifestFamilies, dayWindow, deriveFromProjections, observation };
