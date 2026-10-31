"use strict";

// Contract revision compatibility. Nothing here activates anything: the
// result only tells the registry whether a reviewed activation is possible.
//
//   IDENTICAL            same canonical catalog
//   COMPATIBLE_ADDITIVE  purely additive, with the required minor bumps
//   BREAKING             anything that changes meaning, grain, currency,
//                        scope, authorization or removes something, and any
//                        difference no rule below recognises
//
// Exhaustive change accounting: every rule records the keys it classified.
// After the rules run, every pair of matched objects (catalog, protocol,
// dataset, field, metric, event family, capability) is compared key by key in
// canonical form; any difference no rule accounted for is UNCLASSIFIED_CHANGE
// and breaking, even when other, recognised changes were found too.

const P = require("./protocol");
const { canonicalize } = require("./canonical");
const { datasetSchemaDigest } = require("./catalog");

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

// Canonical equality: key order never matters, everything else does. Absent
// and undefined are the same (as in the signed canonical form); a value that
// cannot be canonicalized is never equal to anything.
let uncanonical = 0;
function canon(value) {
  if (value === undefined) return "\u0000absent";
  try { return canonicalize(value); } catch { uncanonical += 1; return "\u0000invalid:" + uncanonical; }
}
const same = (a, b) => canon(a) === canon(b);
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && canon(a.map(canon).sort()) === canon(b.map(canon).sort());
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function createLedger() {
  const changes = [];
  const covered = new Map();
  const cover = (scope, keys) => {
    let set = covered.get(scope);
    if (!set) covered.set(scope, (set = new Set()));
    for (const key of keys) set.add(key);
  };
  // Records a classified change and marks the keys it accounts for.
  const add = (severity, kind, path, scope = null, keys = []) => {
    changes.push({ severity, kind, path });
    if (scope) cover(scope, keys);
  };
  // Every key of a matched pair whose canonical value differs and that no
  // rule accounted for is an unclassified, breaking change.
  const residual = (scope, path, before, after) => {
    if (!isObject(before) || !isObject(after)) {
      if (!same(before, after)) add("BREAKING", "UNCLASSIFIED_CHANGE", path);
      return;
    }
    const done = covered.get(scope) || new Set();
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      if (done.has(key) || same(before[key], after[key])) continue;
      add("BREAKING", "UNCLASSIFIED_CHANGE", path + "." + key, scope, [key]);
    }
  };
  return { changes, add, cover, residual };
}

// Indexes an entity list by its identifier. A missing list, a non-object
// entry, a missing identifier or a duplicate identifier is breaking: the
// comparison could otherwise silently lose an entry. A change in the relative
// order of entries present in both lists is unclassified (and so breaking),
// exactly as it was when no other change accompanied it.
function indexPair(ledger, before, after, idKey, path) {
  const index = (list, side) => {
    const map = new Map();
    if (!Array.isArray(list)) { ledger.add("BREAKING", "CATALOG_SECTION_INVALID", path + "[" + side + "]"); return map; }
    for (const item of list) {
      const id = isObject(item) ? item[idKey] : undefined;
      if (typeof id !== "string" || id.length === 0) { ledger.add("BREAKING", "CATALOG_ENTRY_INVALID", path + "[" + side + "]"); continue; }
      if (map.has(id)) { ledger.add("BREAKING", "DUPLICATE_CATALOG_ENTRY", path + "." + id); continue; }
      map.set(id, item);
    }
    return map;
  };
  const prev = index(before, "pinned");
  const next = index(after, "proposed");
  const prevOrder = [...prev.keys()].filter((id) => next.has(id));
  const nextOrder = [...next.keys()].filter((id) => prev.has(id));
  if (!same(prevOrder, nextOrder)) ledger.add("BREAKING", "UNCLASSIFIED_CHANGE", path + "[order]");
  return { prev, next };
}

