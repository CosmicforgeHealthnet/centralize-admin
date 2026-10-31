"use strict";

// Section 11 reports backed by live Bridge releases. Local (projection and
// pipeline) reports are covered by the PostgreSQL pipeline tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startBridgeHarness, protocolGet, opensslAvailable, SCOPE } = require("./helpers/bridge-harness");
const { REPORTS } = require("../src/modules/reports");
const X = require("./helpers/bridge-fixtures");

const skip = !opensslAvailable() && "openssl unavailable";
const q = (extra = {}) => ({ market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant, purpose: "ops_review", ...extra });
const report = (h, id, query, claims = {}) => protocolGet(h, "/reports/karryam.report." + id, query, { action: "report.read", ...claims });

test("all 14 first-wave reports are cataloged with source, grain, units and definition", async () => {
  assert.equal(REPORTS.length, 14);
  for (const r of REPORTS) {
    assert.ok(r.definition && r.grain && r.units.length && ["BRIDGE", "LOCAL", "BLOCKED"].includes(r.kind), r.id);
  }
});

test("operational activity: one row per authority, never summed across services", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const res = await report(h, "operational_activity", q({ product_code: "karryam-core" }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const r = res.json.result;
  assert.deepEqual(r.rows.map((row) => row.authority), ["TAXI", "DISPATCH", "HAULING"]);
  assert.ok(r.rows.every((row) => row.cells.length === 8));
  assert.equal("total" in r, false);
  assert.equal(r.source.bridge_capability_id, "analytics.scoped.mission-outcomes.read");
  assert.deepEqual(h.fake.state.requests.map((x) => new URL(x.url, "https://b").searchParams.get("authority")), ["TAXI", "DISPATCH", "HAULING"]);
  assert.equal(res.json.coverage, "COMPLETE");
  // Required filter and delegated scope.
  assert.equal((await report(h, "operational_activity", q())).json.error.reason, "PRODUCT_CODE_REQUIRED");
  assert.equal((await report(h, "taxi_status", q({ product_code: "k", zone: "elsewhere" }))).json.error.reason, "ZONE_NOT_GRANTED");
  assert.equal((await report(h, "taxi_status", q({ product_code: "k" }), { action: "resource.read" })).json.error.reason, "DELEGATION_ACTION_MISMATCH");
  assert.equal((await report(h, "made_up", q())).json.error.reason, "UNKNOWN_REPORT");
});

test("small cells stay suppressed; vendor readiness is withheld without complete cohort coverage", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  h.fake.state.handlers["analytics.scoped.mission-outcomes.read"] = ({ query }) => ({ result: X.release("mission-outcomes", X.MISSION_OUTCOME_KEYS, query, { values: { failed: null } }) });
  const taxi = await report(h, "taxi_status", q({ product_code: "k" }));
  const failed = taxi.json.result.rows[0].cells.find((c) => c.key === "failed");
  assert.deepEqual(failed, { key: "failed", value: null, suppression: "SMALL_CELL" });
  h.fake.state.readinessCoverage = "PARTIAL_COVERAGE";
  const partial = await report(h, "vendor_readiness", q({ product_code: "k" }));
  assert.equal(partial.status, 200);
  assert.equal(partial.json.result.quality, "PARTIAL_COVERAGE");
  assert.ok(partial.json.result.rows[0].cells.every((c) => c.value === null && c.suppression === "PARTIAL_COVERAGE"));
  h.fake.state.readinessCoverage = "COMPLETE";
  const complete = await report(h, "vendor_readiness", q({ product_code: "k" }));
  assert.ok(complete.json.result.rows[0].cells.every((c) => Number.isInteger(c.value)));
  assert.equal(new URL(h.fake.state.requests.at(-1).url, "https://b").searchParams.get("authority"), "VENDOR");
});

test("finance: per-currency minor units, recognition labels kept, POST read contract preserved", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const res = await report(h, "wallet_by_currency", q({ timezone: "Africa/Lagos" }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const rows = res.json.result.rows;
  assert.deepEqual(rows.map((r) => [r.measure, r.currency, r.amount_minor]), [["wallet_topups", "NGN", 125000000], ["wallet_topups", "USD", 99000], ["trip_fares_settled", "NGN", null]]);
  assert.ok(rows.every((r) => r.unit === "MINOR_UNITS"));
  assert.equal(rows.find((r) => r.measure === "wallet_topups").recognition, "NOT_REVENUE");
  assert.equal(rows.find((r) => r.measure === "trip_fares_settled").unknown_reason, "settlement_batch_pending");
  const call = h.fake.state.requests.at(-1);
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { timezone: "Africa/Lagos" });
  const recon = await report(h, "payment_reconciliation", q());
  assert.equal(recon.json.result.completeness, "COMPLETE");
  assert.ok(recon.json.result.rows.every((r) => r.recognition && r.calculation));
  assert.equal(recon.json.result.aggregation_version, "wallet-agg-3");
});

test("Fleet counts are an explicit blocked dependency, and local reports need the feed", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const fleet = await report(h, "fleet_status", q());
  assert.equal(fleet.status, 503);
  assert.equal(fleet.json.error.reason, "NO_SOURCE_AGGREGATE");
  assert.equal(fleet.json.result, null);
  const local = await report(h, "support_queue", q());
  assert.equal(local.json.error.reason, "BRIDGE_FEED_NOT_ENABLED");
  const health = await report(h, "connector_health", q());
  assert.equal(health.status, 200);
  assert.equal(health.json.result.rows[0].bridge, "CONFIGURED_NOT_CERTIFIED");
});

test("analytics and governance module collections read through the same pinned contract", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const analytics = await protocolGet(h, "/resources/karryam.analytics.read/analytics.scoped.mission-outcomes.read", q({ authority: "DISPATCH", product_code: "k" }));
  assert.equal(analytics.status, 200, JSON.stringify(analytics.json));
  assert.equal(analytics.json.result.data.metric, "mission-outcomes");
  assert.equal((await protocolGet(h, "/resources/karryam.analytics.read/analytics.scoped.mission-outcomes.read", q({ authority: "VENDOR", product_code: "k" }))).json.error.reason, "REQUEST_OUTSIDE_PINNED_CONTRACT");
  assert.equal((await protocolGet(h, "/resources/karryam.analytics.read/analytics.scoped.mission-outcomes.read", q({ authority: "TAXI" }))).json.error.reason, "ANALYTICS_FILTER_REQUIRED");
  const queue = await protocolGet(h, "/resources/karryam.support.read/hq.support.queue", q());
  assert.equal(queue.status, 200, JSON.stringify(queue.json));
  assert.deepEqual(queue.json.result.data.items, []);
  assert.equal(queue.json.coverage, "COMPLETE");
});
