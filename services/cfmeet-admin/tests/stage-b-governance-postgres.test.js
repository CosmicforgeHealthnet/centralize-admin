"use strict";

// Functional suite: runs against HQ's interface-v1 target registry (see helpers/target-contract.js).
require("./helpers/target-contract");

// Protocol endpoints over the real PostgreSQL stores (what HQ's PIC drives in
// production): Stage B snapshots, events, acknowledgements and sync status
// from Bridge-pulled datasets; governed operations, approvals and readback
// on pgOperations/pgApprovals; capability discovery recorded in the
// governance store; manifest signing cache. Runs only with
// CFMEET_ADMIN_TEST_DATABASE_URL (disposable server).

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { ADMIN_URL, createDisposable } = require("./helpers/pgdb");
const { migrate } = require("../scripts/migrate");
const { createPipelineStore, partitionKeyFor } = require("../src/sync/store");
const D = require("../src/sync/datasets");
const { pgAudit } = require("../src/audit");
const { pgOperations } = require("../src/db/operations");
const { pgApprovals } = require("../src/db/approvals");
const { createGovernanceStore } = require("../src/db/governance");
const { startBridgeHarness, opensslAvailable, SCOPE } = require("./helpers/bridge-harness");
const X = require("./helpers/bridge-fixtures");
const F = require("./helpers/fixtures");

const skip = (!ADMIN_URL && "CFMEET_ADMIN_TEST_DATABASE_URL not set") || (!opensslAvailable() && "openssl unavailable");
const KEY = partitionKeyFor(SCOPE);
const CAP = "cfmeet.accounts.review-requests.submit";
const scopeArrays = { market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] };
const single = { market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant };
const feed = { enabled: true, scopes: [SCOPE], consumer: "cfmeet-admin-test", subject: "svc-cfmeet-admin", role: "hq.cfmeet.read", acr: "workload", purpose: "event-sync", pageSize: 50, pollSeconds: 5, rewindEvents: 20, reconcileSeconds: 300, retentionDays: 7, leaseSeconds: 30, datasetPullSeconds: 900, datasetDays: 3 };

function reviewCommand({ approvalRef } = {}) {
  const id = randomUUID();
  const idem = "idem-" + randomUUID();
  return {
    command_id: id, idempotency_key: idem, capability_id: CAP, target: { type: "user", id: "user-1", expected_version: 1 },
    params: { body: { operation_id: id, idempotency_key: idem, reason_code: "CUSTOMER_REQUEST", case_ref: "case-9", expected_version: 1, requested_at: new Date().toISOString(), params: { user_ref: "user-1", change: "EMAIL" } }, ...(approvalRef ? { approval_ref: approvalRef } : {}) },
    reason_code: "CUSTOMER_REQUEST", case_reference: "case-9", scope: scopeArrays,
  };
}

