"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../src");
const T = require("../../admin-contracts/src/testing");

const manifest = T.sampleManifest();
const registry = E.createEventRegistry({ productId: "synthetic-third", sourceId: "synthetic-third-test-1", families: manifest.event_families, datasets: manifest.datasets });

function metricEvent(overrides = {}, payloadOverrides = {}) {
  return E.createEvent({
    schema_id: "cosmicforge.metric-observation",
    schema_version: "1.0.0",
    family: "synthetic.metric_observation",
    event_id: randomUUID(),
    source_id: "synthetic-third-test-1",
    product_id: "synthetic-third",
    dataset_id: "synthetic.daily_activity",
    partition_key: "NG-LAGOS",
    sequence: 1,
    entity: { type: "synthetic.metric_window", id: "completed_orders-2026-10-01", version: 1 },
    scope: { market: "NG", organization: "cosmicforge", tenant: "tenant-a" },
    classification: "INTERNAL",
    occurred_at: "2026-10-02T00:00:00Z",
    emitted_at: "2026-10-02T00:01:00Z",
    payload: { metric_id: "synthetic.completed_orders", definition_version: "1.0.0", window_start: "2026-10-01T00:00:00Z", window_end: "2026-10-02T00:00:00Z", value: 42, value_state: "OBSERVED", unit: "count", currency: null, coverage: "COMPLETE", observed_at: "2026-10-02T00:00:30Z", ...payloadOverrides },
    ...overrides,
  });
}

test("a valid standard event validates and has a stable digest", () => {
  const event = metricEvent();
  const result = registry.validate(event, { allowedScope: { market: ["NG"], organization: ["cosmicforge"] } });
  assert.equal(result.ok, true);
  assert.equal(result.eventDigest, E.eventDigest(structuredClone(event)));
});

test("identity, schema and digest violations are rejected with stable reasons", () => {
  const cases = [
    [metricEvent({ product_id: "karryam" }), "PRODUCT_MISMATCH"],
    [metricEvent({ source_id: "rogue-instance" }), "SOURCE_MISMATCH"],
    [metricEvent({ family: "synthetic.unknown" }), "UNKNOWN_EVENT_FAMILY"],
    [metricEvent({ schema_version: "2.0.0" }), "SCHEMA_VERSION_UNSUPPORTED"],
    [metricEvent({ schema_version: "1.1.0" }), "SCHEMA_DRIFT"],
    [metricEvent({ classification: "RESTRICTED_PII" }), "RESTRICTED_CLASSIFICATION"],
    [metricEvent({ classification: "CONFIDENTIAL" }), "CLASSIFICATION_MISMATCH"],
    [metricEvent({}, { rider_phone: "+234000" }), "PAYLOAD_INVALID"],
    [metricEvent({}, { value: 0, coverage: "UNKNOWN", observed_at: null }), "PAYLOAD_INVALID"],
    [metricEvent({ scope: { market: "NG", organization: "cosmicforge", zone: "z1" } }), "SCOPE_INVALID"],
    [metricEvent({ emitted_at: "2099-01-01T00:00:00Z" }), "TIMESTAMP_INVALID"],
  ];
  for (const [event, reason] of cases) assert.equal(registry.validate(event).reason, reason, reason);
  const tampered = metricEvent();
  tampered.payload.value = 43;
  assert.equal(registry.validate(tampered).reason, "DIGEST_MISMATCH");
});

test("cross-market and cross-tenant events are denied by the allowed scope", () => {
  assert.equal(registry.validate(metricEvent(), { allowedScope: { market: ["GH"] } }).reason, "SCOPE_DENIED");
  assert.equal(registry.validate(metricEvent(), { allowedScope: { tenant: ["tenant-b"] } }).reason, "SCOPE_DENIED");
  assert.equal(registry.validate(metricEvent({ scope: { market: "NG", organization: "cosmicforge" } }), { allowedScope: { tenant: ["tenant-a"] } }).reason, "SCOPE_DENIED");
});

test("a Karryam Bridge source event is not accepted as a Product Admin event", () => {
  const bridgeEvent = { id: randomUUID(), type: "dispatch.trip.completed", source: "dispatch-service", market: "NG", organization: "karryam", occurred_at: "2026-10-02T00:00:00Z", data: { trip_id: "t1" } };
  assert.equal(registry.validate(bridgeEvent).reason, "ENVELOPE_INVALID");
});

test("sequence and entity version decisions", () => {
  assert.equal(E.sequenceDecision(0, 1), "NEXT");
  assert.equal(E.sequenceDecision(5, 5), "ALREADY_SEEN");
  assert.equal(E.sequenceDecision(5, 3), "ALREADY_SEEN");
  assert.equal(E.sequenceDecision(5, 7), "GAP");
  assert.throws(() => E.sequenceDecision(-1, 1));
  assert.equal(E.entityVersionDecision(null, 1), "APPLY");
  assert.equal(E.entityVersionDecision(3, 4), "APPLY");
  assert.equal(E.entityVersionDecision(3, 3), "SAME");
  assert.equal(E.entityVersionDecision(3, 2), "STALE");
});

test("not-certified and sunset families are refused", () => {
  const families = manifest.event_families.map((f) => ({ ...f, status: "NOT_CERTIFIED" }));
  const r = E.createEventRegistry({ productId: "synthetic-third", sourceId: "synthetic-third-test-1", families, datasets: manifest.datasets });
  assert.equal(r.validate(metricEvent()).reason, "FAMILY_NOT_CERTIFIED");
  const sunset = manifest.event_families.map((f) => ({ ...f, status: "DEPRECATED", sunset_at: "2020-01-01T00:00:00Z" }));
  const s = E.createEventRegistry({ productId: "synthetic-third", sourceId: "synthetic-third-test-1", families: sunset, datasets: manifest.datasets });
  assert.equal(s.validate(metricEvent()).reason, "FAMILY_SUNSET");
});

test("published envelope schema is in sync", () => {
  const file = path.join(__dirname, "..", "schemas", "event-envelope.v1.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), E.publishedEnvelopeSchema());
});
