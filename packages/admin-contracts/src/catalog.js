"use strict";

// Semantic validation of capability, dataset and event-family catalogs
// beyond their JSON shape.

const P = require("./protocol");
const { digestOf } = require("./canonical");
const { checkSchema } = require("./validator");
const S = require("./schemas");

// The dataset schema digest covers everything that defines meaning. A change
// to any of these without a version change is detectable drift.
function datasetSchemaDigest(dataset) {
  return digestOf({
    schema_id: dataset.schema_id,
    version: dataset.version,
    privacy_class: dataset.privacy_class,
    scope_dimensions: dataset.scope_dimensions,
    semantic_grain: dataset.semantic_grain,
    units: dataset.units,
    currency: dataset.currency,
    allowed_fields: dataset.allowed_fields,
    metrics: dataset.metrics,
  });
}

function withSchemaDigest(dataset) {
  return { ...dataset, schema_digest: datasetSchemaDigest(dataset) };
}

function catalogDigest(manifest) {
  return digestOf({
    product_id: manifest.product_id,
    protocol: manifest.protocol,
    capabilities: manifest.capabilities,
    datasets: manifest.datasets,
    event_families: manifest.event_families,
  });
}

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) (seen.has(value) ? dupes : seen).add(value);
  return [...dupes];
}

function catalogErrors(manifest) {
  const errors = [];
  const capabilities = manifest.capabilities || [];
  const datasets = manifest.datasets || [];
  const families = manifest.event_families || [];
  for (const dupe of duplicates(capabilities.map((c) => c.id))) errors.push("DUPLICATE_CAPABILITY:" + dupe);
  for (const dupe of duplicates(datasets.map((d) => d.dataset_id))) errors.push("DUPLICATE_DATASET:" + dupe);
  for (const dupe of duplicates(families.map((f) => f.family))) errors.push("DUPLICATE_EVENT_FAMILY:" + dupe);
  const datasetIds = new Set(datasets.map((d) => d.dataset_id));
  for (const cap of capabilities) {
    if (!P.USABLE_CAPABILITY_STATES.includes(cap.state) && cap.blockers.length === 0) errors.push("BLOCKED_WITHOUT_REASON:" + cap.id);
    if (cap.kind === "COMMAND" && cap.request_schema === null && P.USABLE_CAPABILITY_STATES.includes(cap.state)) errors.push("COMMAND_WITHOUT_SCHEMA:" + cap.id);
    if (cap.kind !== "COMMAND" && cap.request_schema !== null) errors.push("SCHEMA_ON_NON_COMMAND:" + cap.id);
    if (cap.request_schema) {
      try {
        checkSchema(cap.request_schema);
        if (cap.request_schema.type !== "object" || cap.request_schema.additionalProperties !== false) errors.push("COMMAND_SCHEMA_NOT_CLOSED:" + cap.id);
      } catch { errors.push("COMMAND_SCHEMA_INVALID:" + cap.id); }
    }
    for (const ds of cap.datasets) if (!datasetIds.has(ds)) errors.push("CAPABILITY_UNKNOWN_DATASET:" + cap.id);
  }
  for (const ds of datasets) {
    if (ds.schema_digest !== datasetSchemaDigest(ds)) errors.push("DATASET_SCHEMA_DIGEST_MISMATCH:" + ds.dataset_id);
    if (ds.readiness !== "CERTIFIED_BY_PRODUCT" && ds.blockers.length === 0) errors.push("DATASET_BLOCKED_WITHOUT_REASON:" + ds.dataset_id);
    for (const dupe of duplicates(ds.allowed_fields.map((f) => f.name))) errors.push("DUPLICATE_FIELD:" + ds.dataset_id + "." + dupe);
    for (const dupe of duplicates(ds.metrics.map((m) => m.metric_id))) errors.push("DUPLICATE_METRIC:" + ds.dataset_id + "." + dupe);
    for (const m of ds.metrics) {
      if (m.currency && ds.currency && m.currency !== ds.currency) errors.push("METRIC_CURRENCY_CONFLICT:" + m.metric_id);
    }
    const ranks = P.PRIVACY_CLASSES;
    for (const f of ds.allowed_fields) {
      if (ranks.indexOf(f.classification) > ranks.indexOf(ds.privacy_class)) errors.push("FIELD_EXCEEDS_DATASET_CLASSIFICATION:" + ds.dataset_id + "." + f.name);
    }
  }
  for (const fam of families) {
    if (!datasetIds.has(fam.dataset_id)) errors.push("EVENT_FAMILY_UNKNOWN_DATASET:" + fam.family);
    try {
      checkSchema(fam.payload_schema);
      if (fam.payload_schema.type !== "object" || fam.payload_schema.additionalProperties !== false) errors.push("EVENT_PAYLOAD_SCHEMA_NOT_CLOSED:" + fam.family);
    } catch { errors.push("EVENT_PAYLOAD_SCHEMA_INVALID:" + fam.family); }
    const ds = datasets.find((d) => d.dataset_id === fam.dataset_id);
    if (ds && P.PRIVACY_CLASSES.indexOf(fam.classification) > P.PRIVACY_CLASSES.indexOf(ds.privacy_class)) errors.push("EVENT_EXCEEDS_DATASET_CLASSIFICATION:" + fam.family);
    if (fam.projection === "METRIC_OBSERVATION" && JSON.stringify(fam.payload_schema) !== JSON.stringify(S.metricObservationPayload)) {
      errors.push("METRIC_OBSERVATION_SCHEMA_NOT_STANDARD:" + fam.family);
    }
  }
  return errors;
}

function findDataset(manifest, datasetId) {
  return (manifest.datasets || []).find((d) => d.dataset_id === datasetId) || null;
}

function findMetric(manifest, metricId) {
  for (const ds of manifest.datasets || []) {
    const metric = ds.metrics.find((m) => m.metric_id === metricId);
    if (metric) return { dataset: ds, metric };
  }
  return null;
}

// The standard, product-neutral metric observation event family. Every
// Product Admin that publishes metrics to HQ uses exactly this payload schema.
function standardMetricObservationFamily({ family, datasetId, classification = "INTERNAL", schemaVersion = "1.0.0", status = "ACTIVE" }) {
  return {
    family,
    schema_id: "cosmicforge.metric-observation",
    schema_version: schemaVersion,
    dataset_id: datasetId,
    classification,
    projection: "METRIC_OBSERVATION",
    payload_schema: JSON.parse(JSON.stringify(S.metricObservationPayload)),
    status,
    sunset_at: null,
    version_policy: "MAJOR_FOR_BREAKING",
  };
}

module.exports = { standardMetricObservationFamily, datasetSchemaDigest, withSchemaDigest, catalogDigest, catalogErrors, findDataset, findMetric };
