"use strict";

// Approved datasets CF Meet Admin publishes to Headquarters (Stage B).
//
// Eight datasets are the CF Meet Bridge datasets (Track A §11), pulled as
// daily series from bridge.datasets.read (GET /datasets/{dataset_id},
// SCOPED_WINDOW, purpose metrics-read). Each (metric, UTC day) becomes one
// HQ metric observation. cfmeet.sync_health is HQ-local: CF Meet Admin's own
// pipeline state for one Bridge feed partition.
//
// Truthfulness rule: a value is OBSERVED only when the Bridge reports a
// non-null integer for that day AND the series coverage is COMPLETE.
// Otherwise the observation is UNAVAILABLE (coverage PARTIAL): missing data
// is never zero, and a figure is never shown under incomplete coverage.

const { contracts } = require("../packages");

const LINEAGE = { source_system: "cfmeet-admin-bridge", source_owner: "cfmeet-owner-services" };
const VERSION = "1.0.0";
const METRIC_NAME = /^[a-z][a-z_]{0,47}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const bridgeSeries = (id, title, departments, owners, metrics) => ({
  dataset_id: id, title, departments, kind: "BRIDGE_SERIES", source: null, owners,
  derivation: "Daily series pulled from the CF Meet Admin Bridge (bridge.datasets.read " + id + "); one observation per metric per UTC day; null means unknown and is never published as zero",
  metrics: metrics.map(([name, definition, unit = "count", aggregation = "COUNT"]) => ({ metric_id: id + "." + name, source_metric: name, definition, unit, aggregation })),
});

const DEFINITIONS = Object.freeze([
  bridgeSeries("cfmeet.engagement_daily", "CF Meet daily engagement", ["cfmeet-operations", "marketing"], "meeting-service (account authority)", [
    ["dau", "Distinct accounts active during the UTC day"],
    ["mau", "Distinct accounts active during the 30 days ending with the UTC day", "count", "GAUGE"],
    ["signups", "Accounts created during the UTC day"],
  ]),
  bridgeSeries("cfmeet.meetings_daily", "CF Meet daily meetings", ["cfmeet-operations"], "meeting-service", [
    ["meetings", "Meetings that started during the UTC day"],
    ["participant_minutes", "Participant-minutes in meetings during the UTC day", "minute", "SUM"],
    ["peak_live_meetings", "Highest number of simultaneously live meetings during the UTC day", "count", "MAX"],
  ]),
  bridgeSeries("cfmeet.messaging_daily", "CF Meet daily messaging volume", ["cfmeet-operations"], "messaging", [
    ["messages_sent", "Messages sent during the UTC day (count only; no content)"],
  ]),
  bridgeSeries("cfmeet.partners_daily", "CF Meet partner workspaces", ["cfmeet-operations", "finance"], "developer-platform", [
    ["workspaces_active", "Partner workspaces in ACTIVE state at the end of the UTC day", "count", "GAUGE"],
    ["workspaces_restricted", "Partner workspaces in RESTRICTED state at the end of the UTC day", "count", "GAUGE"],
    ["workspaces_suspended", "Partner workspaces in SUSPENDED state at the end of the UTC day", "count", "GAUGE"],
    ["partners_live", "Partners with at least one live (go-live approved) workspace at the end of the UTC day", "count", "GAUGE"],
    ["partner_mau", "Distinct partner end users active during the 30 days ending with the UTC day", "count", "GAUGE"],
  ]),
  bridgeSeries("cfmeet.apps_daily", "CF Meet apps and installs", ["cfmeet-operations"], "developer-platform", [
    ["apps_draft", "Apps in DRAFT at the end of the UTC day", "count", "GAUGE"],
    ["apps_in_review", "Apps IN_REVIEW at the end of the UTC day", "count", "GAUGE"],
    ["apps_published", "Apps PUBLISHED at the end of the UTC day", "count", "GAUGE"],
    ["apps_suspended", "Apps SUSPENDED at the end of the UTC day", "count", "GAUGE"],
    ["installs", "App installs during the UTC day"],
  ]),
  bridgeSeries("cfmeet.verification_queue", "CF Meet verification queue", ["cfmeet-operations", "compliance"], "developer-platform", [
    ["pending", "Verification cases waiting for a reviewer at the end of the UTC day", "count", "GAUGE"],
    ["in_review", "Verification cases claimed by a reviewer at the end of the UTC day", "count", "GAUGE"],
    ["approved", "Verification cases approved during the UTC day (human decisions only)"],
    ["rejected", "Verification cases rejected during the UTC day"],
  ]),
  bridgeSeries("cfmeet.trust_safety_queue", "CF Meet trust and safety queue", ["cfmeet-operations", "compliance"], "messaging, calling, communications, meeting-service", [
    ["open_messaging", "Open messaging abuse reports at the end of the UTC day", "count", "GAUGE"],
    ["open_calling", "Open calling abuse reports at the end of the UTC day", "count", "GAUGE"],
    ["open_communications", "Open communications abuse reports at the end of the UTC day", "count", "GAUGE"],
    ["open_meetings", "Open meeting abuse reports at the end of the UTC day", "count", "GAUGE"],
  ]),
  bridgeSeries("cfmeet.operations_health", "CF Meet operations health (Bridge side)", ["cfmeet-operations", "engineering"], "messaging, notifications, incident owners", [
    ["failed_messages", "Messages that failed delivery during the UTC day"],
    ["failed_deliveries", "Notification deliveries that failed during the UTC day"],
    ["open_incidents", "Open incidents at the end of the UTC day", "count", "GAUGE"],
    ["projection_gaps", "Open owner-to-Bridge projection gaps at the end of the UTC day (Bridge-side sync, not HQ sync)", "count", "GAUGE"],
    ["quarantined_events", "Owner events quarantined by the Bridge at the end of the UTC day", "count", "GAUGE"],
  ]),
  {
    dataset_id: "cfmeet.sync_health",
    title: "CF Meet Admin synchronization health (HQ side)",
    departments: ["cfmeet-operations", "engineering"],
    kind: "PIPELINE",
    source: null,
    derivation: "CF Meet Admin pipeline state for this Bridge feed partition (cursor, Bridge head, open entity gaps, open quarantine)",
    lineage: { source_system: "cfmeet-admin", source_owner: "cfmeet-admin" },
    metrics: [
      { metric_id: "cfmeet.sync.bridge_lag_events", definition: "Bridge feed head sequence minus the committed CF Meet Admin cursor for this partition at the observation", pipeline: "lag", unit: "count", aggregation: "GAUGE" },
      { metric_id: "cfmeet.sync.open_entity_gaps", definition: "Open entity-version gaps recorded for this partition", pipeline: "gaps", unit: "count", aggregation: "GAUGE" },
      { metric_id: "cfmeet.sync.open_quarantine", definition: "Unresolved quarantined Bridge events for this partition", pipeline: "quarantine", unit: "count", aggregation: "GAUGE" },
    ],
  },
]);

