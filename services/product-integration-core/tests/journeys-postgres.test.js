"use strict";

// Section 13.2 — the twelve end-to-end business journeys.
//
// Each journey runs on real application code: the HQ Product Integration
// Core with its own PostgreSQL, Karryam Admin with its own PostgreSQL
// (protocol server and Stage A worker) and a disposable secure Bridge
// (TLS 1.3 mTLS, HMAC v2, Ed25519, pinned contract). Journey 12 uses the
// synthetic third Product Admin. Every journey gets a fresh environment.
//
// Evidence: product-admin-e2e-journeys.json in JOURNEY_REPORT_DIR (if set).
// It is DISPOSABLE evidence, never staging certification.
// With JOURNEYS_REQUIRED=1 a missing PostgreSQL/openssl fails the suite.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");
const { randomUUID } = require("node:crypto");
const C = require("../../../packages/admin-contracts");
const X = require("../../karryam-admin/tests/helpers/bridge-fixtures");
const R = require("../../karryam-admin/src/bridge/contracts/registry");
const { contractRevision } = require("../../karryam-admin/src/sync/bridge-consumer");
const { bindTrustStoreSources } = require("../src/registry/endpoints");
const { startHarness } = require("./helpers/harness");
const { startJourneyEnv, missingPrerequisite, sourceSha, scopeOf, arraysOf, query } = require("./helpers/journeys-env");

const JOURNEYS = [
  [1, "Executive operational overview"],
  [2, "Taxi scoped read"],
  [3, "Dispatch/SOS case to HQ Support"],
  [4, "Triple event replay"],
  [5, "Genuine entity-version gap (and scope-filtered holes are not gaps)"],
  [6, "Karryam Admin offline"],
  [7, "Headquarters offline"],
  [8, "Two-currency financial reporting"],
  [9, "Two-person approved source operation"],
  [10, "Unknown command outcome"],
  [11, "Certificate/key revocation during an active session"],
  [12, "Synthetic third Product Admin"],
];
const REQUIRED = process.env.JOURNEYS_REQUIRED === "1";
const missing = missingPrerequisite();
const skip = missing && !REQUIRED ? missing : false;
const results = new Map();
const startedAt = new Date().toISOString();

// assert wrapper that records each checked expectation for the evidence file.
function recorder(rec) {
  const wrap = (name) => (...args) => {
    const message = args[args.length - 1];
    rec.assertions.push(typeof message === "string" ? message : name);
    return assert[name](...args);
  };
  return Object.fromEntries(["equal", "notEqual", "deepEqual", "ok", "match", "doesNotMatch", "rejects", "throws"].map((n) => [n, wrap(n)]));
}