test("Stage B, governed operations and discovery over PostgreSQL stores", { skip, timeout: 240000 }, async (t) => {
  const d = await createDisposable("cfm_sb");
  t.after(() => d.drop());
  await migrate({ connectionString: d.migrationUrl, runtimeRole: d.runtime });
  const pool = d.pool();
  const store = createPipelineStore(pool, { serviceInstanceId: F.INSTANCE });
  await store.ensurePartitions([SCOPE], feed.consumer);
  const certified = ["cfmeet.meetings_daily", "cfmeet.trust_safety_queue", "cfmeet.sync_health"];
  const governance = createGovernanceStore(pool);
  const h = await startBridgeHarness(t, {
    configOverrides: { feed, certifiedDatasets: Object.freeze(certified), enabledCommands: Object.freeze([CAP]) },
    deps: { pipeline: store, audit: pgAudit(pool), operations: pgOperations(pool), approvals: pgApprovals(pool), governance },
  });
  const delegateTo = (uri, action, claims = {}) => h.delegate(uri, { action, scope: scopeArrays, ...claims });

  await t.test("Stage B: snapshots, events, acknowledgements and sync status from pulled datasets", async () => {
    // A Bridge series pulled for one partition becomes HQ observations.
    const at = new Date().toISOString();
    const today = at.slice(0, 10);
    const series = { dataset_id: "cfmeet.trust_safety_queue", coverage: "COMPLETE", window: { start: today + "T00:00:00Z", end: at }, next_cursor: null, series: [{ date: today, metrics: { open_messaging: 4, open_calling: 1, open_communications: 0, open_meetings: 2 } }] };
    const published = await store.publishDatasetSeries(KEY, "cfmeet.trust_safety_queue", D.seriesObservations(D.BY_DATASET.get("cfmeet.trust_safety_queue"), series, { observedAt: at }));
    assert.equal(published.length, 4);
    // Minutes keep their unit end to end.
    const minutes = { dataset_id: "cfmeet.meetings_daily", coverage: "COMPLETE", window: series.window, next_cursor: null, series: [{ date: today, metrics: { meetings: 7, participant_minutes: 420, peak_live_meetings: 3 } }] };
    await store.publishDatasetSeries(KEY, "cfmeet.meetings_daily", D.seriesObservations(D.BY_DATASET.get("cfmeet.meetings_daily"), minutes, { observedAt: at }));

    const snap = await h.client.getDatasetSnapshot("cfmeet.trust_safety_queue", { query: { partition_key: KEY } });
    assert.equal(snap.status, 200, JSON.stringify(snap.json));
    assert.equal(snap.json.result.records.length, 4);
    assert.deepEqual(snap.json.result.records.find((r) => r.payload.metric_id === "cfmeet.trust_safety_queue.open_messaging").payload.value, 4);
    assert.ok(snap.json.result.records.every((r) => r.scope.tenant === SCOPE.tenant && r.payload.value_state === "OBSERVED"));
    const mins = await h.client.getDatasetSnapshot("cfmeet.meetings_daily", { query: { partition_key: KEY } });
    assert.equal(mins.json.result.records.find((r) => r.payload.metric_id === "cfmeet.meetings_daily.participant_minutes").payload.unit, "minute");
    assert.equal((await h.client.getDatasetSnapshot("cfmeet.trust_safety_queue", { query: { partition_key: "NG-LAGOS:none:none:none" } })).json.error.reason, "UNKNOWN_PARTITION");
    assert.equal((await h.client.getDatasetSnapshot("cfmeet.sync_health", { query: { partition_key: KEY } })).json.error.reason, "NO_SOURCE_OBSERVATION", "no observation yet is never an empty success");
    assert.equal((await h.client.getDatasetSnapshot("cfmeet.apps_daily", { query: { partition_key: KEY } })).json.error.reason, "DATASET_NOT_CERTIFIED");

    const page = await h.client.getEvents({ dataset_id: "cfmeet.trust_safety_queue", partition_key: KEY, after_sequence: 0, limit: 10 });
    assert.equal(page.status, 200, JSON.stringify(page.json));
    assert.equal(page.json.result.events.length, 4);
    assert.equal(page.json.result.head_sequence, 4);
    const ack = (sequence, partition = KEY) => h.client.ackEvents({ dataset_id: "cfmeet.trust_safety_queue", partition_key: partition, sequence });
    assert.equal((await ack(2)).json.result.acknowledged_sequence, 2);
    assert.equal((await ack(9)).json.error.reason, "ACK_BEYOND_HEAD");
    assert.equal((await ack(1)).json.error.reason, "ACK_REGRESSION");
    assert.equal((await ack(1, "NG-LAGOS:none:none:none")).json.error.reason, "UNKNOWN_PARTITION");

    await store.publishSyncHealth(KEY);
    const status = await h.client.getSyncStatus();
    assert.equal(status.status, 200, JSON.stringify(status.json));
    assert.equal(status.json.result.event_source, "CERTIFIED");
    assert.ok(status.json.result.partitions.some((p) => p.dataset_id === "cfmeet.trust_safety_queue"));
  });

  await t.test("governed operations on PostgreSQL: executed once with audit, approval references single-use, readback recorded", async () => {
    h.fake.state.handlers["accounts.review-requests.submit"] = ({ body }) => ({ result: X.commandResult(body.operation_id) });
    const submit = (cmd, claims = {}) => h.client.submitOperation(cmd, { delegation: delegateTo(F.contracts.BASE_PATH + "/operations", "operation.submit", { method: "POST", body: cmd, ...claims }) });
    const ok = await submit(reviewCommand());
    assert.equal(ok.json.result.status, "SUCCEEDED", JSON.stringify(ok.json));

    // An approval (local records on PostgreSQL) bound to one exact command.
    const first = reviewCommand();
    const intent = F.contracts.digestOf({ capability: CAP, target: first.target, body: first.params.body, scope: single, staff: "staff-17" });
    const local = (capability_id, params, claims = {}) => submit({ command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id, target: { type: "approval", id: "approval", expected_version: null }, params, reason_code: "HIGH_RISK_CHANGE", case_reference: null, scope: scopeArrays }, claims);
    const proposal = await local("cfmeet.governance.approval.propose", { capability_id: CAP, intent_digest: intent, ttl_seconds: 600 });
    assert.equal(proposal.json.result.approval.status, "PROPOSED", JSON.stringify(proposal.json));
    const approvalId = proposal.json.result.approval.approval_id;
    const decided = await local("cfmeet.governance.approval.decide", { approval_id: approvalId, decision: "APPROVE" }, { sub: "staff-99" });
    assert.equal(decided.json.result.approval.status, "APPROVED", JSON.stringify(decided.json));
    first.params.approval_ref = approvalId;
    assert.equal((await submit(first)).json.result.status, "SUCCEEDED");
    const reuse = reviewCommand({ approvalRef: approvalId });
    const refused = await submit(reuse);
    assert.equal(refused.json.error.reason, "APPROVAL_ALREADY_CONSUMED", JSON.stringify(refused.json));

    // Uncertain outcome, then authoritative readback recorded on PostgreSQL.
    h.fake.state.handlers["accounts.review-requests.submit"] = () => ({ destroy: true });
    const unsure = reviewCommand();
    assert.equal((await submit(unsure)).json.result.status, "UNKNOWN_OUTCOME");
    h.fake.state.handlers["bridge.operations.read"] = ({ params }) => ({ result: X.operationStatus(params.idempotency_key, "accounts.review-requests.submit", { status: "SENT" }) });
    const read = (id) => h.client.getOperation(id, { delegation: delegateTo(F.contracts.BASE_PATH + "/operations/" + id, "operation.read") });
    assert.equal((await read(unsure.command_id)).json.result.readback.state, "STILL_UNKNOWN");
    const [row] = (await pool.query("SELECT readback_count FROM cfmeet_admin.operation_requests WHERE id = $1", [unsure.command_id])).rows;
    assert.ok(Number(row.readback_count) >= 1, "readback recorded");
    h.fake.state.handlers["bridge.operations.read"] = ({ params }) => ({ result: X.operationStatus(params.idempotency_key, "accounts.review-requests.submit", { status: "SUCCEEDED" }) });
    assert.equal((await read(unsure.command_id)).json.result.status, "SUCCEEDED");
    const audit = await h.client.getAudit(unsure.command_id, { delegation: delegateTo(F.contracts.BASE_PATH + "/audit/" + unsure.command_id, "operation.read") });
    assert.equal(audit.status, 200, JSON.stringify(audit.json));
  });

  await t.test("capability discovery is recorded in the governance store; a store failure is reported, never approval", async () => {
    const uri = F.contracts.BASE_PATH + "/capabilities";
    const caps = await h.client.getCapabilities({ delegation: delegateTo(uri, "product.capabilities.read") });
    assert.equal(caps.status, 200, JSON.stringify(caps.json));
    assert.equal(caps.json.result.bridge_live.runtime_snapshot.state, "RECORDED", JSON.stringify(caps.json.result.bridge_live));
    assert.equal(caps.json.result.bridge_live.runtime_snapshot.source_openapi_matches_pin, true);
    const [{ n }] = (await pool.query("SELECT count(*)::int AS n FROM cfmeet_admin.capability_snapshots")).rows;
    assert.ok(n > 0);

    const broken = await startBridgeHarness(t, { deps: { governance: { recordCapabilityDiscovery: async () => { throw Object.assign(new Error("down"), { reason: "SNAPSHOT_STORE_UNAVAILABLE" }); } } } });
    const res = await broken.client.getCapabilities({ delegation: broken.delegate(uri, { action: "product.capabilities.read" }) });
    assert.deepEqual(res.json.result.bridge_live.runtime_snapshot, { state: "NOT_RECORDED", reason: "SNAPSHOT_STORE_UNAVAILABLE" });
  });
});

test("the signed manifest is cached until half its lifetime, then re-signed", async (t) => {
  const m = F.material();
  t.after(m.cleanup);
  let clock = Date.now();
  const config = F.loadConfig(F.enabledEnv(m, { CFMEET_ADMIN_MANIFEST_TTL_SECONDS: "600" }));
  const app = await F.startApp(config, { now: () => clock });
  t.after(app.close);
  const client = F.hqClient(app.target, m.hqKey);
  const a = (await client.getManifest()).json.result;
  const b = (await client.getManifest()).json.result;
  assert.deepEqual(a, b, "within half the TTL the same signed manifest is served");
  clock += 301000;
  const c = (await client.getManifest()).json.result;
  assert.notDeepEqual(c, a, "after half the TTL a fresh manifest is signed");
  void randomBytes;
});