function compareFields(ledger, before, after, path, scope) {
  const { add, residual } = ledger;
  const { prev, next } = indexPair(ledger, before, after, "name", path + ".allowed_fields");
  let added = 0;
  for (const [name, field] of prev) {
    const other = next.get(name);
    const fpath = path + "." + name;
    const fscope = scope + "/field:" + name;
    if (!other) { add("BREAKING", "FIELD_REMOVED", fpath); continue; }
    ledger.cover(fscope, ["name"]);
    if (field.type !== other.type) add("BREAKING", "FIELD_TYPE_CHANGED", fpath, fscope, ["type"]);
    if (field.meaning !== other.meaning) add("BREAKING", "FIELD_MEANING_CHANGED", fpath, fscope, ["meaning"]);
    if (field.unit !== other.unit) add("BREAKING", "FIELD_UNIT_CHANGED", fpath, fscope, ["unit"]);
    if (field.classification !== other.classification) add("BREAKING", "FIELD_CLASSIFICATION_CHANGED", fpath, fscope, ["classification"]);
    residual(fscope, fpath, field, other);
  }
  for (const name of next.keys()) if (!prev.has(name)) { added += 1; add("ADDITIVE", "FIELD_ADDED", path + "." + name); }
  return added;
}

const METRIC_MEANING = ["definition", "aggregation", "grain", "unit", "currency"];

function compareMetrics(ledger, before, after, path, scope) {
  const { add, residual } = ledger;
  const { prev, next } = indexPair(ledger, before, after, "metric_id", path + ".metrics");
  let added = 0;
  for (const [metricId, metric] of prev) {
    const other = next.get(metricId);
    const mpath = path + "." + metricId;
    const mscope = scope + "/metric:" + metricId;
    if (!other) { add("BREAKING", "METRIC_REMOVED", mpath); continue; }
    ledger.cover(mscope, ["metric_id"]);
    for (const key of METRIC_MEANING) {
      if (metric[key] !== other[key]) add("BREAKING", "METRIC_" + key.toUpperCase() + "_CHANGED", mpath, mscope, [key]);
    }
    if (metric.version !== other.version) {
      const cmp = cmpSemver(other.version, metric.version);
      if (cmp !== 0) {
        if (parseSemver(metric.version).major === parseSemver(other.version).major && METRIC_MEANING.some((key) => metric[key] !== other[key])) {
          add("BREAKING", "METRIC_MEANING_CHANGED_WITHOUT_MAJOR", mpath);
        }
        add(cmp < 0 ? "BREAKING" : "ADDITIVE", cmp < 0 ? "METRIC_VERSION_DOWNGRADE" : "METRIC_VERSION_CHANGED", mpath, mscope, ["version"]);
      }
    }
    residual(mscope, mpath, metric, other);
  }
  for (const metricId of next.keys()) if (!prev.has(metricId)) { added += 1; add("ADDITIVE", "METRIC_ADDED", path + "." + metricId); }
  return added;
}

// An event payload schema may only gain optional properties. Changing or
// removing a property, adding or dropping a required property, or changing
// or adding any other schema keyword is breaking.
function payloadSchemaChange(before, after) {
  if (same(before, after)) return "SAME";
  if (!isObject(before) || !isObject(after)) return "BREAKING";
  if ((before.properties !== undefined && !isObject(before.properties)) || (after.properties !== undefined && !isObject(after.properties))) return "BREAKING";
  const prevProps = before.properties || {};
  const nextProps = after.properties || {};
  for (const key of Object.keys(prevProps)) {
    if (!Object.prototype.hasOwnProperty.call(nextProps, key) || !same(prevProps[key], nextProps[key])) return "BREAKING";
  }
  if (!sameSet(before.required || [], after.required || [])) return "BREAKING";
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== "properties" && key !== "required" && !same(before[key], after[key])) return "BREAKING";
  }
  return "ADDITIVE";
}

function compareProtocol(ledger, pinned, proposed) {
  const { add, residual } = ledger;
  const before = isObject(pinned) ? pinned : {};
  const after = isObject(proposed) ? proposed : {};
  const minors = Number.isInteger(before.minor) && Number.isInteger(after.minor);
  if (before.major !== after.major) add("BREAKING", "PROTOCOL_MAJOR_CHANGED", "protocol", "protocol", ["major", "minor"]);
  else if (minors && after.minor < before.minor) add("BREAKING", "PROTOCOL_MINOR_DOWNGRADE", "protocol", "protocol", ["minor"]);
  else if (minors && after.minor > before.minor) add("ADDITIVE", "PROTOCOL_MINOR_UPGRADE", "protocol", "protocol", ["minor"]);
  residual("protocol", "protocol", pinned, proposed);
}

const LINEAGE_KEYS = ["source_system", "source_owner", "derivation"];

