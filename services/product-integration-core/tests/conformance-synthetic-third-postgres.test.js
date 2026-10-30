"use strict";

// Section 5.10 — Universal onboarding conformance.
// A synthetic third Product Admin (not Karryam, not HealthNet) is onboarded,
// synchronized, attacked and revoked through the generic HQ engine. If this
// test needs a product-specific branch anywhere in src/, the platform is not
// universal (see static-boundaries.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, available } = require("./helpers/harness");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";
const q = (h, sql, params) => h.pool.query(sql, params).then((r) => r.rows);

test("synthetic third product: universal onboarding, sync, faults and revocation (20 steps)", { skip, timeout: 120000 }, async (t) => {
  const h = await startHarness();
  const P = h.product;
  const admin = (id, path = "") => "/admin/product-integrations/" + id + path;
  try {
    let id;
    let rev;
    const step = async (who, path, body = {}, expectStatus = 200) => {
      const r = await h.call(who, "POST", admin(id, path), { expected_revision: rev, ...body });
      assert.equal(r.status, expectStatus, path + " -> " + JSON.stringify(r.json));
      if (r.status === 200 && r.json.data && r.json.data.revision) rev = r.json.data.revision;
      return r;
    };

    await t.test("1. register the third product as untrusted", async () => {
      const r = await h.call("staff-requester", "POST", "/admin/product-integrations", {
        product_id: P.PRODUCT_ID, display_name: "Synthetic Third Product", service_instance_id: P.INSTANCE_ID, environment: "test",
        endpoint_ref: "synthetic-third-test", workload_identity: "cf://test/product-admin/synthetic-third", approved_signer_kid: P.signer.kid,
        allowed_scope: { market: ["NG", "GH"], organization: ["cosmicforge"], tenant: ["tenant-a", "tenant-b"] },
      });
      assert.equal(r.status, 201);
      assert.equal(r.json.data.lifecycle_status, "REQUESTED");
      id = r.json.data.id;
      rev = r.json.data.revision;
      // Untrusted: nothing is scheduled and nobody can see it as available.
      assert.deepEqual(await h.engine.tick(), []);
      assert.equal(P.state.acks.length, 0);
    });

    await t.test("2. validate the service identity", async () => {
      const r = await step("staff-requester", "/verify-identity");
      assert.equal(r.json.data.lifecycle_status, "IDENTITY_VERIFIED");
      assert.ok(r.json.data.identity_verified_at);
    });

    await t.test("3. validate the signed manifest into an immutable contract revision", async () => {
      const r = await step("staff-requester", "/validate-contract");
      assert.equal(r.json.data.lifecycle_status, "CONTRACT_VALIDATED");
      const [contract] = await q(h, "SELECT status, catalog_digest FROM hq_integration.hq_product_admin_contracts WHERE product_admin_id = $1", [id]);
      assert.equal(contract.status, "VALIDATED");
      await assert.rejects(q(h, "UPDATE hq_integration.hq_product_admin_contracts SET catalog = '{}' WHERE product_admin_id = $1", [id]), /immutable/);
    });

    await t.test("4. approve the compatible contract revision (independent reviewer)", async () => {
      const self = await h.call("staff-requester", "POST", admin(id, "/review-policy"), { expected_revision: rev });
      assert.equal(self.status, 403); // requester cannot review own request (no grant and not independent)
      await h.bootstrapPlatformGrant("staff-requester-2", ["integration.review"]);
      const r = await step("staff-reviewer", "/review-policy", { evidence_ref: "review:policy-1" });
      assert.equal(r.json.data.lifecycle_status, "POLICY_REVIEWED");
      const stale = await h.call("staff-reviewer", "POST", admin(id, "/certify-staging"), { expected_revision: rev - 1, evidence_ref: "ci:x" });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error.reason, "STALE_REVISION");
    });

    await t.test("5. approve a dataset", async () => {
      const r = await h.call("staff-reviewer", "POST", admin(id, "/datasets/" + P.DATASET_ID + "/approve"), { version: "1.0.0" });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.approval_status, "APPROVED");
      const unknown = await h.call("staff-reviewer", "POST", admin(id, "/datasets/synthetic.unknown/approve"), { version: "1.0.0" });
      assert.equal(unknown.status, 404);
    });

    await t.test("6. grant a staff member explicit product access", async () => {
      await h.grantViewer("staff-viewer");
      const self = await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: P.PRODUCT_ID, staff_id: "staff-requester", actions: ["product.view"], scope: { market: ["NG"], organization: ["cosmicforge"] } });
      assert.equal(self.status, 403);
      const before = await h.call("staff-viewer", "GET", "/products");
      assert.equal(before.json.data.products[0].available, false);
      assert.equal(before.json.data.products[0].reason, "NOT_ENABLED");
    });

    await t.test("7. move through the remaining onboarding transitions", async () => {
      const r = await step("staff-reviewer", "/certify-staging", { evidence_ref: "ci:conformance-run-1" });
      assert.equal(r.json.data.lifecycle_status, "CERTIFIED_STAGING");
      const requesterApproves = await h.call("staff-requester", "POST", admin(id, "/approve"), { expected_revision: rev });
      assert.equal(requesterApproves.status, 403);
      await h.bootstrapPlatformGrant("staff-reviewer-approver", ["integration.approve"]);
      // The certifier cannot also be the final approver.
      await h.bootstrapPlatformGrant("staff-reviewer", ["integration.approve"]);
      const certifierApproves = await h.call("staff-reviewer", "POST", admin(id, "/approve"), { expected_revision: rev });
      assert.equal(certifierApproves.status, 403);
      assert.equal(certifierApproves.json.error.reason, "INDEPENDENT_APPROVER_REQUIRED");
    });

    await t.test("8. activate the approved integration in the test environment", async () => {
      const r = await step("staff-approver", "/approve");
      assert.equal(r.json.data.lifecycle_status, "ENABLED");
      const sub = await h.call("staff-requester", "POST", admin(id, "/subscriptions"), { dataset_id: P.DATASET_ID, version: "1.0.0", consumer_department: "analytics", allowed_scope: { market: ["NG"], organization: ["cosmicforge"], tenant: ["tenant-a"] }, enabled: true });
      assert.equal(sub.status, 201);
      const list = await h.call("staff-viewer", "GET", "/products");
      const item = list.json.data.products.find((p) => p.product_id === P.PRODUCT_ID);
      assert.equal(item.available, true);
      assert.deepEqual(item.navigation, { section: "products", key: P.PRODUCT_ID, label: "Synthetic Third Product" });
      assert.equal(item.datasets[0].granted, true);
      const history = await h.call("staff-approver", "GET", admin(id));
      assert.deepEqual(history.json.data.history.filter((x) => x.decision === "TRANSITION").map((x) => x.to_status), ["DRAFT", "REQUESTED", "IDENTITY_VERIFIED", "CONTRACT_VALIDATED", "POLICY_REVIEWED", "CERTIFIED_STAGING", "ENABLED"]);
    });

    let firstEvent;
    await t.test("9-13. receive a standard metric event, persist it, advance the cursor, ACK after commit", async () => {
      const ackSawCommit = [];
      P.state.onAck = async (body) => {
        const rows = await q(h, "SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_event_inbox WHERE product_admin_id = $1 AND sequence <= $2", [id, body.sequence]);
        ackSawCommit.push(rows[0].n);
      };
      firstEvent = P.emitMetric({ value: 42 });
      const before = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
      assert.equal(before.status, 503); // nothing observed yet: unavailable, never zero
      assert.equal(before.json.error.reason, "NO_SOURCE_OBSERVATION");
      await h.engine.tick();
      const [inbox] = await q(h, "SELECT event_id, sequence, application FROM hq_integration.hq_product_admin_event_inbox WHERE product_admin_id = $1", [id]);
      assert.equal(inbox.event_id, firstEvent.event_id);
      assert.equal(inbox.application, "APPLIED");
      const [cursor] = await q(h, "SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors");
      assert.equal(Number(cursor.last_sequence), 1);
      assert.equal(Number(cursor.acked_sequence), 1);
      assert.deepEqual(P.state.acks.map((a) => a.sequence), [1]);
      assert.deepEqual(ackSawCommit, [1]); // the ACK arrived only after the event was durably committed
      const metric = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
      assert.equal(metric.status, 200);
      assert.equal(metric.json.result.observations[0].value, 42);
      assert.equal(metric.json.coverage, "COMPLETE");
      assert.ok(metric.json.as_of);
      const [lineage] = await q(h, "SELECT operation, source_sequence FROM hq_integration.hq_product_admin_lineage WHERE product_admin_id = $1", [id]);
      assert.equal(lineage.operation, "APPLY_EVENT");
      P.state.onAck = null;
    });

    await t.test("14. reject a duplicate event with a changed digest", async () => {
      const tampered = structuredClone(firstEvent);
      tampered.payload.value = 9999;
      tampered.payload_digest = require("../../../packages/event-contracts").payloadDigest(tampered.payload);
      P.state.extraDeliveries.push(tampered, structuredClone(firstEvent));
      const result = await h.engine.tick();
      const [quarantined] = await q(h, "SELECT reason_code, event_id FROM hq_integration.hq_product_admin_quarantine WHERE product_admin_id = $1", [id]);
      assert.equal(quarantined.reason_code, "DIGEST_CONFLICT");
      assert.equal(quarantined.event_id, firstEvent.event_id);
      const runs = result[0].results.find((r) => r.partitionKey === "NG-LAGOS");
      assert.equal(runs.duplicate, 1); // the identical replay was recognized, not re-applied
      const metric = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
      assert.equal(metric.json.result.observations[0].value, 42);
      assert.equal(metric.json.coverage, "PARTIAL"); // quarantine is visible as partial coverage
    });

    await t.test("15. recover from a simulated worker crash between commit and ACK", async () => {
      P.emitMetric({ value: 50, metricId: "synthetic.completed_orders", windowStart: "2026-10-02T00:00:00Z", windowEnd: "2026-10-03T00:00:00Z" });
      P.emitMetric({ value: 51, metricId: "synthetic.completed_orders", windowStart: "2026-10-03T00:00:00Z", windowEnd: "2026-10-04T00:00:00Z" });
      const crashing = h.makeEngine({ workerId: "pic-worker-crash", hooks: { afterCommit: async ({ sequence }) => { if (sequence === 2) throw new Error("simulated crash"); } } });
      await assert.rejects(crashing.tick(), /simulated crash/);
      let [cursor] = await q(h, "SELECT last_sequence, acked_sequence, lease_owner FROM hq_integration.hq_product_admin_sync_cursors");
      assert.equal(Number(cursor.last_sequence), 2);
      assert.equal(Number(cursor.acked_sequence), 1);
      assert.equal(cursor.lease_owner, "pic-worker-crash");
      // While the dead worker's lease is live, another worker cannot take over.
      const blocked = await h.makeEngine({ workerId: "pic-worker-b" }).tick();
      assert.equal(blocked[0].results.find((r) => r.partitionKey === "NG-LAGOS").status, "LEASE_LOST");
      // After lease expiry the restarted worker retries the ACK and continues.
      h.clock.offsetMs = 60000;
      await h.makeEngine({ workerId: "pic-worker-b" }).tick();
      h.clock.offsetMs = 0;
      [cursor] = await q(h, "SELECT last_sequence, acked_sequence FROM hq_integration.hq_product_admin_sync_cursors");
      assert.equal(Number(cursor.last_sequence), 3);
      assert.equal(Number(cursor.acked_sequence), 3);
      const counts = await q(h, "SELECT count(*)::int AS n, count(DISTINCT event_id)::int AS d FROM hq_integration.hq_product_admin_event_inbox");
      assert.equal(counts[0].n, 3);
      assert.equal(counts[0].d, 3); // no event was applied twice
      assert.ok(P.state.acks.some((a) => a.sequence === 2 || a.sequence === 3));
    });

    await t.test("16. detect a missing event and preserve partial coverage, then reconcile", async () => {
      P.emitMetric({ value: 60, windowStart: "2026-10-04T00:00:00Z", windowEnd: "2026-10-05T00:00:00Z", skip: true }); // seq 4 never delivered
      P.emitMetric({ value: 61, windowStart: "2026-10-05T00:00:00Z", windowEnd: "2026-10-06T00:00:00Z" }); // seq 5
      await h.engine.tick();
      let [cursor] = await q(h, "SELECT last_sequence, gap_from, gap_to FROM hq_integration.hq_product_admin_sync_cursors");
      assert.equal(Number(cursor.last_sequence), 3); // cursor never crosses a gap
      assert.equal(Number(cursor.gap_from), 4);
      assert.equal(Number(cursor.gap_to), 4);
      const status = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/events/status");
      assert.equal(status.json.result.subscriptions[0].coverage, "PARTIAL");
      assert.equal(status.json.result.subscriptions[0].gap_status, "GAP_DETECTED");
      assert.deepEqual(status.json.result.cursors[0].gap, { from: 4, to: 4 });
      // Next tick backfills from the authoritative snapshot.
      await h.engine.tick();
      [cursor] = await q(h, "SELECT last_sequence, gap_from FROM hq_integration.hq_product_admin_sync_cursors");
      assert.equal(cursor.gap_from, null);
      assert.ok(Number(cursor.last_sequence) >= 5);
      const reconciled = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a&window_start=2026-10-04T00:00:00Z&window_end=2026-10-05T00:00:00Z");
      assert.equal(reconciled.json.result.observations[0].value, 60);
      const [lineage] = await q(h, "SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_lineage WHERE operation = 'RECONCILE_SNAPSHOT'");
      assert.ok(lineage.n >= 1);
    });

    await t.test("17. deny cross-tenant access (API and ingestion)", async () => {
      const r = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-b");
      assert.equal(r.status, 403);
      assert.equal(r.json.error.reason, "SCOPE_DENIED");
      const gh = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=GH");
      assert.equal(gh.status, 403);
      P.emitMetric({ value: 7, scope: { market: "NG", organization: "cosmicforge", tenant: "tenant-b" }, windowStart: "2026-10-06T00:00:00Z", windowEnd: "2026-10-07T00:00:00Z" });
      await h.engine.tick();
      const rows = await q(h, "SELECT reason_code FROM hq_integration.hq_product_admin_quarantine WHERE reason_code = 'SCOPE_DENIED'");
      assert.equal(rows.length, 1);
      const stored = await q(h, "SELECT count(*)::int AS n FROM hq_integration.hq_product_admin_metrics WHERE scope->>'tenant' = 'tenant-b'");
      assert.equal(stored[0].n, 0);
    });

    await t.test("18. reject a breaking schema revision", async () => {
      const ds = require("../../../packages/admin-contracts/src/testing").sampleDataset({ version: "1.1.0", semantic_grain: "HOUR" });
      P.republishManifest({ revision: 2, datasets: [ds], eventFamilies: [require("../../../packages/admin-contracts").standardMetricObservationFamily({ family: "synthetic.metric_observation", datasetId: ds.dataset_id })] });
      const health = await h.call("staff-requester", "POST", admin(id, "/health-check"), {});
      assert.equal(health.json.data.drift_status, "BREAKING_DETECTED");
      const propose = await h.call("staff-requester", "POST", admin(id, "/contracts/propose"), {});
      assert.equal(propose.status, 409);
      const active = await q(h, "SELECT revision, status FROM hq_integration.hq_product_admin_contracts WHERE product_admin_id = $1 ORDER BY revision", [id]);
      assert.equal(active.find((c) => c.status === "ACTIVE").revision, 1); // the pinned contract stays active
      assert.ok(active.some((c) => c.status === "REJECTED"));
      const products = await h.call("staff-viewer", "GET", "/products");
      assert.equal(products.json.data.products[0].reason, "CONTRACT_DRIFT");
    });

    await t.test("19. suspend and then permanently revoke the integration", async () => {
      const suspended = await step("staff-approver", "/suspend", { reason_code: "CONFORMANCE_SUSPEND" });
      assert.equal(suspended.json.data.lifecycle_status, "SUSPENDED");
      const before = P.state.requests;
      assert.deepEqual(await h.engine.tick(), []);
      assert.equal(P.state.requests, before);
      const invisible = await h.call("staff-viewer", "GET", "/products");
      assert.equal(invisible.json.data.products[0].available, false);
      const revoked = await step("staff-approver", "/revoke", { reason_code: "CONFORMANCE_REVOKE" });
      assert.equal(revoked.json.data.lifecycle_status, "REVOKED");
    });

    await t.test("20. future synchronization is denied after revocation", async () => {
      const before = P.state.requests;
      P.emitMetric({ value: 1000, windowStart: "2026-10-08T00:00:00Z", windowEnd: "2026-10-09T00:00:00Z" });
      assert.deepEqual(await h.engine.tick(), []);
      const manual = await h.call("staff-approver", "POST", admin(id, "/sync"), {});
      assert.deepEqual(manual.json.data, []);
      assert.equal(P.state.requests, before); // HQ never contacted the revoked product again
      const reactivate = await h.call("staff-requester", "POST", admin(id, "/verify-identity"), { expected_revision: rev });
      assert.equal(reactivate.status, 409);
      const resume = await h.call("staff-approver", "POST", admin(id, "/resume-review"), { expected_revision: rev, reason_code: "TRY_AGAIN" });
      assert.equal(resume.status, 409);
      assert.equal(resume.json.error.reason, "TERMINAL_STATE");
      const metric = await h.call("staff-viewer", "GET", "/products/" + P.PRODUCT_ID + "/metrics/synthetic.completed_orders?market=NG&tenant=tenant-a");
      assert.equal(metric.status, 404); // no live registration remains
    });
  } finally {
    await h.close();
  }
});
