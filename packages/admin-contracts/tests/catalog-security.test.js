"use strict";

// Section 13.1 unit coverage for catalog semantics that protect HQ: data
// classification ceilings, prohibited fields, closed command/event schemas,
// currency separation and digest drift detection.

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("..");

const T = require("../src/testing");
const { catalogErrors, withSchemaDigest, standardMetricObservationFamily, findDataset, findMetric, catalogDigest, PROHIBITED_FIELD } = C;

function manifest(overrides = {}) { return T.sampleManifest(overrides); }
const has = (errors, prefix) => errors.some((e) => e.startsWith(prefix));

test("the sample catalog is clean", () => {
  assert.deepEqual(catalogErrors(manifest()), []);
  assert.deepEqual(catalogErrors({}), [], "an empty catalog has nothing to reject");
});

test("duplicates of capabilities, datasets, families, fields and metrics are refused", () => {
  const m = manifest();
  const ds = m.datasets[0];
  const dupDs = withSchemaDigest({ ...ds, allowed_fields: [...ds.allowed_fields, ds.allowed_fields[0]], metrics: [...ds.metrics, ds.metrics[0]] });
  const errors = catalogErrors({ ...m, capabilities: [...m.capabilities, m.capabilities[0]], datasets: [dupDs, dupDs], event_families: [...m.event_families, m.event_families[0]] });
  for (const p of ["DUPLICATE_CAPABILITY:", "DUPLICATE_DATASET:", "DUPLICATE_EVENT_FAMILY:", "DUPLICATE_FIELD:", "DUPLICATE_METRIC:"]) assert.ok(has(errors, p), p);
});

test("capabilities: blocked needs a reason, usable commands need a closed schema, reads carry none", () => {
  const m = manifest();
  const [read, cmd] = m.capabilities;
  const closed = { type: "object", additionalProperties: false, properties: { reason: { type: "string" } } };
  const cases = [
    [{ ...cmd, blockers: [] }, "BLOCKED_WITHOUT_REASON:"],
    [{ ...cmd, state: "AVAILABLE", blockers: [] }, "COMMAND_WITHOUT_SCHEMA:"],
    [{ ...read, request_schema: closed }, "SCHEMA_ON_NON_COMMAND:"],
    [{ ...cmd, request_schema: { type: "object", properties: {} } }, "COMMAND_SCHEMA_NOT_CLOSED:"],
    [{ ...cmd, request_schema: { type: "array", additionalProperties: false } }, "COMMAND_SCHEMA_NOT_CLOSED:"],
    [{ ...cmd, request_schema: { type: "object", additionalProperties: false, properties: { a: { type: "string", format: "no-such-format" } } } }, "COMMAND_SCHEMA_INVALID:"],
    [{ ...read, datasets: ["unknown.dataset"] }, "CAPABILITY_UNKNOWN_DATASET:"],
  ];
  for (const [cap, prefix] of cases) assert.ok(has(catalogErrors({ ...m, capabilities: [cap] }), prefix), prefix);
  assert.deepEqual(catalogErrors({ ...m, capabilities: [{ ...cmd, state: "AVAILABLE", blockers: [], request_schema: closed }] }), []);
});

test("datasets: digest drift, unexplained readiness, currency conflicts and classification ceilings", () => {
  const m = manifest();
  const ds = m.datasets[0];
  assert.ok(has(catalogErrors({ ...m, datasets: [{ ...ds, title: "renamed is fine" }] }), "DATASET_SCHEMA_DIGEST_MISMATCH") === false, "titles are not meaning");
  assert.ok(has(catalogErrors({ ...m, datasets: [{ ...ds, privacy_class: "CONFIDENTIAL" }] }), "DATASET_SCHEMA_DIGEST_MISMATCH:"), "privacy change without a new digest is drift");
  assert.ok(has(catalogErrors({ ...m, datasets: [{ ...ds, readiness: "BLOCKED", blockers: [] }] }), "DATASET_BLOCKED_WITHOUT_REASON:"));
  const usd = withSchemaDigest({ ...ds, metrics: [{ ...ds.metrics[1], currency: "USD" }] });
  assert.ok(has(catalogErrors({ ...m, datasets: [usd] }), "METRIC_CURRENCY_CONFLICT:"));
  const leaky = withSchemaDigest({ ...ds, allowed_fields: [...ds.allowed_fields, { name: "email", type: "string", classification: "RESTRICTED_PII", meaning: "x", unit: null }] });
  assert.ok(has(catalogErrors({ ...m, datasets: [leaky] }), "FIELD_EXCEEDS_DATASET_CLASSIFICATION:"));
});