function compareDatasets(ledger, pinned, proposed) {
  const { changes, add, residual } = ledger;
  const { prev, next } = indexPair(ledger, pinned, proposed, "dataset_id", "datasets");
  for (const [datasetId, ds] of prev) {
    const other = next.get(datasetId);
    const path = "datasets." + datasetId;
    const scope = "dataset:" + datasetId;
    if (!other) { add("BREAKING", "DATASET_REMOVED", path); continue; }
    const before = changes.length;
    if (ds.privacy_class !== other.privacy_class) add("BREAKING", "DATASET_PRIVACY_CHANGED", path, scope, ["privacy_class"]);
    if (!sameSet(ds.scope_dimensions, other.scope_dimensions)) add("BREAKING", "DATASET_SCOPE_CHANGED", path, scope, ["scope_dimensions"]);
    if (!sameSet(ds.authorized_departments, other.authorized_departments)) add("BREAKING", "DATASET_AUTHORIZATION_CHANGED", path, scope, ["authorized_departments"]);
    if (ds.semantic_grain !== other.semantic_grain) add("BREAKING", "DATASET_GRAIN_CHANGED", path, scope, ["semantic_grain"]);
    if (!sameSet(ds.units, other.units)) add("BREAKING", "DATASET_UNITS_CHANGED", path, scope, ["units"]);
    if (ds.currency !== other.currency) add("BREAKING", "DATASET_CURRENCY_CHANGED", path, scope, ["currency"]);
    if (ds.schema_id !== other.schema_id) add("BREAKING", "DATASET_SCHEMA_ID_CHANGED", path, scope, ["schema_id"]);
    // Nested lists are compared exhaustively, each with its own residual check.
    const addedFields = compareFields(ledger, ds.allowed_fields, other.allowed_fields, path, scope);
    const addedMetrics = compareMetrics(ledger, ds.metrics, other.metrics, path, scope);
    ledger.cover(scope, ["dataset_id", "allowed_fields", "metrics"]);
    const breakingHere = changes.slice(before).some((c) => c.severity === "BREAKING");
    const versionCmp = cmpSemver(other.version, ds.version);
    const majorBumped = parseSemver(other.version).major > parseSemver(ds.version).major;
    if (versionCmp !== 0) ledger.cover(scope, ["version"]);
    if (versionCmp < 0) add("BREAKING", "DATASET_VERSION_DOWNGRADE", path);
    if (breakingHere && !majorBumped) add("BREAKING", "BREAKING_CHANGE_WITHOUT_MAJOR_VERSION", path);
    if ((addedFields || addedMetrics) && versionCmp <= 0) add("BREAKING", "ADDITIVE_CHANGE_WITHOUT_VERSION_BUMP", path);
    // The schema digest is derived from the fields above. A difference is
    // accounted for only when both digests match their own definitions.
    if (ds.schema_digest !== other.schema_digest) {
      let consistent = false;
      try { consistent = ds.schema_digest === datasetSchemaDigest(ds) && other.schema_digest === datasetSchemaDigest(other); } catch { consistent = false; }
      if (!consistent) add("BREAKING", "DATASET_SCHEMA_DIGEST_INVALID", path, scope, ["schema_digest"]);
      else if (!breakingHere && !addedFields && !addedMetrics && versionCmp === 0) add("BREAKING", "SILENT_SCHEMA_CHANGE", path, scope, ["schema_digest"]);
      else ledger.cover(scope, ["schema_digest"]);
    }
    if (versionCmp > 0 && !breakingHere) add("ADDITIVE", "DATASET_VERSION_BUMPED", path);
    if (ds.readiness !== other.readiness) add("ADDITIVE", "DATASET_READINESS_CHANGED", path, scope, ["readiness"]);
    // Lineage is descriptive metadata: its known keys are additive (review
    // required); any other lineage key is unclassified.
    const lineageScope = scope + "/lineage";
    if (LINEAGE_KEYS.some((key) => !same((ds.lineage || {})[key], (other.lineage || {})[key]))) {
      add("ADDITIVE", "DATASET_LINEAGE_CHANGED", path, lineageScope, LINEAGE_KEYS);
    }
    ledger.residual(lineageScope, path + ".lineage", ds.lineage, other.lineage);
    ledger.cover(scope, ["lineage"]);
    if (ds.title !== other.title || !same(ds.blockers || [], other.blockers || [])) add("ADDITIVE", "DATASET_METADATA_CHANGED", path, scope, ["title", "blockers"]);
    if (ds.freshness_target_seconds !== other.freshness_target_seconds || ds.retention_days !== other.retention_days) {
      add("ADDITIVE", "DATASET_POLICY_METADATA_CHANGED", path, scope, ["freshness_target_seconds", "retention_days"]);
    }
    residual(scope, path, ds, other);
  }
  for (const datasetId of next.keys()) if (!prev.has(datasetId)) add("ADDITIVE", "DATASET_ADDED", "datasets." + datasetId);
}

