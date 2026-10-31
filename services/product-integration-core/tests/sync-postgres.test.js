"use strict";

// Synchronization edge cases beyond the conformance walk-through.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, available } = require("./helpers/harness");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
const rows = (h, sql, params) => h.pool.query(sql, params).then((r) => r.rows);
const metricValue = async (h) => (await rows(h, "SELECT value, source_entity_version, version FROM hq_integration.hq_product_admin_metrics ORDER BY window_start LIMIT 1"))[0];

test("an older entity version never replaces a newer projection", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitMetric({ value: 10, entityVersion: 5 });
    h.product.emitMetric({ value: 99, entityVersion: 3 });
    await h.engine.tick();
    const m = await metricValue(h);
    assert.equal(Number(m.value), 10);
    assert.equal(Number(m.source_entity_version), 5);
    const apps = await rows(h, "SELECT sequence, application FROM hq_integration.hq_product_admin_event_inbox ORDER BY sequence");
    assert.deepEqual(apps.map((a) => a.application), ["APPLIED", "STALE_IGNORED"]);
    h.product.emitMetric({ value: 11, entityVersion: 6 });
    await h.engine.tick();
    const newer = await metricValue(h);
    assert.equal(Number(newer.value), 11);
    assert.equal(newer.version, 2); // version-protected update bumped the projection version
  } finally { await h.close(); }
});

test("out-of-order delivery within a page is applied in sequence order", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    const e1 = h.product.emitMetric({ value: 1, windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-02T00:00:00Z" });
    const e2 = h.product.emitMetric({ value: 2, windowStart: "2026-10-02T00:00:00Z", windowEnd: "2026-10-03T00:00:00Z" });
    const list = h.product.partitionEvents("NG-LAGOS");
    list.reverse(); // the product hands them out of order
    await h.engine.tick();
    const seqs = await rows(h, "SELECT sequence, event_id FROM hq_integration.hq_product_admin_event_inbox ORDER BY id");
    assert.deepEqual(seqs.map((s) => Number(s.sequence)), [1, 2]);
    assert.deepEqual(seqs.map((s) => s.event_id), [e1.event_id, e2.event_id]);
  } finally { await h.close(); }
});

test("ACK failure after commit is retried without re-applying events", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitMetric({ value: 5 });
    h.product.state.ackFailuresRemaining = 1;
    const first = await h.engine.tick();
    assert.equal(first[0].results[0].ackStatus, "ACK_FAILED");
    let [cursor] = await rows(h, "SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors");
    assert.equal(Number(cursor.last_sequence), 1);
    assert.equal(Number(cursor.acked_sequence), 0);
    const failedRuns = await rows(h, "SELECT ack_status FROM hq_integration.hq_product_admin_sync_runs WHERE ack_status = 'ACK_FAILED'");
    assert.equal(failedRuns.length, 1);
    await h.engine.tick();
    [cursor] = await rows(h, "SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors");
    assert.equal(Number(cursor.acked_sequence), 1);
    const inbox = await rows(h, "SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox");
    assert.equal(inbox[0].n, 1);
    assert.equal((await metricValue(h)).version, 1);
    const alerts = await rows(h, "SELECT reason_code FROM hq_integration.hq_product_admin_security_audit WHERE action = 'integration.alert' AND reason_code = 'ACK_FAILED'");
    assert.ok(alerts.length >= 1);
  } finally { await h.close(); }
});

test("revocation mid-synchronization stops consumption at the next event and sends no ACK", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id } = await h.registerAndEnable();
    for (let i = 0; i < 3; i += 1) h.product.emitMetric({ value: i, windowStart: `2026-10-0${i + 1}T00:00:00Z`, windowEnd: `2026-10-0${i + 2}T00:00:00Z` });
    let revoked = false;
    const engine = h.makeEngine({ workerId: "pic-worker-revoke", hooks: { afterCommit: async () => {
      if (revoked) return;
      revoked = true;
      const [{ revision }] = await rows(h, "SELECT revision FROM hq_integration.hq_product_admins WHERE id = $1", [id]);
      const r = await h.call("staff-approver", "POST", "/admin/product-integrations/" + id + "/revoke", { expected_revision: revision, reason_code: "SECURITY_INCIDENT" });
      assert.equal(r.status, 200);
    } } });
    await engine.tick();
    const inbox = await rows(h, "SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox");
    assert.equal(inbox[0].n, 1);
    assert.equal(h.product.state.acks.length, 0);
    const [run] = await rows(h, "SELECT status FROM hq_integration.hq_product_admin_sync_runs WHERE worker_id = 'pic-worker-revoke' ORDER BY started_at DESC LIMIT 1");
    assert.equal(run.status, "ABORTED_REVOKED");
    const before = h.product.state.requests;
    assert.deepEqual(await h.engine.tick(), []);
    assert.equal(h.product.state.requests, before);
  } finally { await h.close(); }
});

