"use strict";

// Fail-closed contract compatibility (PR #55 review finding 1).
//
// Every difference between a pinned and a proposed catalog must be either
// classified by a known rule or reported as UNCLASSIFIED_CHANGE (breaking),
// also when recognised changes accompany it. The "known + unknown" cases below
// were reported as COMPATIBLE_ADDITIVE by the previous comparator.

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src");
const T = require("../src/testing");

const clone = (v) => JSON.parse(JSON.stringify(v));
const base = () => T.sampleManifest();
const kinds = (result) => result.changes.map((c) => c.kind);
const unclassified = (result) => result.changes.filter((c) => c.kind === "UNCLASSIFIED_CHANGE").map((c) => c.path);
const extraField = { name: "region_code", type: "string", classification: "INTERNAL", meaning: "Region", unit: null };

// A recognised additive change: dataset title (metadata, review required).
function withTitleChange(m) {
  m.datasets[0].title = "Daily activity (renamed)";
  return m;
}

function assertRefused(result, label) {
  assert.equal(result.decision, "BREAKING", label);
  assert.equal(C.activationDecision(result).allowed, false, label);
  assert.equal(C.activationDecision(result, { reviewed: true }).allowed, false, label + " (reviewed)");
}

test("identical catalogs are IDENTICAL and activate without review; key order is not a difference", () => {
  const a = base();
  const b = clone(a);
  // Re-create objects with a different key order: canonical form is unchanged.
  b.capabilities = b.capabilities.map((cap) => Object.fromEntries(Object.entries(cap).reverse()));
  b.datasets = b.datasets.map((ds) => Object.fromEntries(Object.entries(ds).reverse()));
  const result = C.compareCatalogs(a, b);
  assert.equal(result.decision, "IDENTICAL");
  assert.deepEqual(result.changes, []);
  assert.equal(C.catalogDigest(a), C.catalogDigest(b));
  assert.deepEqual(C.activationDecision(result), { allowed: true, reason: "IDENTICAL" });
});

test("purely additive revisions are COMPATIBLE_ADDITIVE and need a review to activate", () => {
  const additive = T.sampleManifest({ datasets: [T.sampleDataset({ version: "1.1.0", allowed_fields: [...T.sampleDataset().allowed_fields, extraField] })] });
  additive.datasets.push(T.sampleDataset({ dataset_id: "synthetic.weekly_activity", schema_id: "synthetic.weekly_activity", semantic_grain: "WEEK" }));
  additive.capabilities.push({ ...additive.capabilities[0], id: "synthetic.weekly.read", datasets: ["synthetic.weekly_activity"] });
  additive.event_families.push(C.standardMetricObservationFamily({ family: "synthetic.weekly_observation", datasetId: "synthetic.weekly_activity" }));
  const result = C.compareCatalogs(base(), additive);
  assert.equal(result.decision, "COMPATIBLE_ADDITIVE", JSON.stringify(result.changes));
  assert.ok(result.changes.every((c) => c.severity === "ADDITIVE"));
  for (const kind of ["FIELD_ADDED", "DATASET_VERSION_BUMPED", "DATASET_ADDED", "CAPABILITY_ADDED", "EVENT_FAMILY_ADDED"]) assert.ok(kinds(result).includes(kind), kind);
  assert.deepEqual(C.activationDecision(result), { allowed: false, reason: "REVIEW_REQUIRED" });
  assert.deepEqual(C.activationDecision(result, { reviewed: true }), { allowed: true, reason: "REVIEWED_ADDITIVE" });
  // Only an explicit boolean review counts.
  assert.equal(C.activationDecision(result, { reviewed: "yes" }).allowed, false);
});

test("purely breaking revisions are refused even when reviewed", () => {
  const removed = base();
  removed.capabilities = removed.capabilities.slice(1);
  const result = C.compareCatalogs(base(), removed);
  assert.ok(kinds(result).includes("CAPABILITY_REMOVED"));
  assertRefused(result, "capability removed");
});

test("an unknown field alone is breaking", () => {
  const next = base();
  next.capabilities[0].unreviewed_extension = true;
  const result = C.compareCatalogs(base(), next);
  assertRefused(result, "unknown field");
  assert.deepEqual(unclassified(result), ["capabilities.synthetic.metrics.read.unreviewed_extension"]);
});