function compareEventFamilies(ledger, pinned, proposed) {
  const { add, residual } = ledger;
  const { prev, next } = indexPair(ledger, pinned, proposed, "family", "event_families");
  for (const [family, fam] of prev) {
    const other = next.get(family);
    const path = "event_families." + family;
    const scope = "family:" + family;
    if (!other) { add("BREAKING", "EVENT_FAMILY_REMOVED", path); continue; }
    ledger.cover(scope, ["family"]);
    const versionCmp = cmpSemver(other.schema_version, fam.schema_version);
    const majorBumped = parseSemver(other.schema_version).major > parseSemver(fam.schema_version).major;
    for (const key of ["schema_id", "dataset_id", "classification", "projection"]) {
      if (fam[key] !== other[key]) add("BREAKING", "EVENT_" + key.toUpperCase() + "_CHANGED", path, scope, [key]);
    }
    if (fam.version_policy !== other.version_policy) add("BREAKING", "EVENT_VERSION_POLICY_CHANGED", path, scope, ["version_policy"]);
    const payload = payloadSchemaChange(fam.payload_schema, other.payload_schema);
    if (payload === "BREAKING") add("BREAKING", majorBumped ? "EVENT_SCHEMA_MAJOR_CHANGE" : "EVENT_SCHEMA_BREAKING_WITHOUT_MAJOR", path, scope, ["payload_schema"]);
    if (payload === "ADDITIVE") add(versionCmp > 0 ? "ADDITIVE" : "BREAKING", "EVENT_SCHEMA_EXTENDED", path, scope, ["payload_schema"]);
    if (versionCmp !== 0) ledger.cover(scope, ["schema_version"]);
    if (versionCmp < 0) add("BREAKING", "EVENT_SCHEMA_VERSION_DOWNGRADE", path);
    if (fam.status !== other.status) add("ADDITIVE", "EVENT_FAMILY_STATUS_CHANGED", path, scope, ["status"]);
    if ((fam.sunset_at || null) !== (other.sunset_at || null)) add("ADDITIVE", "EVENT_FAMILY_SUNSET_CHANGED", path, scope, ["sunset_at"]);
    if (payload === "SAME" && versionCmp > 0) add("ADDITIVE", "EVENT_SCHEMA_VERSION_BUMPED", path);
    residual(scope, path, fam, other);
  }
  for (const family of next.keys()) if (!prev.has(family)) add("ADDITIVE", "EVENT_FAMILY_ADDED", "event_families." + family);
}

// Capabilities: a state change is an authorization change and always
// requires review; removal is breaking.
function compareCapabilities(ledger, pinned, proposed) {
  const { add, residual } = ledger;
  const { prev, next } = indexPair(ledger, pinned, proposed, "id", "capabilities");
  for (const [capId, cap] of prev) {
    const other = next.get(capId);
    const path = "capabilities." + capId;
    const scope = "capability:" + capId;
    if (!other) { add("BREAKING", "CAPABILITY_REMOVED", path); continue; }
    ledger.cover(scope, ["id"]);
    if (cap.kind !== other.kind || cap.risk !== other.risk) add("BREAKING", "CAPABILITY_SEMANTICS_CHANGED", path, scope, ["kind", "risk"]);
    if (!same(cap.request_schema, other.request_schema)) add("BREAKING", "CAPABILITY_REQUEST_SCHEMA_CHANGED", path, scope, ["request_schema"]);
    if (cap.state !== other.state) add("ADDITIVE", "CAPABILITY_STATE_CHANGED", path, scope, ["state"]);
    if (!sameSet(cap.datasets, other.datasets)) add("BREAKING", "CAPABILITY_DATASETS_CHANGED", path, scope, ["datasets"]);
    // MFA and independent-approval requirements are authorization rules:
    // any change, tightening or loosening, is breaking.
    if (cap.requires_recent_mfa !== other.requires_recent_mfa || cap.requires_independent_approval !== other.requires_independent_approval) {
      add("BREAKING", "CAPABILITY_AUTHORIZATION_CHANGED", path, scope, ["requires_recent_mfa", "requires_independent_approval"]);
    }
    if (cap.version !== other.version || cap.description !== other.description || !same(cap.blockers || [], other.blockers || [])) {
      add("ADDITIVE", "CAPABILITY_METADATA_CHANGED", path, scope, ["version", "description", "blockers"]);
    }
    residual(scope, path, cap, other);
  }
  for (const capId of next.keys()) if (!prev.has(capId)) add("ADDITIVE", "CAPABILITY_ADDED", "capabilities." + capId);
}