// Previously the cursor advanced (and was ACKed) past both rejected events,
// so the product could discard events HQ never verified. Now the first
// unverifiable event holds the partition until reconciliation covers it.
test("unknown schemas and unsupported families are quarantined and hold the cursor; coverage becomes partial", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitMetric({ value: 1, overrides: { family: "synthetic.unknown_family" } });
    h.product.emitMetric({ value: 2, overrides: { schema_version: "1.4.0" } });
    h.product.emitMetric({ value: 3, windowStart: "2026-10-09T00:00:00Z", windowEnd: "2026-10-10T00:00:00Z" });
    h.product.state.snapshotThroughOverride = 0; // no approved snapshot covers the hold yet
    await h.engine.tick();
    await h.engine.tick(); // redelivery and reconciliation attempts do not get past it
    const reasons = (await rows(h, "SELECT reason_code FROM hq_integration.hq_product_admin_quarantine ORDER BY sequence")).map((r) => r.reason_code);
    assert.deepEqual(reasons, ["UNKNOWN_EVENT_FAMILY"]);
    const [cursor] = await rows(h, "SELECT last_sequence, acked_sequence, gap_from, gap_to, hold_reason FROM hq_integration.hq_product_admin_sync_cursors");
    assert.equal(Number(cursor.last_sequence), 0);
    assert.equal(Number(cursor.acked_sequence), 0);
    assert.deepEqual([Number(cursor.gap_from), Number(cursor.gap_to), cursor.hold_reason], [1, 1, "UNKNOWN_EVENT_FAMILY"]);
    assert.deepEqual(h.product.state.acks, []);
    assert.equal((await rows(h, "SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox"))[0].n, 0);
    const [sub] = await rows(h, "SELECT coverage, quarantined_count, gap_status FROM hq_integration.hq_product_admin_subscriptions");
    assert.equal(sub.coverage, "PARTIAL");
    assert.equal(sub.gap_status, "GAP_DETECTED");
    assert.equal(sub.quarantined_count, 1);
    const detail = await rows(h, "SELECT detail FROM hq_integration.hq_product_admin_quarantine");
    assert.ok(detail.every((d) => !("payload" in d.detail))); // quarantine never stores raw payloads
  } finally { await h.close(); }
});

test("a superseded lease holder is fenced out and cannot commit", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    for (let i = 0; i < 3; i += 1) h.product.emitMetric({ value: i, windowStart: `2026-10-1${i}T00:00:00Z`, windowEnd: `2026-10-1${i + 1}T00:00:00Z` });
    let tookOver = false;
    const slow = h.makeEngine({ workerId: "pic-worker-slow", hooks: { afterCommit: async () => {
      if (tookOver) return;
      tookOver = true;
      h.clock.offsetMs = 120000; // lease of the slow worker expires
      await h.makeEngine({ workerId: "pic-worker-fast" }).tick();
    } } });
    await slow.tick();
    h.clock.offsetMs = 0;
    const runs = await rows(h, "SELECT worker_id, status FROM hq_integration.hq_product_admin_sync_runs WHERE run_kind = 'EVENTS' ORDER BY started_at");
    assert.ok(runs.some((r) => r.worker_id === "pic-worker-slow" && r.status === "LEASE_LOST"));
    const inbox = await rows(h, "SELECT count(*)::int AS n, count(DISTINCT sequence)::int AS d FROM hq_integration.hq_product_admin_event_inbox");
    assert.equal(inbox[0].n, 3);
    assert.equal(inbox[0].d, 3);
    await assert.rejects(h.pool.query("UPDATE hq_integration.hq_product_admin_sync_cursors SET last_sequence = 1"), /monotonic/);
  } finally { await h.close(); }
});