test("REGRESSION: a known additive change cannot mask an unknown change anywhere in the catalog", () => {
  const placements = {
    capability: (m) => { m.capabilities[0].unreviewed_extension = true; },
    dataset: (m) => { m.datasets[0].export_destination = "https://example.invalid"; },
    field: (m) => { m.datasets[0].allowed_fields[0].pii = true; },
    metric: (m) => { m.datasets[0].metrics[0].window = "ROLLING_7D"; },
    lineage: (m) => { m.datasets[0].lineage.extra = "x"; },
    event_family: (m) => { m.event_families[0].delivery = "PUSH"; },
    protocol: (m) => { m.protocol.patch = 1; },
  };
  for (const [where, mutate] of Object.entries(placements)) {
    const additiveOnly = withTitleChange(base());
    assert.equal(C.compareCatalogs(base(), additiveOnly).decision, "COMPATIBLE_ADDITIVE", where + " baseline");
    const mixed = withTitleChange(base());
    mutate(mixed);
    const result = C.compareCatalogs(base(), mixed);
    assertRefused(result, "additive + unknown " + where);
    assert.ok(kinds(result).includes("DATASET_METADATA_CHANGED"), where + ": the recognised change is still reported");
    assert.ok(unclassified(result).length >= 1, where + ": the unknown change is reported");
  }
  // Recognised additive capability-state change + unknown change (the case in the review).
  const state = base();
  state.capabilities[1].state = "READ_ONLY";
  state.capabilities[1].unreviewed_extension = { scope: "all" };
  const result = C.compareCatalogs(base(), state);
  assert.ok(kinds(result).includes("CAPABILITY_STATE_CHANGED"));
  assertRefused(result, "state change + unknown field");
});

test("a known breaking change plus an unknown change reports both", () => {
  const next = T.sampleManifest({ datasets: [T.sampleDataset({ version: "2.0.0", privacy_class: "CONFIDENTIAL" })] });
  next.datasets[0].unreviewed_extension = 1;
  const result = C.compareCatalogs(base(), next);
  assertRefused(result, "breaking + unknown");
  assert.ok(kinds(result).includes("DATASET_PRIVACY_CHANGED"));
  assert.deepEqual(unclassified(result), ["datasets.synthetic.daily_activity.unreviewed_extension"]);
});

test("capability MFA and independent-approval changes are breaking in either direction, alone or mixed", () => {
  for (const flag of ["requires_recent_mfa", "requires_independent_approval"]) {
    for (const index of [0, 1]) {
      const next = withTitleChange(base());
      next.capabilities[index][flag] = !next.capabilities[index][flag];
      const result = C.compareCatalogs(base(), next);
      assert.ok(kinds(result).includes("CAPABILITY_AUTHORIZATION_CHANGED"), flag + index);
      assertRefused(result, flag + " on capability " + index);
    }
    // A missing flag is not silently read as "false".
    const missing = base();
    delete missing.capabilities[0][flag];
    assertRefused(C.compareCatalogs(base(), missing), flag + " removed");
  }
});

test("dataset privacy, scope, authorization and currency changes are breaking even with a major bump", () => {
  for (const change of [{ privacy_class: "CONFIDENTIAL" }, { privacy_class: "PUBLIC" }, { scope_dimensions: ["market"] }, { authorized_departments: ["finance"] }, { currency: "USD" }]) {
    const result = C.compareCatalogs(base(), T.sampleManifest({ datasets: [T.sampleDataset({ version: "2.0.0", ...change })] }));
    assertRefused(result, JSON.stringify(change));
  }
});

test("metric semantic changes are breaking", () => {
  for (const [key, value] of [["definition", "Net value after refunds"], ["aggregation", "AVG"], ["grain", "HOUR"], ["unit", "count"]]) {
    const ds = T.sampleDataset();
    ds.metrics = ds.metrics.map((m) => (m.metric_id === "synthetic.gross_value" ? { ...m, [key]: value, version: "2.0.0" } : m));
    const result = C.compareCatalogs(base(), T.sampleManifest({ datasets: [C.withSchemaDigest({ ...ds, version: "2.0.0" })] }));
    assert.ok(kinds(result).includes("METRIC_" + key.toUpperCase() + "_CHANGED"), key);
    assertRefused(result, "metric " + key);
  }
});

