"use strict";

// Contract revision compatibility. Nothing here activates anything: the
// result only tells the registry whether a reviewed activation is possible.
//
//   IDENTICAL            same catalog digest
//   COMPATIBLE_ADDITIVE  purely additive, with the required minor bumps
//   BREAKING             anything that changes meaning, grain, currency,
//                        scope, authorization or removes something

const P = require("./protocol");
const { digestOf } = require("./canonical");

const catalogPart = (c) => ({ product_id: c.product_id, protocol: c.protocol, capabilities: c.capabilities, datasets: c.datasets, event_families: c.event_families });

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  if (!match) throw new Error("invalid_semver");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function cmpSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

const json = (value) => JSON.stringify(value);
const sameSet = (a, b) => json([...a].sort()) === json([...b].sort());

function compareFields(before, after, path, add) {
  const prev = new Map(before.map((f) => [f.name, f]));
  const next = new Map(after.map((f) => [f.name, f]));
  let added = 0;
  for (const [name, field] of prev) {
    const other = next.get(name);
    if (!other) add("BREAKING", "FIELD_REMOVED", path + "." + name);
    else if (field.type !== other.type) add("BREAKING", "FIELD_TYPE_CHANGED", path + "." + name);
    else if (field.meaning !== other.meaning) add("BREAKING", "FIELD_MEANING_CHANGED", path + "." + name);
    else if (field.unit !== other.unit) add("BREAKING", "FIELD_UNIT_CHANGED", path + "." + name);
    else if (field.classification !== other.classification) add("BREAKING", "FIELD_CLASSIFICATION_CHANGED", path + "." + name);
  }
  for (const name of next.keys()) if (!prev.has(name)) { added += 1; add("ADDITIVE", "FIELD_ADDED", path + "." + name); }
  return added;
}

function compareMetrics(before, after, path, add) {
  const prev = new Map(before.map((m) => [m.metric_id, m]));
  const next = new Map(after.map((m) => [m.metric_id, m]));
  let added = 0;
  for (const [metricId, metric] of prev) {
    const other = next.get(metricId);
    if (!other) { add("BREAKING", "METRIC_REMOVED", path + "." + metricId); continue; }
    for (const key of ["definition", "aggregation", "grain", "unit", "currency"]) {
      if (metric[key] !== other[key]) add("BREAKING", "METRIC_" + key.toUpperCase() + "_CHANGED", path + "." + metricId);
    }
    if (metric.version !== other.version && parseSemver(metric.version).major === parseSemver(other.version).major &&
        ["definition", "aggregation", "grain", "unit", "currency"].some((key) => metric[key] !== other[key])) {
      add("BREAKING", "METRIC_MEANING_CHANGED_WITHOUT_MAJOR", path + "." + metricId);
    }
    if (metric.version !== other.version) {
      add(cmpSemver(other.version, metric.version) < 0 ? "BREAKING" : "ADDITIVE", cmpSemver(other.version, metric.version) < 0 ? "METRIC_VERSION_DOWNGRADE" : "METRIC_VERSION_CHANGED", path + "." + metricId);
    }
  }
  for (const metricId of next.keys()) if (!prev.has(metricId)) { added += 1; add("ADDITIVE", "METRIC_ADDED", path + "." + metricId); }
  return added;
}

function payloadSchemaChange(before, after) {
  if (json(before) === json(after)) return "SAME";
  const prevProps = before.properties || {};
  const nextProps = after.properties || {};
  const prevRequired = new Set(before.required || []);
  const nextRequired = new Set(after.required || []);
  for (const key of Object.keys(prevProps)) {
    if (!nextProps[key] || json(prevProps[key]) !== json(nextProps[key])) return "BREAKING";
  }
  for (const key of nextRequired) if (!prevRequired.has(key)) return "BREAKING";
  for (const key of Object.keys(before)) {
    if (!["properties", "required"].includes(key) && json(before[key]) !== json(after[key])) return "BREAKING";
  }
  return "ADDITIVE";
}