function compareCatalogs(pinned, proposed) {
  const ledger = createLedger();
  const { changes, add } = ledger;
  const before = catalogPart(pinned || {});
  const after = catalogPart(proposed || {});

  if (before.product_id !== after.product_id) add("BREAKING", "PRODUCT_CHANGED", "product_id", "catalog", ["product_id"]);
  compareProtocol(ledger, before.protocol, after.protocol);
  try {
    compareDatasets(ledger, before.datasets, after.datasets);
    compareEventFamilies(ledger, before.event_families, after.event_families);
    compareCapabilities(ledger, before.capabilities, after.capabilities);
  } catch {
    // A malformed version or entry that a rule cannot evaluate can never be
    // accepted: fail closed instead of returning a partial classification.
    add("BREAKING", "UNCLASSIFIED_CHANGE", "catalog");
  }
  ledger.cover("catalog", ["protocol", "datasets", "event_families", "capabilities"]);
  ledger.residual("catalog", "catalog", before, after);

  // Defence in depth: a canonical difference with no recorded change at all
  // must never be reported as IDENTICAL.
  if (changes.length === 0 && !same(before, after)) add("BREAKING", "UNCLASSIFIED_CHANGE", "catalog");

  const breaking = changes.some((c) => c.severity === "BREAKING");
  const decision = breaking ? "BREAKING" : changes.length ? "COMPATIBLE_ADDITIVE" : "IDENTICAL";
  return { decision, changes };
}

// Whether a proposed revision may be activated on an existing registration.
// Breaking revisions never activate in place: they need a new major contract
// onboarded with an explicit dual-read migration plan. A comparison whose
// decision does not agree with its own change list is refused.
function activationDecision(comparison, { reviewed = false, dualReadPlan = null } = {}) {
  if (!comparison || !Array.isArray(comparison.changes)) return { allowed: false, reason: "COMPARISON_INVALID" };
  const anyBreaking = comparison.changes.some((c) => !c || c.severity !== "ADDITIVE");
  if (comparison.decision === "IDENTICAL") {
    return comparison.changes.length === 0 ? { allowed: true, reason: "IDENTICAL" } : { allowed: false, reason: "COMPARISON_INVALID" };
  }
  if (comparison.decision === "COMPATIBLE_ADDITIVE") {
    if (anyBreaking || comparison.changes.length === 0) return { allowed: false, reason: "COMPARISON_INVALID" };
    return reviewed === true ? { allowed: true, reason: "REVIEWED_ADDITIVE" } : { allowed: false, reason: "REVIEW_REQUIRED" };
  }
  if (comparison.decision !== "BREAKING") return { allowed: false, reason: "COMPARISON_INVALID" };
  const protocolMajor = comparison.changes.some((c) => c && c.kind === "PROTOCOL_MAJOR_CHANGED");
  if (!dualReadPlan) return { allowed: false, reason: protocolMajor ? "NEW_MAJOR_REQUIRES_ONBOARDING" : "BREAKING_CHANGE_REJECTED" };
  return { allowed: false, reason: "DUAL_READ_PLAN_REQUIRES_NEW_REGISTRATION" };
}

function isKnownContractVersion(version) {
  return version === P.CONTRACT_VERSION;
}

module.exports = { parseSemver, cmpSemver, compareCatalogs, activationDecision, isKnownContractVersion, payloadSchemaChange };
