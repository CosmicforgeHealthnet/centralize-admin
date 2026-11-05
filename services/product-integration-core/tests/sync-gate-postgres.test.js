"use strict";

// PR #55 closure: the synchronization gate is deny-by-default, and the
// cursor never crosses an event HQ could not verify.
//
//  * BREAKING_DETECTED and ADDITIVE_PENDING_REVIEW (review finding 2) block
//    synchronization exactly like identity drift: no Product Admin request,
//    no cursor movement, no ACK, no projection; navigation and reads agree.
//  * The gate is re-evaluated inside every apply and before every ACK, so a
//    drift record, revocation or trust change that lands mid-run stops all
//    later effects.
//  * Recovery needs the legitimate path: re-verification of the approved
//    catalog, or propose -> certify -> activate of a reviewed revision.
//  * An event at the next sequence that fails verification holds the
//    partition (quarantine + hold) until an approved snapshot covers it.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, available } = require("./helpers/harness");
const { createHealthChecker } = require("../src/registry/health");
const T = require("../../../packages/admin-contracts/src/testing");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
const rows = (h, sql, params) => h.pool.query(sql, params).then((r) => r.rows);
const one = async (h, sql, params) => (await rows(h, sql, params))[0];
const inboxCount = async (h) => Number((await one(h, "SELECT count(*) AS n FROM hq_integration.hq_product_admin_event_inbox")).n);
const cursor = (h) => one(h, "SELECT last_sequence::int AS last, acked_sequence::int AS acked, gap_from::int AS gap_from, gap_to::int AS gap_to, hold_reason FROM hq_integration.hq_product_admin_sync_cursors");
const registration = (h, id) => one(h, "SELECT * FROM hq_integration.hq_product_admins WHERE id = $1", [id]);
const healthOf = (h) => createHealthChecker({ pool: h.pool, endpoints: h.endpoints, trustStore: h.trustStore, now: h.now });
const admin = (id, path) => "/admin/product-integrations/" + id + path;
const metricPath = (h) => "/products/" + h.product.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a";
const day = (n) => ({ windowStart: `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`, windowEnd: `2026-10-${String(n + 1).padStart(2, "0")}T00:00:00Z` });

async function synced(h, value, n) {
  h.product.emitMetric({ value, ...day(n) });
  const [run] = await h.engine.tick();
  assert.equal(run.status, "DONE");
}

for (const [label, drifted, expected] of [
  ["breaking", () => ({ datasets: [T.sampleDataset({ version: "1.1.0", semantic_grain: "HOUR" })] }), "BREAKING_DETECTED"],
  ["unapproved additive", () => ({ datasets: [T.sampleDataset({ title: "Daily activity (renamed)" })] }), "ADDITIVE_PENDING_REVIEW"],
]) {
  test(`${label} contract drift blocks all synchronization; navigation and reads agree; approved catalog recovers`, { skip }, async () => {
    const h = await startHarness();
    try {
      const { id } = await h.registerAndEnable();
      await h.grantViewer();
      await synced(h, 5, 1);
      const before = { cursor: await cursor(h), inbox: await inboxCount(h), acks: h.product.state.acks.length };

      h.product.republishManifest({ revision: 2, ...drifted() });
      const check = await healthOf(h).check(await registration(h, id));
      assert.equal(check.drift_status, expected);
      const digestBefore = (await registration(h, id)).manifest_digest;

      h.product.emitMetric({ value: 6, ...day(2) });
      const requests = h.product.state.requests;
      const [blocked] = await h.engine.tick();
      assert.equal(blocked.status, "BLOCKED_CONTRACT_DRIFT");
      assert.equal(blocked.reason, expected);
      assert.equal(h.product.state.requests, requests, "no request reached the Product Admin");
      assert.deepEqual(await cursor(h), before.cursor, "cursor unchanged");
      assert.equal(await inboxCount(h), before.inbox, "nothing applied");
      assert.equal(h.product.state.acks.length, before.acks, "no ACK sent");
      const alert = await one(h, "SELECT reason_code FROM hq_integration.hq_product_admin_security_audit WHERE action = 'integration.alert' AND reason_code = $1 LIMIT 1", [expected]);
      assert.ok(alert, "sanitized block reason recorded");
      assert.equal((await registration(h, id)).sync_status, "FAILING");

      // Navigation and every live read report the same block.
      const nav = (await h.call("staff-viewer", "GET", "/products")).json.data.products[0];
      assert.equal(nav.available, false);
      assert.equal(nav.reason, "CONTRACT_DRIFT");
      assert.equal(nav.navigation, null);
      for (const path of [metricPath(h), "/products/" + h.product.PRODUCT_ID + "/datasets", "/products/" + h.product.PRODUCT_ID + "/capabilities"]) {
        const r = await h.call("staff-viewer", "GET", path);
        assert.equal(r.status, 503, path);
        assert.equal(r.json.error.reason, "CONTRACT_DRIFT", path);
      }
      // Diagnostics stay readable and show the drift.
      const manifest = await h.call("staff-viewer", "GET", "/products/" + h.product.PRODUCT_ID + "/manifest");
      assert.equal(manifest.status, 200);
      assert.equal(manifest.json.result.drift_status, expected);
      const status = await h.call("staff-viewer", "GET", "/products/" + h.product.PRODUCT_ID + "/events/status");
      assert.equal(status.json.result.drift.status, expected);

      // A fresh health check of the same drifted manifest does not refresh
      // the stored manifest or clear the drift.
      assert.equal((await healthOf(h).check(await registration(h, id))).drift_status, expected);
      assert.equal((await registration(h, id)).manifest_digest, digestBefore);

      // No new dataset activation while the drift is unresolved.
      const subscriptionId = (await one(h, "SELECT id FROM hq_integration.hq_product_admin_subscriptions")).id;
      const enable = await h.call("staff-requester", "POST", admin(id, "/subscriptions/" + subscriptionId + "/enable"), {});
      assert.equal(enable.status, 409);
      assert.equal(enable.json.error.reason, "CONTRACT_DRIFT_UNRESOLVED");

      // The product goes back to the approved catalog: re-verification clears
      // the drift, and synchronization resumes from the committed cursor.
      h.product.republishManifest({ revision: 3, datasets: [T.sampleDataset()] });
      assert.equal((await healthOf(h).check(await registration(h, id))).drift_status, "NONE");
      const [resumed] = await h.engine.tick();
      assert.equal(resumed.status, "DONE");
      assert.equal(await inboxCount(h), before.inbox + 1);
      assert.equal((await h.call("staff-viewer", "GET", "/products")).json.data.products[0].available, true);
    } finally { await h.close(); }
  });
}