test("event payload schema changes: optional additions are additive with a bump; everything else is breaking", () => {
  const family = (payload, version = "1.0.0", extra = {}) => ({
    family: "synthetic.order_status", schema_id: "synthetic.order_status", schema_version: version, dataset_id: "synthetic.daily_activity",
    classification: "INTERNAL", projection: "NONE", status: "ACTIVE", sunset_at: null, version_policy: "MAJOR_FOR_BREAKING", payload_schema: payload, ...extra,
  });
  const v1 = { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", maxLength: 32 } } };
  const pinned = base();
  pinned.event_families = [family(v1)];
  const propose = (payload, version, extra) => { const m = base(); m.event_families = [family(payload, version, extra)]; return C.compareCatalogs(pinned, m); };

  const optional = { ...clone(v1), properties: { ...v1.properties, note: { type: "string", maxLength: 64 } } };
  assert.equal(propose(optional, "1.1.0").decision, "COMPATIBLE_ADDITIVE");
  assertRefused(propose(optional, "1.0.0"), "optional property without version bump");
  assertRefused(propose({ ...clone(v1), properties: { status: { type: "string", maxLength: 64 } } }, "1.1.0"), "property changed");
  assertRefused(propose({ ...clone(v1), required: ["status", "note"], properties: optional.properties }, "1.1.0"), "new required property");
  assertRefused(propose({ ...clone(v1), required: [] }, "1.1.0"), "required property dropped");
  assertRefused(propose({ ...clone(v1), patternProperties: { "^x_": { type: "string" } } }, "1.1.0"), "new schema keyword");
  assertRefused(propose({ ...clone(v1), additionalProperties: true }, "1.1.0"), "schema opened");
  assertRefused(propose(v1, "1.1.0", { version_policy: "NONE" }), "version policy changed");
  assertRefused(propose(v1, "0.9.0"), "schema version downgrade");
  // Mixed: a legitimate optional addition does not hide an unknown family key.
  assertRefused(propose(optional, "1.1.0", { delivery: "PUSH" }), "optional addition + unknown family key");
});

test("protocol versions: minor upgrade is additive, downgrade and major change are breaking; unsupported protocols are unknown", () => {
  const minor = base(); minor.protocol = { major: 1, minor: 1 };
  assert.equal(C.compareCatalogs(base(), minor).decision, "COMPATIBLE_ADDITIVE");
  const pinned11 = base(); pinned11.protocol = { major: 1, minor: 1 };
  assertRefused(C.compareCatalogs(pinned11, base()), "minor downgrade");
  const major = base(); major.protocol = { major: 2, minor: 0 };
  const result = C.compareCatalogs(base(), major);
  assertRefused(result, "major change");
  assert.equal(C.activationDecision(result).reason, "NEW_MAJOR_REQUIRES_ONBOARDING");
  const typed = base(); typed.protocol = { major: 1, minor: "0" };
  assertRefused(C.compareCatalogs(base(), typed), "minor of a different type");
  assert.equal(C.isSupportedProtocol({ major: 1, minor: 2 }), false);
  assert.equal(C.isSupportedProtocol({ major: 2, minor: 0 }), false);
});

test("set and entry ordering, duplicates and malformed sections never pass as additive", () => {
  const reorderedUnits = withTitleChange(base());
  reorderedUnits.datasets[0].units = [...reorderedUnits.datasets[0].units].reverse();
  assertRefused(C.compareCatalogs(base(), reorderedUnits), "set order + additive");
  const reorderedCaps = withTitleChange(base());
  reorderedCaps.capabilities.reverse();
  assertRefused(C.compareCatalogs(base(), reorderedCaps), "entry order + additive");
  const dupe = base();
  dupe.capabilities.push(clone(dupe.capabilities[0]));
  assert.ok(kinds(C.compareCatalogs(base(), dupe)).includes("DUPLICATE_CATALOG_ENTRY"));
  assertRefused(C.compareCatalogs(base(), dupe), "duplicate capability");
  const missing = base();
  delete missing.event_families;
  assertRefused(C.compareCatalogs(base(), missing), "missing section");
  const badVersion = base();
  badVersion.datasets[0].version = "v1";
  assertRefused(C.compareCatalogs(base(), badVersion), "malformed version");
  const badDigest = withTitleChange(base());
  badDigest.datasets[0].schema_digest = "sha256:" + "f".repeat(64);
  assert.ok(kinds(C.compareCatalogs(base(), badDigest)).includes("DATASET_SCHEMA_DIGEST_INVALID"));
});

test("activation refuses an unclassified modification and any self-inconsistent comparison", () => {
  const mixed = withTitleChange(base());
  mixed.datasets[0].allowed_fields[0].pii = true;
  const result = C.compareCatalogs(base(), mixed);
  assert.deepEqual(C.activationDecision(result, { reviewed: true }), { allowed: false, reason: "BREAKING_CHANGE_REJECTED" });
  // A stored or forged comparison whose decision disagrees with its changes.
  assert.equal(C.activationDecision({ decision: "COMPATIBLE_ADDITIVE", changes: result.changes }, { reviewed: true }).allowed, false);
  assert.equal(C.activationDecision({ decision: "IDENTICAL", changes: result.changes }).allowed, false);
  assert.equal(C.activationDecision({ decision: "COMPATIBLE_ADDITIVE", changes: [] }, { reviewed: true }).allowed, false);
  assert.equal(C.activationDecision({ decision: "SOMETHING_ELSE", changes: [] }, { reviewed: true }).allowed, false);
  assert.equal(C.activationDecision(null, { reviewed: true }).allowed, false);
});

test("a properly reviewed additive revision is accepted", () => {
  const additive = T.sampleManifest({ datasets: [T.sampleDataset({ version: "1.1.0", title: "Daily activity v1.1", allowed_fields: [...T.sampleDataset().allowed_fields, extraField] })] });
  const result = C.compareCatalogs(base(), additive);
  assert.equal(result.decision, "COMPATIBLE_ADDITIVE");
  assert.deepEqual(unclassified(result), []);
  assert.deepEqual(C.activationDecision(result, { reviewed: true }), { allowed: true, reason: "REVIEWED_ADDITIVE" });
});
