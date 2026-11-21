"use strict";

// Section 13.1 unit coverage for the domain-neutral metric projection:
// metric coverage and value truthfulness, pinned definitions, unit and
// currency separation (no implicit FX), freshness and scope keys. No
// database: applyObservation is exercised with a fake transaction client.

const test = require("node:test");
const assert = require("node:assert/strict");
const { scopeKey, freshnessOf, checkObservation, applyObservation } = require("../src/projections/metrics");

const DATASET = Object.freeze({
  dataset_id: "acme.finance",
  metrics: [
    { metric_id: "acme.revenue.gross", version: "1.0.0", unit: "money_minor", currency: "NGN", grain: "day" },
    { metric_id: "acme.revenue.gross_usd", version: "1.0.0", unit: "money_minor", currency: "USD", grain: "day" },
    { metric_id: "acme.cases.open", version: "2.0.0", unit: "count", grain: "hour" },
  ],
});

function obs(over = {}) {
  return {
    metric_id: "acme.revenue.gross", definition_version: "1.0.0",
    window_start: "2026-11-01T00:00:00Z", window_end: "2026-11-02T00:00:00Z",
    value: 125050, value_state: "OBSERVED", unit: "money_minor", currency: "NGN", coverage: "COMPLETE", observed_at: "2026-11-01T12:00:00Z",
    ...over,
  };
}

test("scope keys are ordered, partial scopes stay distinct, and the empty scope is global", () => {
  assert.equal(scopeKey({ tenant: "t", market: "m" }), "market=m|tenant=t");
  assert.equal(scopeKey({ market: "m", organization: "o", zone: "z", tenant: "t" }), "market=m|organization=o|zone=z|tenant=t");
  assert.equal(scopeKey({}), "global");
  assert.notEqual(scopeKey({ market: "m" }), scopeKey({ market: "m", zone: "z" }));
});

test("freshness: unknown without an observation, fresh within target, stale after", () => {
  const now = Date.parse("2026-11-01T12:10:00Z");
  assert.equal(freshnessOf(null, 600, now), "UNKNOWN");
  assert.equal(freshnessOf("2026-11-01T12:00:00Z", 600, now), "FRESH");
  assert.equal(freshnessOf("2026-11-01T11:59:59Z", 600, now), "STALE");
});

test("observations must match the pinned definition, unit and currency exactly", () => {
  assert.deepEqual(checkObservation(DATASET, obs()), { ok: true, metric: DATASET.metrics[0] });
  assert.equal(checkObservation(DATASET, obs({ metric_id: "acme.unknown" })).reason, "METRIC_UNKNOWN");
  assert.equal(checkObservation({ dataset_id: "x" }, obs()).reason, "METRIC_UNKNOWN", "a dataset without metrics publishes none");
  assert.equal(checkObservation(DATASET, obs({ definition_version: "1.1.0" })).reason, "METRIC_DEFINITION_MISMATCH");
  assert.equal(checkObservation(DATASET, obs({ unit: "count" })).reason, "METRIC_UNIT_MISMATCH");
  // Two currencies are never combined or converted.
  assert.equal(checkObservation(DATASET, obs({ currency: "USD" })).reason, "METRIC_CURRENCY_MISMATCH");
  assert.equal(checkObservation(DATASET, obs({ metric_id: "acme.revenue.gross_usd", currency: "NGN" })).reason, "METRIC_CURRENCY_MISMATCH");
  assert.equal(checkObservation(DATASET, obs({ currency: null })).reason, "METRIC_CURRENCY_MISMATCH");
  const count = obs({ metric_id: "acme.cases.open", definition_version: "2.0.0", unit: "count", currency: null, value: 4 });
  assert.equal(checkObservation(DATASET, count).ok, true);
  assert.equal(checkObservation(DATASET, { ...count, currency: "NGN" }).reason, "METRIC_CURRENCY_MISMATCH");
});

test("value truthfulness: OBSERVED needs value, time and coverage; UNAVAILABLE carries no value", () => {
  const bad = (o) => checkObservation(DATASET, obs(o)).reason;
  assert.equal(bad({ value: null }), "PAYLOAD_INVALID");
  assert.equal(bad({ observed_at: null }), "PAYLOAD_INVALID");
  assert.equal(bad({ coverage: "UNKNOWN" }), "PAYLOAD_INVALID");
  assert.equal(bad({ coverage: "NONE" }), "PAYLOAD_INVALID");
  assert.equal(bad({ value_state: "UNAVAILABLE" }), "PAYLOAD_INVALID");
  assert.equal(bad({ window_end: "2026-11-01T00:00:00Z" }), "PAYLOAD_INVALID");
  assert.equal(bad({ currency: "naira" }), "PAYLOAD_INVALID");
  assert.equal(checkObservation(DATASET, obs({ value_state: "UNAVAILABLE", value: null, coverage: "UNKNOWN", observed_at: null })).ok, true);
  assert.equal(checkObservation(DATASET, obs({ coverage: "PARTIAL" })).ok, true, "partial coverage is representable, never upgraded");
});

function fakeClient(rows) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return { rows }; } };
}