test("an unapproved additive revision stays blocked until proposed, independently certified and activated", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id } = await h.registerAndEnable();
    await synced(h, 1, 1);
    h.product.republishManifest({ revision: 2, datasets: [T.sampleDataset({ title: "Daily activity v2" })] });
    assert.equal((await healthOf(h).check(await registration(h, id))).drift_status, "ADDITIVE_PENDING_REVIEW");
    h.product.emitMetric({ value: 2, ...day(2) });
    assert.equal((await h.engine.tick())[0].status, "BLOCKED_CONTRACT_DRIFT");

    const proposed = await h.call("staff-requester", "POST", admin(id, "/contracts/propose"), {});
    assert.equal(proposed.status, 200);
    assert.equal(proposed.json.data.decision, "COMPATIBLE_ADDITIVE");
    assert.equal((await h.engine.tick())[0].status, "BLOCKED_CONTRACT_DRIFT", "a proposal alone does not unblock");
    const contractId = proposed.json.data.contract_id;
    const certified = await h.call("staff-reviewer", "POST", admin(id, "/contracts/" + contractId + "/certify"), { evidence_ref: "review:additive-1" });
    assert.equal(certified.status, 200);
    assert.equal((await h.engine.tick())[0].status, "BLOCKED_CONTRACT_DRIFT", "certification alone does not unblock");
    const activated = await h.call("staff-approver", "POST", admin(id, "/contracts/" + contractId + "/activate"), { expected_revision: (await registration(h, id)).revision });
    assert.equal(activated.status, 200, JSON.stringify(activated.json));
    assert.equal((await healthOf(h).check(await registration(h, id))).drift_status, "NONE");
    const [resumed] = await h.engine.tick();
    assert.equal(resumed.status, "DONE");
    assert.equal(await inboxCount(h), 2);
  } finally { await h.close(); }
});