function journey(id, fn, timeout = 240000) {
  const name = JOURNEYS.find(([n]) => n === id)[1];
  test(`Journey ${id}: ${name}`, { skip, timeout }, async (t) => {
    const rec = { id, name, status: "FAIL", assertions: [], started_at: new Date().toISOString(), finished_at: null, measurements: {}, error: null };
    results.set(id, rec);
    if (missing) throw new Error("JOURNEYS_REQUIRED=1 but " + missing);
    try {
      await fn(t, recorder(rec), rec);
      rec.status = "PASS";
    } catch (err) {
      rec.error = String(err && err.message ? err.message : err).slice(0, 500);
      throw err;
    } finally {
      rec.finished_at = new Date().toISOString();
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasAny = (value, words) => words.filter((w) => JSON.stringify(value).toLowerCase().includes(w.toLowerCase()));

// ---------------------------------------------------------------------------
journey(1, async (t, a) => {
  const env = await startJourneyEnv(t, { datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"] });
  const { h, fake } = env;
  const s = env.scopes[0];
  await env.grant("staff-exec", { actions: ["product.view", "dataset.list", "metric.read", "events.status.read", "report.read"], datasets: ["karryam.support_operations"] });
  const metric = env.metricPath("karryam.support.cases_open");

  const before = await h.call("staff-exec", "GET", metric);
  a.equal(before.status, 503, "before any source observation HQ answers UNAVAILABLE");
  a.equal(before.json.error.reason, "NO_SOURCE_OBSERVATION", "no fabricated zero before the first observation");

  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", status: "OPEN", scope: s }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-2", status: "ESCALATED", scope: s }));
  a.equal((await env.worker.tick())[0].status, "SUCCEEDED", "Karryam Admin committed the source events");
  await env.worker.reconcile();
  const synced = await h.engine.tick();
  a.equal(synced[0].status, "DONE", "HQ synchronized from Karryam Admin");

  const nav = await h.call("staff-exec", "GET", "/products");
  const item = nav.json.data.products.find((p) => p.product_id === "karryam");
  a.equal(item.available, true, "the existing HQ session + product grant shows Karryam in navigation");

  const res = await h.call("staff-exec", "GET", metric);
  a.equal(res.status, 200, "overview metric read through PIC");
  const latest = res.json.result.observations[0];
  a.equal(latest.value, 2, "source-confirmed open cases");
  a.equal(latest.value_state, "OBSERVED", "observed, not estimated");
  a.equal(res.json.coverage, "COMPLETE", "coverage reported");
  a.equal(res.json.freshness, "FRESH", "freshness reported");
  a.ok(Date.parse(res.json.as_of) <= Date.now(), "as_of is a real source observation time");
  a.equal(res.json.result.metric.dataset_id, "karryam.support_operations", "reporting dataset identified");
  a.ok((await env.hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_lineage"))[0].n > 0, "HQ lineage recorded");
  a.ok((await env.kaq("SELECT count(*)::int AS n FROM karryam_admin.projection_lineage WHERE operation = 'DERIVE_METRIC'"))[0].n > 0, "Karryam Admin lineage recorded");

  const status = await h.call("staff-exec", "GET", "/products/karryam/events/status");
  const sub = status.json.result.subscriptions.find((x) => x.dataset_id === "karryam.support_operations");
  a.equal(sub.coverage, "COMPLETE", "events status reports stream coverage");
  a.ok(sub.last_source_observation_at, "events status reports source freshness");

  const callsBefore = env.bridgeCalls().length;
  const overview = await h.call("staff-exec", "GET", "/products/karryam/reports/karryam.report.operational_activity?" + query(s, { purpose: "exec_overview", product_code: "karryam-core" }));
  a.equal(overview.status, 200, "operational overview report through PIC -> Karryam Admin");
  a.deepEqual(overview.json.result.rows.map((r) => r.authority), ["TAXI", "DISPATCH", "HAULING"], "one row per authority");
  a.equal("total" in overview.json.result, false, "authorities are never summed");
  a.equal(overview.json.result.source.bridge_capability_id, "analytics.scoped.mission-outcomes.read", "source lineage names the Bridge capability");
  a.equal(overview.json.coverage, "COMPLETE", "report coverage");
  const reportCalls = env.bridgeCalls().slice(callsBefore);
  a.equal(reportCalls.length, 3, "exactly the three source calls Karryam Admin made");
  a.ok(reportCalls.every((r) => r.claims.sub === "staff-exec"), "the Bridge saw the executive's own identity");

  // HQ has no route to the Bridge: no endpoint, no client certificate.
  a.equal(JSON.stringify([...h.endpoints.values()]).includes(":" + fake.port), false, "the HQ endpoint allowlist has no Bridge destination");
  const handshake = await new Promise((resolve) => {
    const sock = tls.connect({ host: "127.0.0.1", port: fake.port, servername: "bridge.karryam.internal", ca: env.pki.ca, minVersion: "TLSv1.3" }, () => {
      sock.write("GET / HTTP/1.1\r\nHost: bridge\r\n\r\n");
    });
    let data = "";
    sock.on("data", (c) => { data += c; });
    sock.on("error", () => resolve("REFUSED"));
    sock.on("close", () => resolve(/HTTP\/1\.1 2/.test(data) ? "ACCEPTED" : "REFUSED"));
    setTimeout(() => { sock.destroy(); resolve("REFUSED"); }, 3000).unref();
  });
  a.equal(handshake, "REFUSED", "a caller without Karryam Admin's enrolled client certificate is refused by the Bridge");
  a.deepEqual(fake.state.denials, [], "every accepted Bridge request carried Karryam Admin's mTLS, HMAC and Ed25519 identity");

  const noGrant = await h.call("staff-stranger", "GET", metric);
  a.equal(noGrant.status, 403, "no grant, no overview");
  await env.grant("staff-exec-2", { actions: ["product.view", "metric.read"], datasets: ["karryam.support_operations"] });
  const denied = await h.call("staff-exec-2", "GET", "/products/karryam/reports/karryam.report.operational_activity?" + query(s, { purpose: "exec_overview", product_code: "karryam-core" }));
  a.equal(denied.status, 403, "report.read is required for the overview report");
});

// ---------------------------------------------------------------------------
journey(2, async (t, a) => {
  const env = await startJourneyEnv(t);
  const { h } = env;
  const s = env.scopes[0];
  await env.grant("staff-opsman", { actions: ["product.view", "resource.read"] });
  const list = (q) => h.call("staff-opsman", "GET", "/products/karryam/resources/karryam.taxi.read/taxi.rides.list?" + q);

  const page1 = await list(query(s, { purpose: "ride_review", limit: "1" }));
  a.equal(page1.status, 200, "taxi ride list through HQ -> PIC -> Karryam Admin -> Bridge");
  a.equal(page1.json.result.module, "taxi", "taxi module");
  a.deepEqual(page1.json.result.scope, { market: s.market, organization: s.organization, zone: s.zone, tenant: s.tenant }, "exact market/zone/tenant scope");
  a.equal(page1.json.result.data.items.length, 1, "source rides returned");
  a.ok(page1.json.result.continuation, "a sealed continuation token for the next page");
  a.equal(page1.json.result.continuation.includes("taxi-page-2"), false, "the source cursor is never exposed");
  const first = env.bridgeCalls("taxi.rides.list").at(-1);
  a.equal(first.claims.sub, "staff-opsman", "the Bridge saw the Operations Manager");
  a.deepEqual([first.claims.zone_scopes, first.claims.tenant_scopes], [[s.zone], [s.tenant]], "the Bridge assertion carries the exact zone and tenant");

  const page2 = await list(query(s, { purpose: "ride_review", limit: "1", continuation: page1.json.result.continuation }));
  a.equal(page2.status, 200, "second page");
  a.equal(new URL(env.bridgeCalls("taxi.rides.list").at(-1).url, "https://b").searchParams.get("cursor"), "taxi-page-2", "the source cursor was resumed");
  a.equal(page2.json.result.first_page_observed_at, page1.json.result.observed_at, "stable pagination: later pages are bound to the first page's snapshot");
  a.equal(page2.json.result.continuation, null, "last page");
  const tampered = await list(query(s, { purpose: "other_purpose", limit: "1", continuation: page1.json.result.continuation }));
  a.equal(tampered.json.error.reason, "CONTINUATION_BINDING_MISMATCH", "a continuation cannot be reused with different filters");

  const rideId = page1.json.result.data.items[0].id;
  const detail = await h.call("staff-opsman", "GET", "/products/karryam/resources/karryam.taxi.read/taxi.rides.detail/" + rideId + "?" + query(s, { purpose: "ride_review" }));
  a.equal(detail.status, 200, "authoritative ride detail");
  a.equal(detail.json.result.kind, "DETAIL", "detail read");
  a.ok(env.bridgeCalls("taxi.rides.detail").at(-1).url.startsWith(R.BRIDGE_BASE + "/taxi/rides/" + rideId + "?"), "detail read from the source owner route");

  const calls = env.bridgeCalls().length;
  const foreignZone = await list(query({ ...s, zone: "ikeja" }, { purpose: "ride_review", limit: "1" }));
  a.equal(foreignZone.status, 403, "foreign zone denied");
  a.equal(foreignZone.json.error.reason, "SCOPE_DENIED", "foreign zone denied by HQ scope");
  const foreignTenant = await list(query({ ...s, tenant: "tenant-b" }, { purpose: "ride_review", limit: "1" }));
  a.equal(foreignTenant.status, 403, "foreign tenant denied");
  const foreignDetail = await h.call("staff-opsman", "GET", "/products/karryam/resources/karryam.taxi.read/taxi.rides.detail/" + rideId + "?" + query({ ...s, tenant: "tenant-b" }, { purpose: "ride_review" }));
  a.equal(foreignDetail.status, 403, "foreign tenant detail denied");
  a.equal(env.bridgeCalls().length, calls, "denied reads never reached the Bridge");
  const noMfa = await h.call("staff-opsman", "GET", "/products/karryam/resources/karryam.taxi.read/taxi.rides.list?" + query(s, { purpose: "ride_review", limit: "1" }), undefined, { mfa: false });
  a.equal(noMfa.json.error.reason, "RECENT_MFA_REQUIRED", "recent MFA required for scoped reads");
});

// ---------------------------------------------------------------------------
journey(3, async (t, a) => {
  const env = await startJourneyEnv(t, { tenants: ["tenant-a", "tenant-x"], datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"] });
  const { h, fake } = env;
  const s = env.scopes[0];
  await env.grant("staff-hq-support", { actions: ["product.view", "dataset.list", "metric.read", "resource.read"], datasets: ["karryam.support_operations"] });

  const sos = fake.publish((n) => X.supportEvent({ sequence: n, ref: "sos-1", status: "OPEN", priority: "EMERGENCY", scope: s }));
  // A source row carrying raw contact, message and location fields is outside
  // the pinned minimized contract: refused by Karryam Admin, never forwarded.
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "sos-leak", status: "OPEN", priority: "EMERGENCY", scope: scopeOf("tenant-x"), extra: { contact_phone: "+2348000000001", message_body: "help me at home", latitude: 6.4541, longitude: 3.3947 } }));
  const ticks = await env.worker.tick();
  const [okPart, leakPart] = ticks;
  a.equal(okPart.status, "SUCCEEDED", "the SOS case entered Karryam Admin");
  a.equal(leakPart.status, "HELD", "the non-minimized source row is quarantined and holds its own partition");
  await env.worker.reconcile();
  const [inbox] = await env.kaq("SELECT event_id, payload, classification FROM karryam_admin.bridge_event_inbox WHERE entity_ref = 'sos-1'");
  a.equal(inbox.event_id, sos.event_id, "Karryam Admin durable inbox");
  a.equal(inbox.classification, "OPERATIONS_MINIMIZED", "minimized classification");
  const [proj] = await env.kaq("SELECT payload FROM karryam_admin.entity_projections WHERE entity_ref = 'sos-1'");
  a.equal(proj.payload.priority, "EMERGENCY", "minimized support projection keeps the source priority");
  a.equal((await env.kaq("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox WHERE entity_ref = 'sos-leak'"))[0].n, 0, "the leaking row was never applied");
  a.ok((await env.kaq("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox WHERE dataset_id = 'karryam.support_operations'"))[0].n > 0, "derived HQ outbox written");

  const synced = await h.engine.tick();
  a.equal(synced[0].status, "DONE", "Product Integration Core ingested the derived events");
  const emergency = await h.call("staff-hq-support", "GET", env.metricPath("karryam.support.cases_emergency_open"));
  a.equal(emergency.status, 200, "authorized HQ Support read");
  a.equal(emergency.json.result.observations[0].value, 1, "one open SOS case");

  const queue = await h.call("staff-hq-support", "GET", "/products/karryam/resources/karryam.support.read/hq.support.queue?" + query(s, { purpose: "case_review" }));
  a.equal(queue.status, 200, "HQ Support queue read");
  const row = queue.json.result.data.items.find((i) => i.source_case_id === "sos-1");
  a.equal(row.fields.status, "OPEN", "correct source status");
  a.equal(row.fields.priority, "EMERGENCY", "correct source priority");
  a.equal(row.classification, "OPERATIONS_MINIMIZED", "minimized classification at HQ");

  const forbidden = ["+2348000000001", "help me at home", "6.4541", "latitude", "contact_phone", "message_body", "complainant_type"];
  const hqTables = [
    ...(await env.hq("SELECT payload FROM hq_integration.hq_product_admin_event_inbox")),
    ...(await env.hq("SELECT * FROM hq_integration.hq_product_admin_metrics")),
    ...(await env.hq("SELECT * FROM hq_integration.hq_product_admin_lineage")),
    ...(await env.hq("SELECT * FROM hq_integration.hq_product_admin_quarantine")),
  ];
  a.deepEqual(hasAny(hqTables, forbidden), [], "no raw contact, message body or exact location in any HQ table");
  a.deepEqual(hasAny([emergency.json, queue.json], ["+2348000000001", "help me at home", "6.4541", "latitude"]), [], "no raw contact or location in HQ responses");
  a.deepEqual(hasAny(await env.kaq("SELECT event FROM karryam_admin.hq_outbox"), forbidden), [], "the derived outbox carries metric observations only");

  const unauthorized = await h.call("staff-viewer", "GET", env.metricPath("karryam.support.cases_emergency_open"));
  a.equal(unauthorized.status, 403, "staff without a Karryam grant cannot read SOS counts");
});

// ---------------------------------------------------------------------------
journey(4, async (t, a) => {
  const env = await startJourneyEnv(t, { datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"] });
  const { h, fake } = env;
  const s = env.scopes[0];
  const key = env.partitionKey();
  await env.grant("staff-analyst", { actions: ["product.view", "metric.read", "report.read"], datasets: ["karryam.support_operations"] });
  const acks = () => env.bridgeCalls("hq.events.ack").length;
  const inboxRows = (eventId) => env.kaq("SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox WHERE event_id = $1", [eventId]).then((r) => r[0].n);
  const outboxCount = () => env.kaq("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox WHERE dataset_id = 'karryam.support_operations'").then((r) => r[0].n);

  const event = fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-r1", status: "OPEN", scope: s }));
  // Delivery 1 (feed). The worker crashes after commit, before the ACK.
  const crashing = await env.consumerFor({ workerId: "worker-crash", hooks: { beforeAck: () => { throw new Error("crash-before-ack"); } } });
  await a.rejects(crashing.tick(), /crash-before-ack/, "delivery 1 committed, then the worker crashed before ACK");
  let [p] = await env.kaq("SELECT last_sequence, acked_sequence FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1", [key]);
  a.equal(Number(p.last_sequence), event.sequence, "committed cursor at the event");
  a.ok(Number(p.acked_sequence) < event.sequence, "not acknowledged before ACK succeeded");
  await env.ka.pool.query("UPDATE karryam_admin.bridge_feed_partitions SET lease_expires_at = now() - interval '1 second' WHERE partition_key = $1", [key]);

  // Restarted worker: re-sends only the ACK, then reconciliation re-reads the
  // same event twice more (deliveries 2 and 3, rewind).
  const [resumed] = await env.worker.tick();
  a.equal(resumed.applied, 0, "the restarted worker did not re-apply anything");
  a.equal(fake.state.consumers[env.worker.consumerName(key)], event.sequence, "Bridge ACK equals the committed cursor");
  const acksAfterResume = acks();
  const [r2] = await env.worker.reconcile();
  const restarted = await env.consumerFor({ workerId: "worker-restarted" });
  const [r3] = await restarted.reconcile();
  a.ok(r2.counts.rewind_duplicates >= 1, "delivery 2 recognized as a duplicate");
  a.ok(r3.counts.rewind_duplicates >= 1, "delivery 3 recognized as a duplicate");
  a.equal(r2.counts.late_applied + r3.counts.late_applied, 0, "no replay was applied again");
  a.equal(await inboxRows(event.event_id), 1, "one immutable event record");
  await a.rejects(env.ka.pool.query("UPDATE karryam_admin.bridge_event_inbox SET outcome = 'APPLIED' WHERE event_id = $1", [event.event_id]), /immutable|permission|denied/i, "the inbox record cannot be rewritten");
  [p] = await env.kaq("SELECT last_sequence, acked_sequence FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1", [key]);
  a.deepEqual([Number(p.last_sequence), Number(p.acked_sequence)], [event.sequence, event.sequence], "cursor and ACK unchanged by replays");
  await env.worker.tick();
  a.equal(acks(), acksAfterResume, "no further ACKs once acknowledged (idempotent)");
  const [proj] = await env.kaq("SELECT entity_version FROM karryam_admin.entity_projections WHERE entity_ref = 'case-r1'");
  a.equal(Number(proj.entity_version), 1, "one application effect");

  const outboxBefore = await outboxCount();
  await h.engine.tick();
  await h.engine.tick();
  a.equal(await outboxCount(), outboxBefore, "replays added nothing to the derived outbox");
  const hqInbox = await env.hq("SELECT count(*)::int AS n, count(DISTINCT event_id)::int AS d FROM hq_integration.hq_product_admin_event_inbox WHERE dataset_id = 'karryam.support_operations'");
  a.equal(hqInbox[0].n, hqInbox[0].d, "HQ applied each derived event once");
  a.equal(hqInbox[0].n, outboxBefore, "HQ has exactly the derived events");
  const metric = await h.call("staff-analyst", "GET", env.metricPath("karryam.support.cases_open"));
  a.equal(metric.json.result.observations[0].value, 1, "no duplicate report impact (open cases = 1)");
  const report = await h.call("staff-analyst", "GET", "/products/karryam/reports/karryam.report.support_queue?" + query(s, { purpose: "ops_review" }));
  a.equal(report.status, 200, "support queue report");
  const openCells = JSON.stringify(report.json.result.rows);
  a.ok(/"OPEN"/.test(openCells), "support queue report counts the case");
  const total = report.json.result.rows.reduce((sum, r) => sum + (Number.isInteger(r.count) ? r.count : 0), 0);
  a.equal(total, 1, "the report counts the case exactly once");
});

// ---------------------------------------------------------------------------
journey(5, async (t, a, rec) => {
  const env = await startJourneyEnv(t, { datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"] });
  const { h, fake } = env;
  const s = env.scopes[0];
  const key = env.partitionKey();
  await env.grant("staff-analyst", { actions: ["product.view", "metric.read", "report.read", "events.status.read"], datasets: ["karryam.support_operations"] });
  const openGaps = () => env.kaq("SELECT count(*)::int AS n FROM karryam_admin.entity_version_gaps WHERE repaired_at IS NULL").then((r) => r[0].n);
  const read = () => h.call("staff-analyst", "GET", env.metricPath("karryam.support.cases_open"));

  // Scope-filtered holes in the global Bridge sequence are normal.
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", status: "OPEN", scope: s }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "other-1", scope: scopeOf("tenant-zz") }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "other-2", scope: { ...s, zone: "ikeja" } }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-2", status: "OPEN", scope: s }));
  const [tick1] = await env.worker.tick();
  a.equal(tick1.status, "SUCCEEDED", "holes from other scopes do not hold the partition");
  a.equal(tick1.applied, 2, "only in-scope events applied");
  a.equal(await openGaps(), 0, "a scope-filtered global-sequence hole is NOT a gap");
  const [rec1] = await env.worker.reconcile();
  a.equal(rec1.status, "SUCCEEDED", "reconciliation finds complete coverage");
  await h.engine.tick();
  const complete = await read();
  a.equal(complete.json.coverage, "COMPLETE", "HQ coverage COMPLETE despite global-sequence holes");
  a.equal(complete.json.result.observations[0].value, 2, "both in-scope cases counted");

  // A genuine entity-version gap: version 1 then version 3 of the same case,
  // while the authoritative backfill source is unavailable.
  fake.state.handlers["hq.support.queue"] = () => ({ status: 503, error: "owner_unavailable" });
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-g", version: 1, status: "OPEN", scope: s }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-g", version: 3, status: "ESCALATED", scope: s }));
  const [tick2] = await env.worker.tick();
  a.equal(tick2.gap_applied, 1, "entity-version gap detected (v1 -> v3)");
  a.equal(await openGaps(), 1, "gap recorded and held open");
  const [rec2] = await env.worker.reconcile();
  a.equal(rec2.status, "PARTIAL", "reconciliation cannot repair without the source: PARTIAL, not success");
  a.equal(rec2.details.open_gaps_after, 1, "gap still open after the failed backfill");
  await h.engine.tick();
  const partial = await read();
  a.equal(partial.status, 200, "HQ still answers with explicit quality");
  a.equal(partial.json.result.observations[0].coverage, "PARTIAL", "HQ shows PARTIAL coverage on the observation");
  a.notEqual(partial.json.coverage, "COMPLETE", "the response is never labelled COMPLETE during the gap (no observation time -> UNKNOWN, per protocol truthfulness)");
  a.equal(partial.json.result.observations[0].value, null, "no fabricated complete KPI during the gap");
  a.equal(partial.json.result.observations[0].value_state, "UNAVAILABLE", "value withheld, not zero");
  const lag = await h.call("staff-analyst", "GET", "/products/karryam/reports/karryam.report.sync_lag?" + query(s, { purpose: "ops_review" }));
  a.equal(lag.json.result.rows.find((r) => r.partition_key === key).open_entity_gaps, 1, "sync-lag report raises the open gap");
  const gapsMetric = await env.kaq("SELECT value FROM karryam_admin.metric_snapshots WHERE partition_key = $1 AND metric_id = 'karryam.sync.open_entity_gaps' ORDER BY window_start DESC LIMIT 1", [key]);
  a.equal(Number(gapsMetric[0].value), 1, "sync-health dataset publishes the gap count (alert signal)");

  // Approved reconciliation once the source is reachable again.
  delete fake.state.handlers["hq.support.queue"];
  const [rec3] = await env.worker.reconcile();
  a.equal(rec3.status, "SUCCEEDED", "reconciliation repairs the gap from the authoritative snapshot");
  a.ok(rec3.counts.backfilled + rec3.counts.backfill_stale >= 1, "backfill consulted the source");
  a.equal(await openGaps(), 0, "gap repaired");
  await h.engine.tick();
  const repaired = await read();
  a.equal(repaired.json.coverage, "COMPLETE", "HQ coverage COMPLETE after repair");
  a.equal(repaired.json.result.observations[0].value, 3, "accurate recovery: case-1, case-2 and case-g counted");
  rec.measurements.genuine_gap = { detected_at_tick: true, partial_until_reconciled: true };
});

// ---------------------------------------------------------------------------
journey(6, async (t, a) => {
  const env = await startJourneyEnv(t, { datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"], manifestTtlSeconds: 7 * 24 * 3600 });
  const { h, fake } = env;
  const s = env.scopes[0];
  await env.grant("staff-ops", { actions: ["product.view", "metric.read", "resource.read", "events.status.read"], datasets: ["karryam.support_operations"] });
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", status: "OPEN", scope: s }));
  await env.worker.tick();
  await env.worker.reconcile();
  await h.engine.tick();
  a.equal((await h.call("staff-ops", "GET", env.metricPath("karryam.support.cases_open"))).json.freshness, "FRESH", "fresh while Karryam Admin is up");
  const resourcePath = "/products/karryam/resources/karryam.taxi.read/taxi.rides.list?" + query(s, { purpose: "ride_review", limit: "1" });
  a.equal((await h.call("staff-ops", "GET", resourcePath)).status, 200, "live read works while up");

  await env.karryam.stop();
  const bridgeBefore = env.bridgeCalls().length;
  const live = await h.call("staff-ops", "GET", resourcePath);
  a.equal(live.status, 503, "live read UNAVAILABLE while Karryam Admin is offline");
  a.equal(live.json.error.reason, "PRODUCT_ADMIN_UNREACHABLE", "honest reason");
  const health = await h.call("staff-requester", "POST", "/admin/product-integrations/" + env.id + "/health-check", {});
  a.equal(health.json.data.health_status, "UNREACHABLE", "health check records UNREACHABLE");
  const alerts = await env.hq("SELECT reason_code FROM hq_integration.hq_product_admin_security_audit WHERE action = 'integration.alert' AND product_admin_id = $1", [env.id]);
  a.ok(alerts.length >= 1, "an integration alert is recorded");
  const status = await h.call("staff-ops", "GET", "/products/karryam/events/status");
  a.equal(status.json.result.connection.health_status, "UNREACHABLE", "events status exposes the connection state");
  const inboxBefore = (await env.hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n;
  const sync = await h.engine.tick();
  const part = sync[0].results ? sync[0].results.find((r) => r.partitionKey === env.partitionKey()) : null;
  a.ok(!part || part.status !== "SUCCEEDED", "synchronization does not succeed while offline");
  a.equal((await env.hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n, inboxBefore, "nothing new ingested");
  a.equal(env.bridgeCalls().length, bridgeBefore, "no hidden fallback from HQ to the Bridge");

  // Committed HQ data is served with honest freshness: STALE once beyond target.
  const sub = (await env.hq("SELECT freshness_target_seconds FROM hq_integration.hq_product_admin_subscriptions WHERE product_admin_id = $1", [env.id]))[0];
  h.clock.offsetMs = (sub.freshness_target_seconds + 120) * 1000;
  const stale = await h.call("staff-ops", "GET", env.metricPath("karryam.support.cases_open"));
  a.equal(stale.status, 200, "committed data is still readable");
  a.equal(stale.json.freshness, "STALE", "HQ shows STALE, never FRESH, while the source is unreachable past target");
  a.equal(stale.json.result.observations[0].freshness, "STALE", "observation freshness STALE");
  h.clock.offsetMs = 0;

  // Recovery after restart on the same allowlisted endpoint.
  await env.karryam.start();
  const back = await h.call("staff-requester", "POST", "/admin/product-integrations/" + env.id + "/health-check", {});
  a.equal(back.json.data.health_status, "REACHABLE", "health REACHABLE after restart");
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-2", status: "OPEN", scope: s }));
  await env.worker.tick();
  await env.worker.reconcile();
  const resumed = await h.engine.tick();
  a.equal(resumed[0].status, "DONE", "synchronization resumes");
  const fresh = await h.call("staff-ops", "GET", env.metricPath("karryam.support.cases_open"));
  a.equal(fresh.json.result.observations[0].value, 2, "new source data arrives after recovery");
  a.equal(fresh.json.freshness, "FRESH", "FRESH again after recovery");
  a.equal((await h.call("staff-ops", "GET", resourcePath)).status, 200, "live reads work again");
});

// ---------------------------------------------------------------------------
journey(7, async (t, a) => {
  const env = await startJourneyEnv(t, { datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"] });
  const { h, fake } = env;
  const s = env.scopes[0];
  const key = env.partitionKey();
  const ds = "karryam.support_operations";
  await env.grant("staff-ops", { actions: ["product.view", "metric.read"], datasets: [ds] });
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", status: "OPEN", scope: s }));
  await env.worker.tick();
  await env.worker.reconcile();
  await h.engine.tick();
  const hqCount = () => env.hq("SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox WHERE dataset_id = $1", [ds]).then((r) => r[0].n);
  const outboxCount = () => env.kaq("SELECT count(*)::int AS n FROM karryam_admin.hq_outbox WHERE dataset_id = $1", [ds]).then((r) => r[0].n);
  const ackedByHq = async () => (await env.store.outboxAcks()).find((x) => x.dataset_id === ds && x.partition_key === key).acked_sequence;
  const hqBefore = await hqCount();

  // HQ offline: Stage A keeps committing and acknowledging the Bridge.
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-1", version: 2, status: "RESOLVED", scope: s }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-3", status: "OPEN", scope: s }));
  fake.publish((n) => X.supportEvent({ sequence: n, ref: "case-4", status: "ESCALATED", scope: s }));
  const [a1] = await env.worker.tick();
  a.equal(a1.status, "SUCCEEDED", "Stage A commits while HQ is offline");
  await env.worker.reconcile();
  a.equal(fake.state.consumers[env.worker.consumerName(key)], fake.state.outbox.at(-1).sequence, "Stage A ACKs the Bridge independently of HQ");
  a.equal(await hqCount(), hqBefore, "HQ received nothing while offline");
  const head = Number((await env.kaq("SELECT head_sequence FROM karryam_admin.hq_outbox_heads WHERE dataset_id = $1 AND partition_key = $2", [ds, key]))[0].head_sequence);
  a.ok((await ackedByHq()) < head, "the derived HQ outbox retains unacknowledged events");

  // HQ comes back, commits a page, crashes before its ACK, then resumes.
  const crashing = h.makeEngine({ workerId: "pic-crash", hooks: { beforeAck: () => { throw new Error("hq-crash"); } } });
  await a.rejects(crashing.tick(), /hq-crash/, "HQ crashed after commit, before ACK");
  a.ok((await hqCount()) > hqBefore, "HQ committed before the crash");
  a.ok((await ackedByHq()) < head, "Karryam Admin still holds the unacknowledged range");
  await h.pool.query("UPDATE hq_integration.hq_product_admin_sync_cursors SET lease_expires_at = now() - interval '1 second'");
  await h.engine.tick();
  await h.engine.tick();
  a.equal(await hqCount(), await outboxCount(), "no lost events: HQ has every derived event");
  const distinct = await env.hq("SELECT count(*)::int AS n, count(DISTINCT event_id)::int AS d FROM hq_integration.hq_product_admin_event_inbox WHERE dataset_id = $1", [ds]);
  a.equal(distinct[0].n, distinct[0].d, "no duplicate application");
  a.equal(await ackedByHq(), head, "HQ resumed from its durable cursor and acknowledged through the head");
  const [cursor] = await env.hq("SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors c JOIN hq_integration.hq_product_admin_subscriptions s ON s.id = c.subscription_id WHERE c.partition_key = $1", [key]);
  a.equal(Number(cursor.last_sequence), Number(cursor.acked_sequence), "HQ cursor committed and acknowledged");
  const metric = await h.call("staff-ops", "GET", env.metricPath("karryam.support.cases_open"));
  a.equal(metric.json.result.observations[0].value, 2, "case-1 resolved, case-3 and case-4 open: exact result after recovery");
});

// ---------------------------------------------------------------------------
journey(8, async (t, a) => {
  const env = await startJourneyEnv(t);
  const { h, fake } = env;
  const s = env.scopes[0];
  await env.grant("staff-finance", { actions: ["product.view", "report.read"] });
  fake.state.handlers["hq.finance.report"] = ({ query: q }) => {
    const fr = X.financeReport(q, { now: Date.now() });
    fr.figures = [
      { measure: "wallet_topups", currency: "NGN", amount_minor: 123456789012, count: 4101, completeness: "COMPLETE" },
      { measure: "wallet_topups", currency: "USD", amount_minor: 1999, count: 3, completeness: "COMPLETE" },
      { measure: "trip_fares_settled", currency: "NGN", amount_minor: null, count: null, completeness: "PARTIAL_COVERAGE", unknown_reason: "settlement_batch_pending" },
    ];
    return { result: fr };
  };
  const end = new Date(Date.now() - 60000);
  const start = new Date(end.getTime() - 7 * 86400000);
  const path = (scope, extra = {}) => "/products/karryam/reports/karryam.report.wallet_by_currency?" + query(scope, { purpose: "finance_review", start: start.toISOString(), end: end.toISOString(), timezone: "Africa/Lagos", ...extra });

  const res = await h.call("staff-finance", "GET", path(s));
  a.equal(res.status, 200, "finance report through HQ -> PIC -> Karryam Admin -> Bridge");
  const rows = res.json.result.rows;
  a.deepEqual(rows.filter((r) => r.measure === "wallet_topups").map((r) => [r.currency, r.amount_minor, r.count]), [["NGN", 123456789012, 4101], ["USD", 1999, 3]], "separate currency totals with exact minor-unit precision");
  a.ok(rows.every((r) => r.unit === "MINOR_UNITS" && (r.amount_minor === null || Number.isSafeInteger(r.amount_minor))), "integer minor units only (no floating point)");
  a.deepEqual(hasAny(res.json.result, ["fx", "exchange_rate", "converted", "grand_total"]), [], "no FX conversion and no cross-currency total");
  a.equal("total" in res.json.result, false, "currencies are never combined");
  a.equal(rows.find((r) => r.measure === "wallet_topups").recognition, "NOT_REVENUE", "top-ups are not relabelled as revenue");
  const fares = rows.find((r) => r.measure === "trip_fares_settled");
  a.deepEqual([fares.amount_minor, fares.unknown_reason], [null, "settlement_batch_pending"], "unsupported figures stay unknown, never estimated");
  a.equal(res.json.result.period.start, start.toISOString(), "period start correct");
  a.equal(res.json.result.period.end, end.toISOString(), "period end correct");
  a.equal(res.json.result.source.owner, "payment-wallet-service", "accounting source is the wallet owner");
  a.equal(res.json.coverage, "COMPLETE", "source completeness reported");
  const call = env.bridgeCalls("hq.finance.report").at(-1);
  a.equal(call.method, "POST", "finance read keeps the pinned POST contract");
  a.deepEqual(call.body, { timezone: "Africa/Lagos" }, "only the timezone is sent in the body");
  const sent = new URL(call.url, "https://b").searchParams;
  a.deepEqual([sent.get("market"), sent.get("zone"), sent.get("tenant"), sent.get("start"), sent.get("end")], [s.market, s.zone, s.tenant, start.toISOString(), end.toISOString()], "scope and period forwarded exactly");

  const calls = env.bridgeCalls().length;
  a.equal((await h.call("staff-finance", "GET", path({ ...s, tenant: "tenant-b" }))).status, 403, "other tenant's finance denied");
  a.equal((await h.call("staff-stranger", "GET", path(s))).status, 403, "no finance grant, no report");
  a.equal(env.bridgeCalls().length, calls, "denials never reached the Bridge");
  const tooLong = await h.call("staff-finance", "GET", path(s, { start: new Date(end.getTime() - 400 * 86400000).toISOString() }));
  a.equal(tooLong.json.error.reason, "TIME_WINDOW_INVALID", "unbounded periods refused");

  // Source unavailable: blocked, never a fabricated report.
  fake.state.handlers["hq.finance.report"] = () => ({ status: 503, error: "capability_blocked" });
  const blocked = await h.call("staff-finance", "GET", path(s));
  a.equal(blocked.status, 403, "source capability disabled -> DISABLED");
  a.equal(blocked.json.error.reason, "SOURCE_CAPABILITY_DISABLED", "blocked state named, not fabricated");
  a.equal(blocked.json.result, null, "no figures when the source is blocked");
  fake.state.handlers["hq.finance.report"] = () => ({ status: 503, error: "owner_unavailable" });
  const down = await h.call("staff-finance", "GET", path(s));
  a.equal(down.status, 503, "source owner unavailable -> UNAVAILABLE");
  a.equal(down.json.result, null, "no figures when the owner is unavailable");
});

// ---------------------------------------------------------------------------
const R2 = "karryam.customer.review.submit";
const R3 = "karryam.hq.exports.create";

async function commandEnv(t, opts = {}) {
  const env = await startJourneyEnv(t, { enabledCommands: [R2, R3], highRiskCertified: [R3], ...opts });
  await env.ka.owner.query(`INSERT INTO karryam_admin.high_risk_certifications (id, capability_id, risk, contract_revision, source_policy_revision, evidence_ref, certified_by, second_reviewer, valid_from, expires_at)
    VALUES ($1,$2,'R3',$3,'owner-policy-7','cab/journeys/exports','rev-a','rev-b', now() - interval '1 hour', now() + interval '30 days')`, [randomUUID(), R3, contractRevision()]);
  await env.governance.recordCapabilityDiscovery({ registry: R, contractRevision: contractRevision(), staff: { sub: "staff-ops", role: "hq.karryam.read", market: env.scopes[0].market, organization: env.scopes[0].organization },
    discovery: { contract_version: "1.0", openapi_sha256: R.summary().source_artifacts.openapi_sha256, capabilities: [{ id: "hq.exports.create", state: "AVAILABLE" }, { id: "customer.review.submit", state: "AVAILABLE" }] } });
  for (const staff of ["staff-ops", "staff-ops-2"]) await env.grant(staff, { actions: ["product.view", "operation.submit", "operation.read", "resource.read"], scope: env.productScope });
  await env.enableOperations();
  const submit = (who, cmd, o) => env.h.call(who, "POST", "/products/karryam/operations", cmd, o);
  return { ...env, submit };
}

function reviewCommand(scope) {
  const cid = randomUUID();
  const idem = "idem-" + randomUUID();
  return { command_id: cid, idempotency_key: idem, capability_id: R2, target: { type: "customer", id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_version: 1 },
    params: { body: { contract_version: "customer.admin-review-request.v1", request_id: cid, customer_id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_review_revision: 1, idempotency_key: idem, reason_code: "CUSTOMER_REQUEST", requested_at: new Date().toISOString() } },
    reason_code: "CUSTOMER_REQUEST", case_reference: "case-9", scope };
}

function reviewOperation(body, status, scope) {
  const sc = { product: "karryam", ...scope };
  const out = { operation_id: body.request_id, customer_id: body.customer_id, scope: sc, status, created_at: new Date().toISOString(), as_of: new Date().toISOString() };
  if (status === "CONFIRMED") out.receipt = { contract_version: "customer.admin-review-request.v1", status: "REVIEW_REQUEST_RECORDED", review_request_id: randomUUID(), request_id: body.request_id, customer_id: body.customer_id, idempotency_key: body.idempotency_key, intent_digest: "c".repeat(64), recorded_review_revision: 2, scope: sc, recorded_at: new Date().toISOString() };
  return out;
}

journey(9, async (t, a) => {
  const env = await commandEnv(t);
  const { h, fake, submit } = env;
  const s = env.scopes[0];
  const allowed = arraysOf(s);
  fake.state.handlers["hq.exports.create"] = () => ({ result: { export_id: randomUUID(), row_count: 12, download_token: "Z".repeat(43), expires_at: new Date(Date.now() + 600000).toISOString(), plaintext_sha256: "d".repeat(64) } });
  const sent = () => env.bridgeCalls("hq.exports.create");
  const base = () => ({ command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id: R3, target: { type: "export", id: "export-request", expected_version: 3 },
    params: { body: { approval_id: "5f0a1c2e-3d4b-4a5c-8d6e-7f8091a2b3c4", row_limit: 200 } }, reason_code: "REGULATOR_REQUEST", case_reference: "case-77", scope: allowed });
  const local = (who, capability_id, params, o) => submit(who, { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id, target: { type: "approval", id: "approval", expected_version: null }, params, reason_code: "HIGH_RISK_CHANGE", case_reference: null, scope: allowed }, o);
  const intent = C.digestOf({ capability: R3, target: base().target, body: base().params.body, scope: s, staff: "staff-ops" });

  a.equal((await submit("staff-ops", base())).json.error.reason, "INDEPENDENT_APPROVAL_REQUIRED", "no execution without an independent approval");
  a.equal((await submit("staff-ops", base(), { mfa: false })).json.error.reason, "RECENT_MFA_REQUIRED", "requester needs recent strong MFA");
  const proposal = await local("staff-ops", "karryam.governance.approval.propose", { capability_id: R3, intent_digest: intent, ttl_seconds: 600, expected_version: 3 });
  a.equal(proposal.json.result.approval.status, "PROPOSED", "requester proposes the exact intent");
  const approvalId = proposal.json.result.approval.approval_id;
  a.equal((await local("staff-ops", "karryam.governance.approval.decide", { approval_id: approvalId, decision: "APPROVE" })).json.error.reason, "APPROVER_MUST_BE_INDEPENDENT", "requester cannot approve their own request");
  a.equal((await local("staff-ops-2", "karryam.governance.approval.decide", { approval_id: approvalId, decision: "APPROVE" }, { mfa: false })).json.error.reason, "RECENT_MFA_REQUIRED", "approver needs recent strong MFA");
  const approved = await local("staff-ops-2", "karryam.governance.approval.decide", { approval_id: approvalId, decision: "APPROVE" });
  a.equal(approved.json.result.approval.status, "APPROVED", "independent approver approves");
  const [stored] = await env.kaq("SELECT status, requested_by, decided_by, intent_digest, source_policy_revision, expected_version FROM karryam_admin.approval_references WHERE id = $1", [approvalId]);
  a.deepEqual(stored, { status: "APPROVED", requested_by: "staff-ops", decided_by: "staff-ops-2", intent_digest: intent, source_policy_revision: "owner-policy-7", expected_version: "3" }, "approval bound to intent digest, source version and approved source policy");

  const withApproval = (cmd) => { cmd.params.approval_ref = approvalId; return cmd; };
  const changedIntent = withApproval(base());
  changedIntent.params.body.row_limit = 5000;
  a.equal((await submit("staff-ops", changedIntent)).json.error.reason, "APPROVAL_BINDING_MISMATCH", "a different intent cannot use the approval");
  const changedVersion = withApproval(base());
  changedVersion.target.expected_version = 4;
  a.equal((await submit("staff-ops", changedVersion)).json.error.reason, "APPROVAL_BINDING_MISMATCH", "a different source version cannot use the approval");
  a.equal((await submit("staff-ops-2", withApproval(base()))).json.error.reason, "APPROVAL_BINDING_MISMATCH", "the approver cannot execute the approved action: the intent is bound to the requester (separation of duties)");
  const outside = withApproval(base());
  outside.scope = { ...allowed, tenant: ["tenant-b"] };
  a.equal((await submit("staff-ops", outside)).json.error.reason, "SCOPE_DENIED", "scope binding: other tenant refused");
  a.equal(sent().length, 0, "no refused attempt reached the owner");

  const cmd = withApproval(base());
  const res = await submit("staff-ops", cmd);
  a.equal(res.json.result.status, "SUCCEEDED", "owner executed the approved operation");
  a.equal(sent().length, 1, "exactly one owner dispatch");
  a.equal(sent()[0].claims.sub, "staff-ops", "requester identity reached the owner");
  a.equal(JSON.stringify(res.json).includes("Z".repeat(43)), false, "single-use export token never returned through HQ");
  const [op] = await env.kaq("SELECT status, staff_ref, dispatch_count, intent_digest, approval_ref FROM karryam_admin.operation_requests WHERE id = $1", [cmd.command_id]);
  a.deepEqual([op.status, op.staff_ref, op.dispatch_count, op.intent_digest, op.approval_ref], ["SUCCEEDED", "staff-ops", 1, intent, approvalId], "durable receipt with intent and approval");
  const read = await h.call("staff-ops", "GET", "/products/karryam/operations/" + cmd.command_id);
  a.equal(read.json.result.status, "SUCCEEDED", "readback through HQ");
  const audit = await h.call("staff-ops", "GET", "/products/karryam/operations/" + cmd.command_id + "/audit");
  a.deepEqual(audit.json.result.records.map((x) => x.outcome), ["OPERATION_RECORDED", "OPERATION_DISPATCHED", "OPERATION_SUCCEEDED"], "audit history");
  const hqAudit = await env.hq("SELECT metadata FROM hq_integration.hq_product_admin_security_audit WHERE action = 'operation.submit.forward' ORDER BY id");
  a.ok(hqAudit.some((r) => r.metadata.command_digest === C.digestOf(cmd)), "HQ audited the forwarded command digest");
  const [consumed] = await env.kaq("SELECT status, consumed_by FROM karryam_admin.approval_references WHERE id = $1", [approvalId]);
  a.deepEqual(consumed, { status: "CONSUMED", consumed_by: cmd.command_id }, "approval consumed by exactly this operation");
  const reuse = { ...cmd, command_id: randomUUID(), idempotency_key: "idem-" + randomUUID() };
  a.equal((await submit("staff-ops", reuse)).json.error.reason, "APPROVAL_ALREADY_CONSUMED", "approval cannot be reused");
  a.equal(sent().length, 1, "still one dispatch");
});

// ---------------------------------------------------------------------------
journey(10, async (t, a, rec) => {
  const env = await commandEnv(t, { bridgeClientOptions: { commandTimeoutMs: 1000 } });
  const { h, fake, submit } = env;
  const s = env.scopes[0];
  const owner = new Map(); // the source owner's committed effects
  fake.state.handlers["customer.review.submit"] = async ({ body }) => {
    owner.set(body.request_id, { body, status: "CONFIRMED" });
    await sleep(2500); // committed, but the reply never arrives in time
    return "HANDLED";
  };
  fake.state.handlers["customer.review.readback"] = ({ params }) => {
    const effect = owner.get(params.operation_id);
    return effect ? { result: reviewOperation(effect.body, effect.status, s) } : { status: 404, error: "not_found" };
  };
  const submitted = () => env.bridgeCalls("customer.review.submit");
  const cmd = reviewCommand(arraysOf(s));

  const started = Date.now();
  const res = await submit("staff-ops", cmd);
  rec.measurements.unknown_outcome_ms = Date.now() - started;
  a.equal(res.status, 200, "HQ returns the operation state");
  a.equal(res.json.result.status, "UNKNOWN_OUTCOME", "timeout after dispatch is UNKNOWN_OUTCOME, never success or failure");
  a.equal(res.json.result.operation_id, cmd.command_id, "original operation ID retained");
  a.ok(owner.has(cmd.command_id), "the owner did commit the effect");
  const retry = await submit("staff-ops", cmd);
  a.equal(retry.json.result.status, "UNKNOWN_OUTCOME", "retry reports the original unknown state");
  a.equal(retry.json.result.replay, true, "retry is a replay");
  a.equal(submitted().length, 1, "no second irreversible submission");

  fake.state.paused = true;
  const unreachable = await h.call("staff-ops", "GET", "/products/karryam/operations/" + cmd.command_id);
  fake.state.paused = false;
  a.equal(unreachable.json.result.status, "UNKNOWN_OUTCOME", "still unknown while the owner cannot be read back");
  a.equal(unreachable.json.result.readback.state, "READBACK_UNAVAILABLE", "readback failure is explicit");
  const settled = await h.call("staff-ops", "GET", "/products/karryam/operations/" + cmd.command_id);
  a.equal(settled.json.result.status, "SUCCEEDED", "final state reconciled from source evidence");
  a.equal(settled.json.result.readback.state, "SETTLED_BY_READBACK", "settled by authoritative readback");
  a.ok(env.bridgeCalls("customer.review.readback").at(-1).url.includes("/customer/review-requests/" + cmd.command_id + "?"), "readback of the ORIGINAL operation");
  const [op] = await env.kaq("SELECT status, dispatch_count, reason_code FROM karryam_admin.operation_requests WHERE id = $1", [cmd.command_id]);
  a.deepEqual([op.status, op.dispatch_count, op.reason_code], ["SUCCEEDED", 1, "SOURCE_CONFIRMED_BY_READBACK"], "durable record: one dispatch, settled by readback");
  a.equal(submitted().length, 1, "never resubmitted");
  const other = await h.call("staff-ops-2", "GET", "/products/karryam/operations/" + cmd.command_id);
  a.equal(other.status, 404, "only the requester sees the operation");
});

// ---------------------------------------------------------------------------
journey(11, async (t, a, rec) => {
  const env = await commandEnv(t, { datasets: ["karryam.support_operations", "karryam.sync_health"], subscriptions: ["karryam.support_operations"] });
  const { h, fake, submit } = env;
  const s = env.scopes[0];
  fake.state.handlers["customer.review.submit"] = ({ body }) => ({ result: reviewOperation(body, "CONFIRMED", s) });
  for (const staff of ["staff-rev", "staff-rev-2"]) await env.grant(staff, { actions: ["product.view", "resource.read", "operation.submit", "operation.read"] });
  const readPath = "/products/karryam/resources/karryam.taxi.read/taxi.rides.list?" + query(s, { purpose: "ride_review", limit: "1" });
  const read = (who) => h.call(who, "GET", readPath);
  a.equal((await read("staff-rev")).status, 200, "active session reads");
  a.equal((await submit("staff-rev", reviewCommand(arraysOf(s)))).json.result.status, "SUCCEEDED", "active session commands");

  // (a) The Bridge revokes the staff session: the very next request is denied.
  fake.state.revokedSessions.add("sess-staff-rev");
  const sessionDenied = await read("staff-rev");
  a.notEqual(sessionDenied.status, 200, "revoked staff session denied on the next request");
  a.equal(sessionDenied.json.result, null, "no data after session revocation");
  a.ok(fake.state.denials.includes("SESSION_REVOKED"), "denied by the source session revocation");
  const [readAudit] = await env.kaq("SELECT outcome, metadata FROM karryam_admin.integration_audit WHERE staff_ref = 'staff-rev' AND action = 'resource.read' ORDER BY id DESC LIMIT 1");
  a.match(readAudit.outcome, /^READ_/, "Karryam Admin audited the refused read");
  a.notEqual(readAudit.outcome, "READ_AUTHORIZED", "the refused read is not audited as authorized");
  a.equal(readAudit.metadata.bridge_capability, "taxi.rides.list", "audit names the source capability");
  fake.state.revokedSessions.delete("sess-staff-rev");

  // (b) The Bridge revokes Karryam Admin's client certificate.
  fake.state.revokedFingerprints.add(env.clientFingerprint);
  const certDenied = await read("staff-rev-2");
  a.notEqual(certDenied.status, 200, "revoked client certificate denied on the next request");
  a.ok(fake.state.denials.includes("CLIENT_NOT_ENROLLED"), "denied by certificate revocation");
  const cmdAfterCert = await submit("staff-rev-2", reviewCommand(arraysOf(s)));
  a.notEqual(cmdAfterCert.json.result && cmdAfterCert.json.result.status, "SUCCEEDED", "no command succeeds with a revoked certificate");
  fake.state.revokedFingerprints.delete(env.clientFingerprint);
  a.equal((await read("staff-rev-2")).status, 200, "service restored after re-enrollment");

  // (c) HQ revokes the staff member's product grant: re-evaluated at once.
  const grantId = (await env.hq("SELECT id FROM hq_integration.hq_product_admin_grants WHERE staff_id = 'staff-rev' AND revoked_at IS NULL"))[0].id;
  const revoked = await h.call("staff-requester", "POST", "/admin/product-integration-grants/" + grantId + "/revoke", { reason_code: "EMERGENCY_REVOKE" });
  a.equal(revoked.status, 200, "grant revoked");
  const calls = env.bridgeCalls().length;
  a.equal((await read("staff-rev")).status, 403, "next read denied immediately (no cached authorization)");
  a.equal((await submit("staff-rev", reviewCommand(arraysOf(s)))).status, 403, "no further authorized commands");
  a.equal(env.bridgeCalls().length, calls, "nothing reached Karryam Admin or the Bridge");
  const [grantAudit] = await env.hq("SELECT actor_id, metadata FROM hq_integration.hq_product_admin_security_audit WHERE action = 'integration.grant.revoke' ORDER BY id DESC LIMIT 1");
  a.deepEqual([grantAudit.actor_id, grantAudit.metadata.grant_ref], ["staff-requester", grantId], "revocation audited with actor and grant reference");
  const nav = await h.call("staff-rev", "GET", "/products");
  a.equal(nav.json.data.products.some((p) => p.product_id === "karryam"), false, "product navigation re-evaluated without the grant");

  // (d) The manifest signer trust changes (emergency signer revocation). PIC
  // re-checks its trust store files every PIC_TRUST_STORE_RECHECK_SECONDS
  // (here 1 s, the minimum): within that bound every read, command and sync
  // stops with TRUST_STORE_CHANGED until restarted with the new trust.
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pic-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trusted-signers.json");
  fs.writeFileSync(file, JSON.stringify({ signers: { "karryam-test-signer-1": { product_id: "karryam", environment: "test", revoked: false } } }));
  const RECHECK_MS = 1000;
  bindTrustStoreSources(h.trustStore, [{ file, bytes: fs.readFileSync(file) }], { recheckMs: RECHECK_MS });
  a.equal((await read("staff-rev-2")).status, 200, "reads work under the current trust");
  const callsBeforeTrust = env.bridgeCalls().length;
  fs.writeFileSync(file, JSON.stringify({ signers: { "karryam-test-signer-1": { product_id: "karryam", environment: "test", revoked: true } } }));
  const revokedAt = Date.now();
  // Measured: start time (relative to the change) of the last request still
  // served and of the first denied one. The guarantee is that no request
  // evaluated later than RECHECK_MS after the change is served.
  let deniedAfter = null;
  let lastServedStart = null;
  let lastDenied = null;
  let callsAtDenial = null;
  while (Date.now() - revokedAt < RECHECK_MS + 3000) {
    const startedRel = Date.now() - revokedAt;
    const r = await read("staff-rev-2");
    callsAtDenial = env.bridgeCalls().length;
    if (r.status !== 200) { deniedAfter = startedRel; lastDenied = r; break; }
    lastServedStart = startedRel;
    await sleep(25);
  }
  rec.measurements.signer_revocation_documented_bound_ms = RECHECK_MS;
  rec.measurements.signer_revocation_last_served_request_start_ms = lastServedStart;
  rec.measurements.signer_revocation_first_denied_request_start_ms = deniedAfter;
  a.ok(deniedAfter !== null, "signer trust change denies reads");
  a.ok(lastServedStart === null || lastServedStart <= RECHECK_MS + 100, `no request started after the documented ${RECHECK_MS} ms recheck bound was served (last served started at ${lastServedStart} ms)`);
  a.equal(lastDenied.json.error.reason, "IDENTITY_NOT_VERIFIED", "staff-facing reason: identity not verified");
  const cmdAfterTrust = await submit("staff-rev-2", reviewCommand(arraysOf(s)));
  a.equal(cmdAfterTrust.status, 503, "no command after the signer trust change");
  const sync = await h.engine.tick();
  a.equal(sync.length, 1, "the subscription was evaluated");
  a.ok(/TRUST_STORE_CHANGED|BLOCKED_IDENTITY/.test(JSON.stringify(sync)), "synchronization blocked by the trust change: " + JSON.stringify(sync).slice(0, 200));
  const check = await h.call("staff-requester", "POST", "/admin/product-integrations/" + env.id + "/health-check", {});
  a.equal(check.json.data.drift_status, "IDENTITY_MISMATCH", "health check records the identity block");
  const [alert] = await env.hq("SELECT reason_code FROM hq_integration.hq_product_admin_security_audit WHERE action = 'integration.alert' ORDER BY id DESC LIMIT 1");
  a.equal(alert.reason_code, "TRUST_STORE_CHANGED", "alert audited with the revocation reason");
  rec.measurements.source_requests_inside_window = callsAtDenial - callsBeforeTrust;
  a.equal(env.bridgeCalls().length, callsAtDenial, "after the first denial nothing (read, command or sync) reached the source");
});

// ---------------------------------------------------------------------------
journey(12, async (t, a) => {
  const h = await startHarness();
  t.after(h.close);
  const P = h.product;
  const registration = (over) => h.call("staff-requester", "POST", "/admin/product-integrations", {
    product_id: P.PRODUCT_ID, display_name: "Synthetic Third Product", service_instance_id: P.INSTANCE_ID, environment: "test", endpoint_ref: "synthetic-third-test",
    workload_identity: "cf://test/product-admin/synthetic-third", approved_signer_kid: P.signer.kid, allowed_scope: { market: ["NG"], organization: ["cosmicforge"], tenant: ["tenant-a"] }, ...over,
  });
  a.equal((await registration({ product_id: "synthetic-fourth", service_instance_id: "synthetic-fourth-1" })).json.error.reason, "ENDPOINT_PRODUCT_MISMATCH", "independent identity: an endpoint is bound to exactly one product");
  a.equal((await registration({ approved_signer_kid: "unenrolled-signer-1" })).json.error.reason, "SIGNER_NOT_ENROLLED", "only an enrolled manifest signer can be approved");

  const reg = await h.registerAndEnable();
  a.equal((await registration({})).json.error.reason, "ALREADY_REGISTERED", "one live registration per product and environment");
  const [row] = (await h.pool.query("SELECT lifecycle_status, identity_verified_at, manifest_digest FROM hq_integration.hq_product_admins WHERE id = $1", [reg.id])).rows;
  a.equal(row.lifecycle_status, "ENABLED", "registry approval through the generic onboarding flow");
  a.ok(row.identity_verified_at && row.manifest_digest, "signed manifest verified and pinned");
  const [ds] = (await h.pool.query("SELECT approval_status FROM hq_integration.hq_product_admin_datasets WHERE product_admin_id = $1", [reg.id])).rows;
  a.equal(ds.approval_status, "APPROVED", "dataset certified and approved");
  await h.grantViewer();

  const caps = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/capabilities");
  a.equal(caps.status, 200, "dynamic routing to the new product");
  a.equal(caps.json.result.delegated_staff, "staff-viewer", "the product saw the staff delegation");
  P.emitMetric({ value: 17 });
  await h.engine.tick();
  const metric = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
  a.equal(metric.status, 200, "HQ metric projection");
  a.equal(metric.json.result.observations[0].value, 17, "authorized event/metric synchronization");
  a.equal(metric.json.coverage, "COMPLETE", "coverage");
  a.equal((await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-b")).status, 403, "cross-tenant denied");

  const suspended = await h.call("staff-approver", "POST", "/admin/product-integrations/" + reg.id + "/suspend", { expected_revision: reg.revision, reason_code: "JOURNEY_SUSPEND" });
  a.equal(suspended.json.data.lifecycle_status, "SUSPENDED", "suspension: " + JSON.stringify(suspended.json).slice(0, 200));
  const revoked = await h.call("staff-approver", "POST", "/admin/product-integrations/" + reg.id + "/revoke", { expected_revision: suspended.json.data.revision, reason_code: "JOURNEY_REVOKE" });
  a.equal(revoked.json.data.lifecycle_status, "REVOKED", "permanent revocation");
  const requests = P.state.requests;
  P.emitMetric({ value: 99, windowStart: "2026-10-09T00:00:00Z", windowEnd: "2026-10-10T00:00:00Z" });
  a.deepEqual(await h.engine.tick(), [], "revocation stops synchronization");
  a.equal(P.state.requests, requests, "HQ never contacts the revoked product again");
  a.equal((await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a")).status, 404, "no live registration after revocation");

  // No product-specific code in HQ: the PIC engine and the HQ gateway carry
  // no literal for any product.
  const roots = [path.join(__dirname, "..", "src"), path.join(__dirname, "..", "..", "central-admin-api", "src", "modules", "product-gateway")];
  const offenders = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const rel of fs.readdirSync(root, { recursive: true })) {
      if (!rel.endsWith(".js")) continue;
      const code = fs.readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
      if (/["'`][^"'`]*\b(synthetic|karryam|karrygo|healthnet)[^"'`]*["'`]/i.test(code)) offenders.push(path.relative(path.join(__dirname, "..", ".."), path.join(root, rel)));
    }
  }
  a.deepEqual(offenders, [], "no product-specific literal in PIC or the HQ product gateway");
}, 120000);

// ---------------------------------------------------------------------------
test("all twelve journeys executed and passed", { skip }, () => {
  if (missing) throw new Error("JOURNEYS_REQUIRED=1 but " + missing);
  const absent = JOURNEYS.map(([id]) => id).filter((id) => !results.has(id));
  assert.deepEqual(absent, [], "every Section 13.2 journey must run");
  const failed = [...results.values()].filter((r) => r.status !== "PASS").map((r) => r.id);
  assert.deepEqual(failed, [], "every journey must pass");
});

test.after(() => {
  const dir = process.env.JOURNEY_REPORT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const journeys = JOURNEYS.map(([id, name]) => results.get(id) || { id, name, status: skip ? "SKIP" : "NOT_RUN", assertions: [], started_at: null, finished_at: null, measurements: {}, error: skip || null });
  const report = {
    artifact: "product-admin-e2e-journeys",
    schema_version: 1,
    source_sha: sourceSha(),
    environment: "disposable-ci",
    note: "Disposable evidence (disposable PostgreSQL, disposable TLS 1.3 mTLS/HMAC v2/Ed25519 Bridge, synthetic source events). It is NOT staging certification and proves nothing about the real Bridge, real credentials or real data.",
    tool: { node: process.version, runner: "node:test" },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: journeys.every((j) => j.status === "PASS") ? "PASS" : skip ? "SKIP" : "FAIL",
    counts: { total: journeys.length, pass: journeys.filter((j) => j.status === "PASS").length, fail: journeys.filter((j) => j.status === "FAIL").length, not_run: journeys.filter((j) => !["PASS", "FAIL"].includes(j.status)).length },
    journeys: journeys.map((j) => ({ ...j, assertion_count: j.assertions.length })),
  };
  fs.writeFileSync(path.join(dir, "product-admin-e2e-journeys.json"), JSON.stringify(report, null, 2) + "\n");
});