const BY_DATASET = new Map(DEFINITIONS.map((d) => [d.dataset_id, d]));
// Event-projection-derived datasets: none for CF Meet (projections feed the
// local reports only). Kept as an empty map so the pipeline code is shared.
const BY_SOURCE = new Map();
const BRIDGE_DATASETS = Object.freeze(DEFINITIONS.filter((d) => d.kind === "BRIDGE_SERIES").map((d) => d.dataset_id));

function familyId(datasetId) {
  return datasetId + ".metric_observation";
}

function manifestDatasets(certified = []) {
  return DEFINITIONS.map((d) => {
    const isCertified = certified.includes(d.dataset_id);
    return contracts.withSchemaDigest({
      dataset_id: d.dataset_id,
      version: VERSION,
      schema_id: d.dataset_id,
      schema_digest: "sha256:" + "0".repeat(64),
      title: d.title,
      privacy_class: "INTERNAL",
      scope_dimensions: ["market", "organization", "zone", "tenant"],
      authorized_departments: d.departments,
      semantic_grain: "DAY",
      units: [...new Set(d.metrics.map((m) => m.unit))],
      currency: null,
      freshness_target_seconds: d.kind === "PIPELINE" ? 3600 : 26 * 3600,
      lineage: { ...(d.lineage || LINEAGE), derivation: d.derivation },
      allowed_fields: [
        { name: "metric_id", type: "string", classification: "INTERNAL", meaning: "Approved metric identifier", unit: null },
        { name: "value", type: "integer", classification: "INTERNAL", meaning: "Value for the day; null when unavailable", unit: null },
      ],
      metrics: d.metrics.map((m) => ({ metric_id: m.metric_id, version: VERSION, definition: m.definition, aggregation: m.aggregation, grain: "DAY", unit: m.unit, currency: null })),
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

function observation(metricId, value, coverage, observedAt, { unit = "count", windowAt } = {}) {
  const w = dayWindow(windowAt !== undefined ? windowAt : Date.parse(observedAt));
  return {
    metric_id: metricId, definition_version: VERSION, ...w,
    value, value_state: value === null ? "UNAVAILABLE" : "OBSERVED", unit, currency: null,
    coverage, observed_at: value === null ? null : observedAt,
  };
}

class SeriesError extends Error {
  constructor(reason) { super(reason); this.name = "SeriesError"; this.reason = reason; }
}

/**
 * Turns one validated Bridge series result into HQ observations.
 * Every defined metric is emitted for every day in the series; a missing or
 * null source value, or a series that is not COMPLETE, is UNAVAILABLE.
 * Unknown metric names from the source are refused (never published).
 */
function seriesObservations(def, result, { observedAt }) {
  if (!def || def.kind !== "BRIDGE_SERIES") throw new SeriesError("NOT_A_BRIDGE_DATASET");
  if (!result || result.dataset_id !== def.dataset_id) throw new SeriesError("DATASET_MISMATCH");
  const complete = result.coverage === "COMPLETE";
  const known = new Set(def.metrics.map((m) => m.source_metric));
  const seen = new Set();
  const out = [];
  for (const row of result.series || []) {
    if (!row || !DAY.test(row.date) || Number.isNaN(Date.parse(row.date + "T00:00:00Z"))) throw new SeriesError("SERIES_DATE_INVALID");
    if (seen.has(row.date)) throw new SeriesError("SERIES_DATE_DUPLICATE");
    seen.add(row.date);
    const metrics = row.metrics || {};
    for (const name of Object.keys(metrics)) if (!METRIC_NAME.test(name) || !known.has(name)) throw new SeriesError("SERIES_METRIC_UNKNOWN");
    const at = Date.parse(row.date + "T00:00:00Z");
    for (const m of def.metrics) {
      const raw = metrics[m.source_metric];
      const value = complete && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
      out.push(observation(m.metric_id, value, complete ? "COMPLETE" : "PARTIAL", observedAt, { unit: m.unit, windowAt: at }));
    }
  }
  return out;
}

module.exports = { DEFINITIONS, BY_DATASET, BY_SOURCE, BRIDGE_DATASETS, familyId, manifestDatasets, manifestFamilies, dayWindow, observation, seriesObservations, SeriesError };
