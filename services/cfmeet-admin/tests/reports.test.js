"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");


// Reports backed by live CF Meet Bridge releases (Summary cells and
// aggregate health). Local (projection and pipeline) reports are covered by
// the PostgreSQL pipeline tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startBridgeHarness, protocolGet, opensslAvailable, SCOPE } = require("./helpers/bridge-harness");
const { REPORTS } = require("../src/modules/reports");
const X = require("./helpers/bridge-fixtures");

const skip = !opensslAvailable() && "openssl unavailable";
const q = (extra = {}) => ({ market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant, purpose: "metrics-read", ...extra });
const report = (h, id, query, claims = {}) => protocolGet(h, "/reports/cfmeet.report." + id, query, { action: "report.read", ...claims });

test("all CF Meet reports are cataloged with source, grain, units and definition", () => {
  assert.equal(REPORTS.length, 15);
  const R = require("../src/bridge/contracts/registry");
  for (const r of REPORTS) {
    assert.ok(r.definition && r.grain && r.units.length && ["BRIDGE", "LOCAL", "BLOCKED"].includes(r.kind), r.id);
    if (r.kind === "BRIDGE") assert.ok(R.capability(r.capability) && R.capability(r.capability).kind === "READ", r.id);
    if (r.sources) assert.ok(r.sources.every((s) => s.source_service && s.entity_type), r.id);
  }
  // Abuse reports and incidents come from several owners; each owner is its own source.
  assert.equal(REPORTS.find((r) => r.id === "safety_queue").sources.length, 4);
  assert.equal(REPORTS.find((r) => r.id === "incidents").sources.length, 5);
});