test("activation re-compares against the contract active now: a revision made breaking by another activation is refused", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id } = await h.registerAndEnable();
    const base = T.sampleManifest().capabilities;
    const extra = { ...base[0], id: "synthetic.weekly.read", description: "Read weekly metrics" };
    // Revision B adds a capability; revision C (proposed against the same
    // active contract A) only renames the dataset. Each is additive vs A.
    h.product.republishManifest({ revision: 2, capabilities: [...base, extra] });
    await healthOf(h).check(await registration(h, id));
    const b = (await h.call("staff-requester", "POST", admin(id, "/contracts/propose"), {})).json.data;
    h.product.republishManifest({ revision: 3, capabilities: base, datasets: [T.sampleDataset({ title: "Renamed" })] });
    await healthOf(h).check(await registration(h, id));
    const c = (await h.call("staff-requester", "POST", admin(id, "/contracts/propose"), {})).json.data;
    assert.equal(b.decision, "COMPATIBLE_ADDITIVE");
    assert.equal(c.decision, "COMPATIBLE_ADDITIVE");
    for (const contract of [b, c]) {
      assert.equal((await h.call("staff-reviewer", "POST", admin(id, "/contracts/" + contract.contract_id + "/certify"), { evidence_ref: "review:" + contract.revision })).status, 200);
    }
    const activateB = await h.call("staff-approver", "POST", admin(id, "/contracts/" + b.contract_id + "/activate"), { expected_revision: (await registration(h, id)).revision });
    assert.equal(activateB.status, 200);
    // C vs the now-active B removes B's capability: breaking, so refused even
    // though its stored comparison (vs A) said additive.
    const activateC = await h.call("staff-approver", "POST", admin(id, "/contracts/" + c.contract_id + "/activate"), { expected_revision: (await registration(h, id)).revision });
    assert.equal(activateC.status, 409);
    assert.equal(activateC.json.error.reason, "BREAKING_CHANGE_REJECTED");
    const active = await one(h, "SELECT id FROM hq_integration.hq_product_admin_contracts WHERE product_admin_id = $1 AND status = 'ACTIVE'", [id]);
    assert.equal(active.id, b.contract_id);
  } finally { await h.close(); }
});

test("drift, revocation or a trust change recorded mid-run stops all later effects; the gate is re-checked per transaction", { skip }, async () => {
  const cases = [
    ["drift", (h) => h.pool.query("UPDATE hq_integration.hq_product_admins SET drift_status = 'BREAKING_DETECTED'"), "BLOCKED", "BREAKING_DETECTED"],
    ["manifest expiry", (h) => h.pool.query("UPDATE hq_integration.hq_product_admins SET manifest_expires_at = now() - interval '1 second'"), "BLOCKED", "MANIFEST_EXPIRED"],
    ["trust change", (h, trust) => { trust.current = false; }, "BLOCKED", "TRUST_STORE_CHANGED"],
    ["revocation", async (h) => {
      const r = await registration(h, (await one(h, "SELECT id FROM hq_integration.hq_product_admins")).id);
      const s = await h.call("staff-approver", "POST", admin(r.id, "/suspend"), { expected_revision: r.revision, reason_code: "TEST_SUSPEND" });
      assert.equal(s.status, 200);
    }, "ABORTED_REVOKED", null],
  ];
  for (const [label, change, status, reason] of cases) {
    const h = await startHarness();
    try {
      await h.registerAndEnable();
      const trust = { current: true };
      const trustStore = { ...h.trustStore };
      Object.defineProperty(trustStore, "isCurrent", { enumerable: false, value: () => trust.current });
      for (let n = 1; n <= 3; n += 1) h.product.emitMetric({ value: n, ...day(n) });
      let fired = false;
      const engine = h.makeEngine({ workerId: "pic-worker-midrun", trustStore, hooks: { afterCommit: async () => { if (!fired) { fired = true; await change(h, trust); } } } });
      const [run] = await engine.tick();
      const partition = run.results.find((r) => r.partitionKey === "NG-LAGOS");
      assert.equal(partition.status, status, label);
      if (reason) assert.equal(partition.reason, reason, label);
      assert.equal(await inboxCount(h), 1, label + ": only the event committed before the change");
      const c = await cursor(h);
      assert.equal(c.last, 1, label);
      assert.equal(c.acked, 0, label + ": nothing ACKed after the gate closed");
      assert.equal(h.product.state.acks.length, 0, label);
    } finally { await h.close(); }
  }
});

test("the ACK is withheld if the gate closes between commit and ACK, and retried after legitimate recovery", { skip }, async () => {
  const h = await startHarness();
  try {
    const { id } = await h.registerAndEnable();
    h.product.emitMetric({ value: 1, ...day(1) });
    const engine = h.makeEngine({ workerId: "pic-worker-ack", hooks: { beforeAck: () => h.pool.query("UPDATE hq_integration.hq_product_admins SET drift_status = 'ADDITIVE_PENDING_REVIEW'") } });
    const [run] = await engine.tick();
    const partition = run.results.find((r) => r.partitionKey === "NG-LAGOS");
    assert.equal(partition.ackStatus, "SKIPPED_BLOCKED");
    assert.equal(partition.status, "BLOCKED");
    assert.deepEqual(h.product.state.acks, []);
    let c = await cursor(h);
    assert.equal(c.last, 1);
    assert.equal(c.acked, 0);
    const recorded = await one(h, "SELECT status, ack_status FROM hq_integration.hq_product_admin_sync_runs WHERE ack_status = 'SKIPPED_BLOCKED'");
    assert.equal(recorded.status, "BLOCKED");
    // The approved catalog is re-verified: the pending ACK is sent first.
    assert.equal((await healthOf(h).check(await registration(h, id))).drift_status, "NONE");
    await h.engine.tick();
    c = await cursor(h);
    assert.equal(c.acked, 1);
    assert.equal(await inboxCount(h), 1, "the committed event was not re-applied");
  } finally { await h.close(); }
});