function compareCatalogs(pinned, proposed) {
  const changes = [];
  const add = (severity, kind, path) => changes.push({ severity, kind, path });

  if (pinned.product_id !== proposed.product_id) add("BREAKING", "PRODUCT_CHANGED", "product_id");
  if (pinned.protocol.major !== proposed.protocol.major) add("BREAKING", "PROTOCOL_MAJOR_CHANGED", "protocol");
  else if (proposed.protocol.minor < pinned.protocol.minor) add("BREAKING", "PROTOCOL_MINOR_DOWNGRADE", "protocol");
  else if (proposed.protocol.minor > pinned.protocol.minor) add("ADDITIVE", "PROTOCOL_MINOR_UPGRADE", "protocol");

  // Datasets
  const prevDs = new Map(pinned.datasets.map((d) => [d.dataset_id, d]));
  const nextDs = new Map(proposed.datasets.map((d) => [d.dataset_id, d]));
  for (const [datasetId, ds] of prevDs) {
    const other = nextDs.get(datasetId);
    const path = "datasets." + datasetId;
    if (!other) { add("BREAKING", "DATASET_REMOVED", path); continue; }
    const before = changes.length;
    if (ds.privacy_class !== other.privacy_class) add("BREAKING", "DATASET_PRIVACY_CHANGED", path);
    if (!sameSet(ds.scope_dimensions, other.scope_dimensions)) add("BREAKING", "DATASET_SCOPE_CHANGED", path);
    if (!sameSet(ds.authorized_departments, other.authorized_departments)) add("BREAKING", "DATASET_AUTHORIZATION_CHANGED", path);
    if (ds.semantic_grain !== other.semantic_grain) add("BREAKING", "DATASET_GRAIN_CHANGED", path);
    if (!sameSet(ds.units, other.units)) add("BREAKING", "DATASET_UNITS_CHANGED", path);
    if (ds.currency !== other.currency) add("BREAKING", "DATASET_CURRENCY_CHANGED", path);
    if (ds.schema_id !== other.schema_id) add("BREAKING", "DATASET_SCHEMA_ID_CHANGED", path);
    const addedFields = compareFields(ds.allowed_fields, other.allowed_fields, path, add);
    const addedMetrics = compareMetrics(ds.metrics, other.metrics, path, add);
    const breakingHere = changes.slice(before).some((c) => c.severity === "BREAKING");
    const versionCmp = cmpSemver(other.version, ds.version);
    const majorBumped = parseSemver(other.version).major > parseSemver(ds.version).major;
    if (versionCmp < 0) add("BREAKING", "DATASET_VERSION_DOWNGRADE", path);
    if (breakingHere && !majorBumped) add("BREAKING", "BREAKING_CHANGE_WITHOUT_MAJOR_VERSION", path);
    if ((addedFields || addedMetrics) && versionCmp <= 0) add("BREAKING", "ADDITIVE_CHANGE_WITHOUT_VERSION_BUMP", path);
    if (!breakingHere && !addedFields && !addedMetrics && ds.schema_digest !== other.schema_digest && versionCmp === 0) {
      add("BREAKING", "SILENT_SCHEMA_CHANGE", path);
    }
    if (versionCmp > 0 && !breakingHere) add("ADDITIVE", "DATASET_VERSION_BUMPED", path);
    if (ds.readiness !== other.readiness) add("ADDITIVE", "DATASET_READINESS_CHANGED", path);
    if (json(ds.lineage) !== json(other.lineage)) add("ADDITIVE", "DATASET_LINEAGE_CHANGED", path);
    if (ds.title !== other.title || json(ds.blockers || []) !== json(other.blockers || [])) add("ADDITIVE", "DATASET_METADATA_CHANGED", path);
    if (ds.freshness_target_seconds !== other.freshness_target_seconds || ds.retention_days !== other.retention_days) {
      add("ADDITIVE", "DATASET_POLICY_METADATA_CHANGED", path);
    }
  }
  for (const datasetId of nextDs.keys()) if (!prevDs.has(datasetId)) add("ADDITIVE", "DATASET_ADDED", "datasets." + datasetId);

  // Event families
  const prevFam = new Map(pinned.event_families.map((f) => [f.family, f]));
  const nextFam = new Map(proposed.event_families.map((f) => [f.family, f]));
  for (const [family, fam] of prevFam) {
    const other = nextFam.get(family);
    const path = "event_families." + family;
    if (!other) { add("BREAKING", "EVENT_FAMILY_REMOVED", path); continue; }
    const majorBumped = parseSemver(other.schema_version).major > parseSemver(fam.schema_version).major;
    for (const key of ["schema_id", "dataset_id", "classification", "projection"]) {
      if (fam[key] !== other[key]) add("BREAKING", "EVENT_" + key.toUpperCase() + "_CHANGED", path);
    }
    const payload = payloadSchemaChange(fam.payload_schema, other.payload_schema);
    if (payload === "BREAKING") add("BREAKING", majorBumped ? "EVENT_SCHEMA_MAJOR_CHANGE" : "EVENT_SCHEMA_BREAKING_WITHOUT_MAJOR", path);
    if (payload === "ADDITIVE") add(cmpSemver(other.schema_version, fam.schema_version) > 0 ? "ADDITIVE" : "BREAKING", "EVENT_SCHEMA_EXTENDED", path);
    if (cmpSemver(other.schema_version, fam.schema_version) < 0) add("BREAKING", "EVENT_SCHEMA_VERSION_DOWNGRADE", path);
    if (fam.status !== other.status) add("ADDITIVE", "EVENT_FAMILY_STATUS_CHANGED", path);
    if ((fam.sunset_at || null) !== (other.sunset_at || null)) add("ADDITIVE", "EVENT_FAMILY_SUNSET_CHANGED", path);
    if (payload === "SAME" && cmpSemver(other.schema_version, fam.schema_version) > 0) add("ADDITIVE", "EVENT_SCHEMA_VERSION_BUMPED", path);
  }
  for (const family of nextFam.keys()) if (!prevFam.has(family)) add("ADDITIVE", "EVENT_FAMILY_ADDED", "event_families." + family);

  // Capabilities: a state change is an authorization change and always
  // requires review; removal is breaking.
  const prevCap = new Map(pinned.capabilities.map((c) => [c.id, c]));
  const nextCap = new Map(proposed.capabilities.map((c) => [c.id, c]));
  for (const [capId, cap] of prevCap) {
    const other = nextCap.get(capId);
    const path = "capabilities." + capId;
    if (!other) { add("BREAKING", "CAPABILITY_REMOVED", path); continue; }
    if (cap.kind !== other.kind || cap.risk !== other.risk) add("BREAKING", "CAPABILITY_SEMANTICS_CHANGED", path);
    if (json(cap.request_schema) !== json(other.request_schema)) add("BREAKING", "CAPABILITY_REQUEST_SCHEMA_CHANGED", path);
    if (cap.state !== other.state) add("ADDITIVE", "CAPABILITY_STATE_CHANGED", path);
    if (!sameSet(cap.datasets, other.datasets)) add("BREAKING", "CAPABILITY_DATASETS_CHANGED", path);
    // MFA and independent-approval requirements are authorization rules:
    // any change, tightening or loosening, is breaking.
    if (Boolean(cap.requires_recent_mfa) !== Boolean(other.requires_recent_mfa) ||
        Boolean(cap.requires_independent_approval) !== Boolean(other.requires_independent_approval)) {
      add("BREAKING", "CAPABILITY_AUTHORIZATION_CHANGED", path);
    }
    if (cap.version !== other.version || cap.description !== other.description || json(cap.blockers || []) !== json(other.blockers || [])) {
      add("ADDITIVE", "CAPABILITY_METADATA_CHANGED", path);
    }
  }
  for (const capId of nextCap.keys()) if (!prevCap.has(capId)) add("ADDITIVE", "CAPABILITY_ADDED", "capabilities." + capId);

  // Anything not classified above but still different must never pass as
  // IDENTICAL: an unrecognised difference is treated as breaking.
  if (changes.length === 0 && digestOf(catalogPart(pinned)) !== digestOf(catalogPart(proposed))) {
    add("BREAKING", "UNCLASSIFIED_CHANGE", "catalog");
  }

  const breaking = changes.some((c) => c.severity === "BREAKING");
  const decision = breaking ? "BREAKING" : changes.length ? "COMPATIBLE_ADDITIVE" : "IDENTICAL";
  return { decision, changes };
}

// Whether a proposed revision may be activated on an existing registration.
// Breaking revisions never activate in place: they need a new major contract
// onboarded with an explicit dual-read migration plan.
function activationDecision(comparison, { reviewed = false, dualReadPlan = null } = {}) {
  if (comparison.decision === "IDENTICAL") return { allowed: true, reason: "IDENTICAL" };
  if (comparison.decision === "COMPATIBLE_ADDITIVE") {
    return reviewed ? { allowed: true, reason: "REVIEWED_ADDITIVE" } : { allowed: false, reason: "REVIEW_REQUIRED" };
  }
  const protocolMajor = comparison.changes.some((c) => c.kind === "PROTOCOL_MAJOR_CHANGED");
  if (!dualReadPlan) return { allowed: false, reason: protocolMajor ? "NEW_MAJOR_REQUIRES_ONBOARDING" : "BREAKING_CHANGE_REJECTED" };
  return { allowed: false, reason: "DUAL_READ_PLAN_REQUIRES_NEW_REGISTRATION" };
}

function isKnownContractVersion(version) {
  return version === P.CONTRACT_VERSION;
}

module.exports = { parseSemver, cmpSemver, compareCatalogs, activationDecision, isKnownContractVersion };