test("summary reports: one row per source cell, scope and window passed exactly, never summed", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const res = await report(h, "finance_usage", q({ purpose: "billing-review" }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const r = res.json.result;
  assert.deepEqual(r.rows.map((row) => row.key), X.FINANCE_KEYS);
  assert.equal("total" in r, false);
  assert.equal(r.source.bridge_capability_id, "finance.usage.report");
  const url = new URL(h.fake.state.requests.at(-1).url, "https://b");
  assert.deepEqual([...url.searchParams.keys()], ["market", "organization", "zone", "tenant", "purpose", "limit", "start", "end"]);
  assert.equal(url.searchParams.get("purpose"), "billing-review");
  assert.equal(res.json.coverage, "COMPLETE");
  // Required scope, delegated scope, allowed purposes, delegation action.
  assert.equal((await report(h, "finance_usage", q({ zone: undefined }))).json.error.reason, "SCOPE_ZONE_AND_TENANT_REQUIRED");
  assert.equal((await report(h, "finance_usage", q({ zone: "elsewhere" }))).json.error.reason, "ZONE_NOT_GRANTED");
  assert.equal((await report(h, "finance_usage", q({ purpose: "event-sync" }))).json.error.reason, "PURPOSE_NOT_ALLOWED");
  assert.equal((await report(h, "finance_usage", q({ product_code: "x" }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
  assert.equal((await report(h, "finance_usage", q(), { action: "resource.read" })).json.error.reason, "DELEGATION_ACTION_MISMATCH");
  // Reports without a source aggregate are explicit blocked dependencies, never estimates.
  const activity = await report(h, "meeting_activity", q());
  assert.equal(activity.status, 503);
  assert.equal(activity.json.error.reason, "NO_SOURCE_AGGREGATE");
  assert.equal((await report(h, "partner_usage", q())).json.error.reason, "SOURCE_RELEASES_PER_WORKSPACE_ONLY");
  assert.equal((await report(h, "made_up", q())).json.error.reason, "UNKNOWN_REPORT");
  // A snapshot summary (SCOPED) takes no window.
  const spread = await report(h, "communications_metrics", q());
  assert.equal(spread.status, 200, JSON.stringify(spread.json));
  assert.deepEqual([...new URL(h.fake.state.requests.at(-1).url, "https://b").searchParams.keys()], ["market", "organization", "zone", "tenant", "purpose"]);
  assert.equal((await report(h, "communications_metrics", q({ start: new Date(Date.now() - 3600000).toISOString() }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
});

test("small cells stay suppressed; estimated charges are withheld without complete coverage", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  h.fake.state.handlers["communications.metrics.read"] = ({ query }) => ({ result: X.summary(query, X.MEETING_KEYS, { values: { participants: null }, windowed: false }) });
  const meetings = await report(h, "communications_metrics", q());
  assert.deepEqual(meetings.json.result.rows.find((c) => c.key === "participants"), { key: "participants", unit: "count", currency: null, value: null, suppression: "SMALL_CELL" });
  h.fake.state.summaryCoverage = "PARTIAL";
  const partial = await report(h, "estimated_charges", q({ purpose: "billing-review" }));
  assert.equal(partial.status, 200);
  assert.equal(partial.json.result.quality, "PARTIAL_COVERAGE");
  assert.ok(partial.json.result.rows.every((c) => c.value === null && c.suppression === "PARTIAL_COVERAGE"));
  assert.ok(partial.json.result.blockers.some((b) => b.code === "PARTIAL_COVERAGE"));
  h.fake.state.summaryCoverage = "COMPLETE";
  const complete = await report(h, "estimated_charges", q({ purpose: "billing-review" }));
  assert.ok(complete.json.result.rows.every((c) => Number.isInteger(c.value)));
});

test("finance: per-currency minor units, never combined across currencies", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const res = await report(h, "finance_usage", q({ purpose: "billing-review" }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const money = res.json.result.rows.filter((r) => r.unit === "minor_currency");
  assert.deepEqual(money.map((r) => [r.key, r.currency]), [["charges_ngn", "NGN"], ["charges_usd", "USD"]]);
  assert.ok(res.json.result.rows.filter((r) => r.unit === "count").every((r) => r.currency === null));
  assert.equal(res.json.result.rows.some((r) => r.key === "total" || r.currency === "MIXED"), false);
  const cap = require("../src/bridge/contracts/registry").capability("finance.usage.report");
  assert.ok(["R2", "R3", "R4"].includes(cap.risk));
});

test("telecom is an explicit blocked dependency, local reports need the feed, health and connector health answer", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const telecom = await report(h, "telecom_numbers", q());
  assert.equal(telecom.status, 503);
  assert.equal(telecom.json.error.reason, "SOURCE_NOT_RELEASED");
  assert.equal(telecom.json.result, null);
  const local = await report(h, "safety_queue", q({ purpose: "abuse-review" }));
  assert.equal(local.json.error.reason, "BRIDGE_FEED_NOT_ENABLED");
  const connector = await report(h, "connector_health", q());
  assert.equal(connector.status, 200);
  assert.equal(connector.json.result.rows[0].bridge, "CONFIGURED_NOT_CERTIFIED");
  const health = await report(h, "operations_health", q({ purpose: "ops-incident" }));
  assert.equal(health.status, 200, JSON.stringify(health.json));
  assert.equal(health.json.result.overall_status, "OK");
  assert.ok(health.json.result.rows.every((r) => r.service && r.status && r.checked_at));
});

test("summary and verification collections read through the same pinned contract", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  const usage = await protocolGet(h, "/resources/cfmeet.partners.read/partners.usage.read/ws-1", q());
  assert.equal(usage.status, 200, JSON.stringify(usage.json));
  assert.ok(Array.isArray(usage.json.result.data.cells));
  const cases = await protocolGet(h, "/resources/cfmeet.verification.read/verification.cases.list", q({ purpose: "verification-review", limit: 10 }));
  assert.equal(cases.status, 200, JSON.stringify(cases.json));
  assert.ok(cases.json.result.data.items.every((c) => c.product === "cfmeet" && Array.isArray(c.evidence)));
  assert.ok(cases.json.result.continuation, "the Bridge cursor becomes a sealed continuation");
});