test("an unverifiable event at the next sequence holds the cursor; nothing after it is applied or ACKed; an approved snapshot recovers", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitMetric({ value: 1, ...day(1) });
    h.product.emitMetric({ value: 2, ...day(2), overrides: { family: "synthetic.unknown_family" } });
    h.product.emitMetric({ value: 3, ...day(3) });
    h.product.state.snapshotThroughOverride = 1; // the snapshot does not cover the hold yet
    const [run] = await h.engine.tick();
    const partition = run.results.find((r) => r.partitionKey === "NG-LAGOS");
    assert.equal(partition.status, "PARTIAL_GAP");
    assert.equal(partition.quarantined, 1);
    assert.equal(await inboxCount(h), 1, "event 3 is not applied past the hold");
    let c = await cursor(h);
    assert.deepEqual([c.last, c.acked, c.gap_from, c.gap_to, c.hold_reason], [1, 1, 2, 2, "UNKNOWN_EVENT_FAMILY"]);
    assert.ok(h.product.state.acks.every((a) => a.sequence <= 1), "never ACKed past the hold");
    const q = await one(h, "SELECT sequence::int AS sequence, reason_code, resolved_at, detail FROM hq_integration.hq_product_admin_quarantine");
    assert.equal(q.sequence, 2);
    assert.equal(q.resolved_at, null);
    assert.ok(q.detail.correlation_id && !("payload" in q.detail), "safe metadata only");

    // Redelivery does not get past the hold either.
    await h.engine.tick();
    c = await cursor(h);
    assert.equal(c.last, 1);
    assert.equal(c.gap_from, 2);

    // A complete, approved snapshot covering the hold recovers the partition.
    h.product.state.snapshotThroughOverride = null;
    await h.engine.tick();
    c = await cursor(h);
    assert.equal(c.gap_from, null);
    assert.equal(c.hold_reason, null);
    assert.equal(c.last, 3);
    const resolved = await one(h, "SELECT resolution, resolved_at FROM hq_integration.hq_product_admin_quarantine");
    assert.equal(resolved.resolution, "SUPERSEDED_BY_SNAPSHOT");
    assert.ok(resolved.resolved_at, "the quarantine record is kept and marked resolved");
    const sub = await one(h, "SELECT gap_status FROM hq_integration.hq_product_admin_subscriptions");
    assert.equal(sub.gap_status, "NONE");
  } finally { await h.close(); }
});

test("a reused event id with a changed payload at a new sequence is an integrity failure that holds the cursor", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    const first = h.product.emitMetric({ value: 10, ...day(1) });
    await h.engine.tick();
    h.product.emitMetric({ value: 11, ...day(2), overrides: { event_id: first.event_id } });
    h.product.emitMetric({ value: 12, ...day(3) });
    h.product.state.snapshotThroughOverride = 1;
    await h.engine.tick();
    const c = await cursor(h);
    assert.deepEqual([c.last, c.gap_from, c.hold_reason], [1, 2, "DIGEST_CONFLICT"]);
    assert.equal(await inboxCount(h), 1);
    const metric = await one(h, "SELECT value::int AS value FROM hq_integration.hq_product_admin_metrics");
    assert.equal(metric.value, 10, "the original projection is untouched");
  } finally { await h.close(); }
});

test("a payload outside the approved event schema holds a non-metric partition as well", { skip }, async () => {
  const h = await startHarness();
  try {
    await h.registerAndEnable();
    h.product.emitStatus({ status: "COMPLETED" });
    h.product.emitStatus({ payload: { status: "COMPLETED", customer_phone: "+2340000000" } });
    h.product.emitStatus({ status: "CANCELLED", entityId: "order-2" });
    await h.engine.tick();
    const c = await cursor(h);
    assert.deepEqual([c.last, c.acked, c.gap_from, c.gap_to], [1, 1, 2, 2]);
    assert.match(c.hold_reason, /SCHEMA|PAYLOAD/);
    assert.equal(await inboxCount(h), 1);
    const quarantined = await rows(h, "SELECT reason_code, detail FROM hq_integration.hq_product_admin_quarantine");
    assert.ok(!JSON.stringify(quarantined).includes("+2340000000"), "quarantine does not retain the rejected payload");
  } finally { await h.close(); }
});