test("unapproved and restricted datasets never synchronize", { skip }, async () => {
  const h = await startHarness();
  const T = require("../../../packages/admin-contracts/src/testing");
  const C = require("../../../packages/admin-contracts");
  try {
    const restricted = T.sampleDataset({ dataset_id: "synthetic.rider_contacts", schema_id: "synthetic.rider_contacts", privacy_class: "RESTRICTED_PII", allowed_fields: [{ name: "rider_phone", type: "string", classification: "RESTRICTED_PII", meaning: "Phone number", unit: null }], metrics: [], units: [] });
    h.product.republishManifest({ datasets: [T.sampleDataset(), restricted], eventFamilies: [C.standardMetricObservationFamily({ family: "synthetic.metric_observation", datasetId: "synthetic.daily_activity" })] });
    const reg = await h.call("staff-requester", "POST", "/admin/product-integrations", { product_id: "synthetic-third", display_name: "Synthetic", service_instance_id: "synthetic-third-test-1", environment: "test", endpoint_ref: "synthetic-third-test", workload_identity: "cf://test/product-admin/synthetic-third", approved_signer_kid: h.product.signer.kid, allowed_scope: { market: ["NG"], organization: ["cosmicforge"] } });
    const id = reg.json.data.id;
    let rev = reg.json.data.revision;
    for (const [who, path] of [["staff-requester", "/verify-identity"], ["staff-requester", "/validate-contract"], ["staff-reviewer", "/review-policy"]]) {
      const r = await h.call(who, "POST", "/admin/product-integrations/" + id + path, { expected_revision: rev });
      assert.equal(r.status, 200, path);
      rev = r.json.data.revision;
    }
    const pii = await h.call("staff-reviewer", "POST", "/admin/product-integrations/" + id + "/datasets/synthetic.rider_contacts/approve", { version: "1.0.0" });
    assert.equal(pii.status, 422);
    assert.equal(pii.json.error.reason, "RESTRICTED_DATASET");
    const sub = await h.call("staff-requester", "POST", "/admin/product-integrations/" + id + "/subscriptions", { dataset_id: "synthetic.daily_activity", version: "1.0.0", consumer_department: "analytics", allowed_scope: { market: ["NG"], organization: ["cosmicforge"] } });
    assert.equal(sub.status, 409);
    assert.equal(sub.json.error.reason, "DATASET_NOT_APPROVED");
    await assert.rejects(h.pool.query("UPDATE hq_integration.hq_product_admin_datasets SET approval_status = 'APPROVED', approved_by = 'x', approved_at = now() WHERE dataset_id = 'synthetic.rider_contacts'"));
  } finally { await h.close(); }
});

test("scheduled runs honour the subscription poll interval; operator runs do not", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitMetric({ value: 1 });
    assert.equal((await h.engine.tick({ scheduled: true })).length, 1);
    h.product.emitMetric({ value: 2, windowStart: "2026-10-02T00:00:00Z", windowEnd: "2026-10-03T00:00:00Z" });
    assert.equal((await h.engine.tick({ scheduled: true })).length, 0); // polled less than 30 s ago
    h.clock.offsetMs = 31000;
    assert.equal((await h.engine.tick({ scheduled: true })).length, 1);
    h.clock.offsetMs = 0;
    assert.equal((await h.engine.tick()).length, 1); // operator-triggered: always runs
  } finally { await h.close(); }
});

test("a standard non-metric event is validated, persisted without projection, sequenced and ACKed after commit", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    const committedAtAck = [];
    h.product.state.onAck = async (body) => {
      const r = await rows(h, "SELECT count(*) AS n FROM hq_integration.hq_product_admin_event_inbox WHERE sequence <= $1", [body.sequence]);
      committedAtAck.push(Number(r[0].n));
    };
    const status = h.product.emitStatus({ status: "COMPLETED" });
    const offSchema = h.product.emitStatus({ payload: { status: "COMPLETED", customer_phone: "+2340000000" } });
    h.product.state.snapshotThroughOverride = 0;
    const [run] = await h.engine.tick();
    assert.equal(run.status, "DONE");
    const inbox = await rows(h, "SELECT event_id, family, application FROM hq_integration.hq_product_admin_event_inbox ORDER BY sequence");
    assert.deepEqual(inbox.map((e) => [e.event_id, e.family, e.application]), [[status.event_id, h.product.STATUS_FAMILY || "synthetic.order_status_changed", "NO_PROJECTION"]]);
    assert.equal((await rows(h, "SELECT count(*) AS n FROM hq_integration.hq_product_admin_metrics"))[0].n, "0", "no metric is fabricated from a status event");
    const quarantined = await rows(h, "SELECT reason_code, detail FROM hq_integration.hq_product_admin_quarantine");
    assert.equal(quarantined.length, 1, "payload outside the approved schema is quarantined");
    assert.match(quarantined[0].reason_code, /SCHEMA|PAYLOAD/, quarantined[0].reason_code);
    assert.ok(!JSON.stringify(quarantined).includes("+2340000000"), "quarantine does not retain the rejected payload");
    // The off-schema event holds the cursor: only sequence 1 is committed and ACKed.
    const [cursor] = await rows(h, "SELECT last_sequence, acked_sequence, gap_from FROM hq_integration.hq_product_admin_sync_cursors");
    assert.equal(Number(cursor.last_sequence), 1);
    assert.equal(Number(cursor.acked_sequence), 1);
    assert.equal(Number(cursor.gap_from), 2);
    assert.ok(committedAtAck.length > 0 && committedAtAck.every((n) => n >= 1), "ACK observed committed rows");
    assert.ok(h.product.state.acks.every((a) => a.sequence <= 1), "never ACKed past the held event");
    assert.equal(offSchema.sequence, 2);
  } finally { await h.close(); }
});