test("event families: known dataset, closed valid schema, classification ceiling, standard metric payload", () => {
  const m = manifest();
  const fam = m.event_families[0];
  const custom = { ...fam, projection: "NONE", payload_schema: { type: "object", additionalProperties: false, properties: { n: { type: "integer" } } } };
  const cases = [
    [{ ...fam, dataset_id: "unknown.dataset" }, "EVENT_FAMILY_UNKNOWN_DATASET:"],
    [{ ...custom, payload_schema: { type: "object" } }, "EVENT_PAYLOAD_SCHEMA_NOT_CLOSED:"],
    [{ ...custom, payload_schema: { type: "object", additionalProperties: false, properties: { a: { type: "string", format: "no-such-format" } } } }, "EVENT_PAYLOAD_SCHEMA_INVALID:"],
    [{ ...fam, classification: "RESTRICTED_PII" }, "EVENT_EXCEEDS_DATASET_CLASSIFICATION:"],
    [{ ...fam, payload_schema: custom.payload_schema }, "METRIC_OBSERVATION_SCHEMA_NOT_STANDARD:"],
  ];
  for (const [f, prefix] of cases) assert.ok(has(catalogErrors({ ...m, event_families: [f] }), prefix), prefix);
  const std = standardMetricObservationFamily({ family: "x.metric", datasetId: m.datasets[0].dataset_id });
  assert.equal(std.classification, "INTERNAL");
  assert.equal(std.projection, "METRIC_OBSERVATION");
});

test("prohibited fields are refused in datasets and nested event payloads, case-insensitively", () => {
  const m = manifest();
  const ds = m.datasets[0];
  const withField = withSchemaDigest({ ...ds, allowed_fields: [...ds.allowed_fields, { name: "BVN", type: "string", classification: "INTERNAL", meaning: "x", unit: null }] });
  assert.ok(catalogErrors({ ...m, datasets: [withField] }).includes("PROHIBITED_FIELD:" + ds.dataset_id + ".BVN"));
  const nested = { ...m.event_families[0], projection: "NONE", payload_schema: { type: "object", additionalProperties: false, properties: { rider: { type: "object", additionalProperties: false, properties: { gps_trail: { type: "array", items: { type: "object", properties: { latitude: { type: "number" } } } } } } } } };
  const errors = catalogErrors({ ...m, event_families: [nested] });
  assert.ok(errors.includes("PROHIBITED_FIELD:" + nested.family + ".gps_trail"));
  assert.ok(errors.includes("PROHIBITED_FIELD:" + nested.family + ".latitude"));
  for (const ok of ["metric_id", "value", "pinned", "pan_region"]) assert.equal(PROHIBITED_FIELD.test(ok), false, ok);
});

test("lookups and catalog digest", () => {
  const m = manifest();
  assert.equal(findDataset(m, m.datasets[0].dataset_id), m.datasets[0]);
  assert.equal(findDataset(m, "nope"), null);
  assert.equal(findDataset({}, "nope"), null);
  assert.equal(findMetric(m, "synthetic.gross_value").metric.currency, "NGN");
  assert.equal(findMetric(m, "nope"), null);
  assert.equal(findMetric({}, "nope"), null);
  const a = catalogDigest(m);
  assert.equal(a, catalogDigest({ ...m, display_name: "Different" }), "display data is not part of the catalog");
  assert.notEqual(a, catalogDigest({ ...m, capabilities: m.capabilities.slice(1) }));
});