test("applyObservation: applied rows keep scope, currency, coverage and freshness; older versions never replace newer", async () => {
  const args = {
    productAdmin: { id: "pa-1", product_id: "acme" }, subscription: { id: "sub-1", freshness_target_seconds: 600 }, contractId: "c-1",
    dataset: DATASET, metric: DATASET.metrics[0], payload: obs({ coverage: "PARTIAL" }), scope: { market: "NG-LAGOS" }, entityVersion: 3, sequence: 9,
    now: Date.parse("2026-11-01T12:05:00Z"),
  };
  const applied = fakeClient([{ id: "row-1" }]);
  assert.deepEqual(await applyObservation(applied, args), { application: "APPLIED", metricRowId: "row-1" });
  const p = applied.calls[0].params;
  assert.match(applied.calls[0].sql, /WHERE .*source_entity_version < EXCLUDED\.source_entity_version/s, "never replaces a newer entity version");
  assert.equal(p[9], "market=NG-LAGOS");
  assert.equal(p[15], "NGN");
  assert.equal(p[16], 125050);
  assert.equal(p[19], "FRESH");
  assert.equal(p[20], "PARTIAL");
  assert.equal(p[22], 3);
  const stale = fakeClient([]);
  assert.deepEqual(await applyObservation(stale, { ...args, metric: DATASET.metrics[2], payload: obs({ metric_id: "acme.cases.open", unit: "count", currency: null }) }), { application: "STALE_IGNORED" });
  assert.equal(stale.calls[0].params[15], null, "no currency invented for non-money metrics");
});

// Configuration validation (Section 12.3): the branches that fail closed
// before any secret file is read are platform-independent.
const { loadConfig, parseListen, ConfigError } = require("../src/config");

function configReason(env) {
  try { loadConfig(env); } catch (err) { assert.ok(err instanceof ConfigError, String(err)); return err.reason; }
  assert.fail("expected a ConfigError");
}

test("listen spec: unix sockets, loopback TCP only, everything else refused", () => {
  assert.deepEqual(parseListen(undefined), { kind: "unix", path: "/run/cosmicforge/product-integration-core.sock" });
  assert.deepEqual(parseListen("unix:/run/cosmicforge/pic/pic.sock"), { kind: "unix", path: "/run/cosmicforge/pic/pic.sock" });
  assert.deepEqual(parseListen("tcp:127.0.0.1:8443"), { kind: "tcp", host: "127.0.0.1", port: 8443 });
  assert.deepEqual(parseListen("tcp:[::1]:8443"), { kind: "tcp", host: "::1", port: 8443 });
  const reason = (spec) => { try { parseListen(spec); } catch (err) { return err.reason; } return "ACCEPTED"; };
  for (const spec of ["unix:relative.sock", "unix:/run/../etc/x.sock", "unix:/" + "a".repeat(120), "http://127.0.0.1:1", "tcp:localhost:80", "tcp:127.0.0.1"]) assert.equal(reason(spec), "PIC_LISTEN_INVALID", spec);
  for (const spec of ["tcp:0.0.0.0:8443", "tcp:[::]:8443", "tcp:8.8.8.8:443", "tcp:172.32.0.1:443", "tcp:[2001:db8::1]:443"]) assert.equal(reason(spec), "PIC_LISTEN_NOT_PRIVATE", spec);
  for (const spec of ["tcp:10.0.0.5:8443", "tcp:172.16.0.5:8443", "tcp:192.168.1.5:8443", "tcp:[fd00::5]:8443"]) assert.equal(reason(spec), "PIC_LISTEN_REMOTE_REQUIRES_MTLS", spec);
});

test("configuration: disabled by default; enabling requires environment, database and distinct credentials", () => {
  assert.deepEqual(loadConfig({}), { enabled: false, listen: { kind: "unix", path: "/run/cosmicforge/product-integration-core.sock" } });
  assert.equal(loadConfig({ PIC_ENABLED: "TRUE" }).enabled, false, "only the exact string true enables");
  assert.equal(configReason({ PIC_ENABLED: "true" }), "PIC_ENVIRONMENT_REQUIRED");
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "prod" }), "PIC_ENVIRONMENT_REQUIRED");
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging" }), "PIC_DATABASE_URL_REQUIRED");
  const db = "postgresql://runtime@db/pic";
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: db, PIC_MIGRATION_DATABASE_URL: db }), "RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER");
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: db, PIC_ALLOW_INSECURE_LOOPBACK: "true" }), "INSECURE_LOOPBACK_FORBIDDEN_IN_STAGING");
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "production", PIC_DATABASE_URL: db, PIC_ALLOW_INSECURE_LOOPBACK: "true" }), "INSECURE_LOOPBACK_FORBIDDEN_IN_PRODUCTION");
  for (const file of [undefined, "relative/endpoints.json", "/etc/../endpoints.json"]) {
    assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: db, PIC_ENDPOINTS_FILE: file }), "PIC_ENDPOINTS_FILE_REQUIRED", String(file));
  }
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_ENVIRONMENT: "staging", PIC_DATABASE_URL: db, PIC_ENDPOINTS_FILE: "/nonexistent/cosmicforge/endpoints.json" }), "PIC_ENDPOINTS_FILE_UNREADABLE");
  assert.equal(configReason({ PIC_ENABLED: "true", PIC_LISTEN: "tcp:0.0.0.0:1234" }), "PIC_LISTEN_NOT_PRIVATE", "the listener is validated even when disabled");
});
