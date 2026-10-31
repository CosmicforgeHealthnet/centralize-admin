"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const F = require("./helpers/fixtures");
const { memoryAudit } = require("../src/audit");
const { memoryOperations } = require("../src/db/operations");

const { contracts } = F;
const BASE = contracts.BASE_PATH;

async function enabled(t, envOverrides = {}, deps = {}) {
  const m = F.material();
  const config = F.loadConfig(F.enabledEnv(m, envOverrides));
  const app = await F.startApp(config, deps);
  t.after(async () => { await app.close(); m.cleanup(); });
  return { m, config, app, client: F.hqClient(app.target, m.hqKey) };
}

function command(overrides = {}) {
  return {
    command_id: randomUUID(),
    idempotency_key: "idem-" + randomUUID(),
    capability_id: "karryam.wallet.refund",
    target: { type: "karryam.wallet_transaction", id: "txn-1", expected_version: 3 },
    params: {},
    reason_code: "CUSTOMER_REQUEST",
    case_reference: "case-9",
    scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"] },
    ...overrides,
  };
}

test("disabled service: health only, every protocol endpoint is honestly unavailable", async (t) => {
  const app = await F.startApp(F.loadConfig({}));
  t.after(app.close);
  assert.equal((await F.rawRequest(app.port, { path: "/health/live" })).status, 200);
  const ready = await F.rawRequest(app.port, { path: "/health/ready" });
  assert.equal(ready.status, 503);
  assert.equal(ready.json.status, "DISABLED");
  for (const p of ["/manifest", "/capabilities", "/events?dataset_id=x", "/operations/abc"]) {
    const res = await F.rawRequest(app.port, { path: BASE + p });
    assert.equal(res.status, 503, p);
    assert.equal(res.json.error.reason, "INTEGRATION_DISABLED");
    assert.equal(res.json.product_id, "karryam");
    assert.equal(res.json.result, null);
  }
  assert.equal((await F.rawRequest(app.port, { path: "/internal/karryam-admin/v1/capabilities" })).status, 404);
});

test("unauthenticated and wrong-service requests are rejected on every sensitive endpoint", async (t) => {
  const { app, m } = await enabled(t);
  for (const p of ["/manifest", "/capabilities", "/datasets", "/datasets/karryam.operations_daily/snapshots", "/events?dataset_id=karryam.operations_daily&partition_key=p&after_sequence=0", "/sync/status", "/operations/" + randomUUID(), "/audit/" + randomUUID()]) {
    const res = await F.rawRequest(app.port, { path: BASE + p });
    assert.equal(res.status, 401, p);
    assert.equal(res.json.error.code, "UNAUTHENTICATED");
  }
  const post = await F.rawRequest(app.port, { method: "POST", path: BASE + "/operations", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(post.status, 401);
  const wrongKey = F.hqClient(app.target, Buffer.alloc(32, 1));
  assert.equal((await wrongKey.getManifest()).status, 401);
  const wrongService = F.clients.createServiceClient({ target: app.target, auth: { serviceId: "karryam-admin", keyId: "pic-k1", key: m.hqKey } });
  assert.equal((await wrongService.request({ path: BASE + "/manifest" })).status, 401);
  assert.equal((await F.rawRequest(app.port, { path: "/health/live" })).status, 200);
});

test("manifest is signed, verifies for product 'karryam' and advertises honest states", async (t) => {
  const { client, m } = await enabled(t);
  const res = await client.getManifest();
  assert.equal(res.status, 200);
  const signed = res.json.result;
  const trustStore = { "karryam-test-signer-1": { publicKey: m.signer.publicKey, productId: "karryam", environment: "test", notAfter: Date.now() + 86400000 } };
  const verified = contracts.verifyManifest(signed, { trustStore, expected: { productId: "karryam", serviceInstanceId: F.INSTANCE, environment: "test", workloadIdentity: "cf://test/product-admin/karryam", signerKid: "karryam-test-signer-1" } });
  assert.equal(verified.manifest.product_id, "karryam");
  assert.equal(verified.manifest.display_name, "Karryam");
  const usable = verified.manifest.capabilities.filter((c) => contracts.USABLE_CAPABILITY_STATES.includes(c.state));
  assert.deepEqual(usable, [], "nothing is usable without bridge enrollment");
  assert.ok(verified.manifest.capabilities.filter((c) => c.kind === "COMMAND").every((c) => c.state === "DISABLED" && c.blockers.length >= 2));
  assert.ok(verified.manifest.datasets.every((d) => d.readiness === "NOT_CERTIFIED" && d.privacy_class !== "RESTRICTED_PII"));
  assert.equal(JSON.stringify(signed).includes("http"), false, "manifest carries no endpoint URLs");
  const wrongTrust = { "karryam-test-signer-1": { ...trustStore["karryam-test-signer-1"], productId: "healthnet" } };
  assert.throws(() => contracts.verifyManifest(signed, { trustStore: wrongTrust, expected: { productId: "karryam", environment: "test", signerKid: "karryam-test-signer-1" } }));
});

test("manifest without a provisioned signer is unavailable, never invented", async (t) => {
  const { client } = await enabled(t, { KARRYAM_ADMIN_MANIFEST_SIGNING_KEY_FILE: "", KARRYAM_ADMIN_MANIFEST_SIGNING_KID: "" });
  const res = await client.getManifest();
  assert.equal(res.status, 503);
  assert.equal(res.json.error.reason, "MANIFEST_SIGNER_NOT_PROVISIONED");
  assert.equal(res.json.result, null);
});

test("capabilities include the pinned bridge contract; bridge is a blocked dependency until enrolled", async (t) => {
  const { client } = await enabled(t);
  const res = await client.getCapabilities();
  assert.equal(res.status, 200);
  const r = res.json.result;
  assert.equal(r.bridge_contract.capability_matrix.total, 435);
  assert.deepEqual(r.bridge_contract.capability_matrix.by_state, { READ_ONLY: 370, AVAILABLE: 52, BLOCKED_DEPENDENCY: 7, DISABLED: 6 });
  assert.match(r.bridge_contract.authorization_rule, /never runtime authorization/);
  assert.deepEqual(r.bridge_live, { state: "BLOCKED_DEPENDENCY", reason: "BRIDGE_TRUST_NOT_ENROLLED" });
  assert.equal(r.capabilities.find((c) => c.id === "karryam.bridge.capabilities.read").state, "BLOCKED_DEPENDENCY");
  assert.equal(res.json.freshness, "UNKNOWN");
});

test("datasets are cataloged; snapshots and events never return a fabricated empty success", async (t) => {
  const { client } = await enabled(t);
  const ds = await client.getDatasets();
  assert.deepEqual(ds.json.result.datasets.map((d) => d.dataset_id), ["karryam.operations_daily", "karryam.finance_daily"]);
  assert.equal((await client.getDatasetSnapshot("karryam.unknown")).json.error.reason, "UNKNOWN_DATASET");
  const snap = await client.getDatasetSnapshot("karryam.operations_daily");
  assert.equal(snap.status, 503);
  assert.equal(snap.json.error.reason, "SOURCE_NOT_CERTIFIED");
  assert.equal(snap.json.result, null);
  assert.equal(snap.json.as_of, null);
  assert.equal((await client.getEvents({ dataset_id: "karryam.operations_daily" })).json.error.reason, "MISSING_PARAMETER");
  assert.equal((await client.getEvents({ dataset_id: "karryam.operations_daily", partition_key: "NG", after_sequence: 0, extra: 1 })).json.error.reason, "UNKNOWN_PARAMETER");
  assert.equal((await client.getEvents({ dataset_id: "karryam.nope", partition_key: "NG", after_sequence: 0 })).status, 404);
  const events = await client.getEvents({ dataset_id: "karryam.operations_daily", partition_key: "NG-LAGOS", after_sequence: 0, limit: 10 });
  assert.equal(events.status, 503);
  assert.equal(events.json.error.reason, "EVENT_SOURCE_NOT_CERTIFIED");
  assert.equal(events.json.result, null);
  assert.equal((await client.ackEvents({ dataset_id: "karryam.operations_daily" })).json.error.reason, "ACK_INVALID");
  const ack = await client.ackEvents({ dataset_id: "karryam.operations_daily", partition_key: "NG-LAGOS", sequence: 1 });
  assert.equal(ack.status, 503);
  assert.equal(ack.json.error.reason, "EVENT_SOURCE_NOT_CERTIFIED");
});

test("sync status is honest and matches the sync-status.v1 schema", async (t) => {
  const { client } = await enabled(t);
  const res = await client.getSyncStatus();
  assert.equal(res.status, 200);
  assert.equal(res.json.freshness, "UNKNOWN");
  assert.equal(res.json.coverage, "NONE");
  assert.equal(res.json.as_of, null);
  assert.equal(res.json.result.event_source, "NOT_CERTIFIED");
  assert.equal(res.json.result.last_source_observation, null);
  const check = contracts.compile(contracts.schemas.SCHEMAS["sync-status.v1"])(res.json.result);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
});

test("operations are durably rejected, idempotent, auditable and never executed", async (t) => {
  const { client, m, app } = await enabled(t);
  const uri = BASE + "/operations";
  const cmd = command();
  const missing = await client.submitOperation(cmd);
  assert.equal(missing.status, 403);
  assert.equal(missing.json.error.reason, "DELEGATION_REQUIRED");
  const wrongAction = await client.submitOperation(cmd, { delegation: F.delegation(m, { method: "POST", uri, body: cmd, action: "product.view" }) });
  assert.equal(wrongAction.json.error.reason, "DELEGATION_ACTION_MISMATCH");
  const crossProduct = await client.submitOperation(cmd, { delegation: F.delegation(m, { method: "POST", uri, body: cmd, action: "operation.submit", product_id: "healthnet" }) });
  assert.equal(crossProduct.json.error.reason, "DELEGATION_INVALID");
  const otherInstance = await client.submitOperation(cmd, { delegation: F.delegation(m, { method: "POST", uri, body: cmd, action: "operation.submit", aud: "karryam:karryam-admin-other" }) });
  assert.equal(otherInstance.json.error.reason, "DELEGATION_INVALID");

  const first = await client.submitOperation(cmd, { delegation: F.delegation(m, { method: "POST", uri, body: cmd, action: "operation.submit" }) });
  assert.equal(first.status, 403);
  assert.equal(first.json.error.code, "DISABLED");
  assert.equal(first.json.error.reason, "CAPABILITY_DISABLED");
  assert.equal(first.json.error.operation_id, cmd.command_id);
  assert.equal(first.json.error.retryable, false);
  assert.equal(first.json.result, null);

  // Reads need an operation.read delegation and only show the requester's own operations.
  const opUri = BASE + "/operations/" + cmd.command_id;
  const auditUri = BASE + "/audit/" + cmd.command_id;
  const readAs = (u, claims = {}) => ({ delegation: F.delegation(m, { uri: u, action: "operation.read", ...claims }) });
  assert.equal((await client.getOperation(cmd.command_id)).json.error.reason, "DELEGATION_REQUIRED");
  assert.equal((await client.getAudit(cmd.command_id)).json.error.reason, "DELEGATION_REQUIRED");
  assert.equal((await client.getOperation(cmd.command_id, readAs(opUri, { action: "product.view" }))).json.error.reason, "DELEGATION_ACTION_MISMATCH");
  const otherStaff = await client.getOperation(cmd.command_id, readAs(opUri, { sub: "staff-99" }));
  assert.equal(otherStaff.status, 404);
  assert.equal(otherStaff.json.error.reason, "OPERATION_NOT_FOUND");
  assert.equal((await client.getAudit(cmd.command_id, readAs(auditUri, { sub: "staff-99" }))).status, 404);
  assert.equal((await client.getOperation(cmd.command_id, readAs(auditUri))).json.error.reason, "DELEGATION_INVALID", "delegation is bound to one request");

  const status = await client.getOperation(cmd.command_id, readAs(opUri));
  assert.equal(status.status, 200);
  assert.equal(status.json.result.status, "REJECTED");
  assert.equal(status.json.result.executed, false);
  const audit = await client.getAudit(cmd.command_id, readAs(auditUri));
  assert.equal(audit.status, 200);
  assert.ok(audit.json.result.records.some((r) => r.outcome === "OPERATION_REJECTED" && r.reason_code === "CAPABILITY_DISABLED" && r.staff_ref === "staff-17"));
  assert.ok(!JSON.stringify(audit.json).includes("CUSTOMER_REQUEST"), "audit does not echo request bodies");

  const replay = await client.submitOperation(cmd, { delegation: F.delegation(m, { method: "POST", uri, body: cmd, action: "operation.submit" }) });
  assert.equal(replay.json.error.operation_id, cmd.command_id);
  assert.equal(app.deps.operations.byId.size, 1);
  // REGRESSION: another staff member resending the same command is not a
  // replay of someone else's operation.
  const foreign = await client.submitOperation(cmd, { delegation: F.delegation(m, { method: "POST", uri, body: cmd, action: "operation.submit", sub: "staff-99" }) });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.json.error.reason, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(foreign.json.error.operation_id, undefined, "nothing about the other operation is disclosed");
  const changed = { ...cmd, reason_code: "OTHER_REASON" };
  const conflict = await client.submitOperation(changed, { delegation: F.delegation(m, { method: "POST", uri, body: changed, action: "operation.submit" }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.reason, "IDEMPOTENCY_KEY_REUSED");
  const reusedId = { ...cmd, idempotency_key: "idem-" + randomUUID() };
  const idConflict = await client.submitOperation(reusedId, { delegation: F.delegation(m, { method: "POST", uri, body: reusedId, action: "operation.submit" }) });
  assert.equal(idConflict.json.error.reason, "COMMAND_ID_REUSED");

  const unknown = command({ capability_id: "karryam.wallet.drain" });
  assert.equal((await client.submitOperation(unknown, { delegation: F.delegation(m, { method: "POST", uri, body: unknown, action: "operation.submit" }) })).json.error.reason, "UNKNOWN_CAPABILITY");
  const read = command({ capability_id: "karryam.finance.read" });
  assert.equal((await client.submitOperation(read, { delegation: F.delegation(m, { method: "POST", uri, body: read, action: "operation.submit" }) })).json.error.reason, "CAPABILITY_NOT_COMMAND");
  const malformed = { ...command(), performed_by: "staff-99" };
  assert.equal((await client.submitOperation(malformed, { delegation: F.delegation(m, { method: "POST", uri, body: malformed, action: "operation.submit" }) })).json.error.reason, "COMMAND_INVALID");
  const outside = command({ scope: { market: ["NG-ABUJA"], organization: ["karryam-ng"] } });
  assert.equal((await client.submitOperation(outside, { delegation: F.delegation(m, { method: "POST", uri, body: outside, action: "operation.submit" }) })).json.error.reason, "SCOPE_DENIED");
  // REGRESSION: an omitted or empty dimension means "everywhere" and must not
  // pass as inside the delegation.
  for (const scope of [{}, { market: ["NG-LAGOS"] }, { organization: ["karryam-ng"] }, { market: [], organization: ["karryam-ng"] }]) {
    const unscoped = command({ scope });
    const res = await client.submitOperation(unscoped, { delegation: F.delegation(m, { method: "POST", uri, body: unscoped, action: "operation.submit" }) });
    assert.equal(res.json.error.reason, res.status === 400 ? "COMMAND_INVALID" : "SCOPE_DENIED", JSON.stringify(scope));
    assert.notEqual(res.status, 200);
  }
  const unknownId = randomUUID();
  assert.equal((await client.getOperation(unknownId, readAs(BASE + "/operations/" + unknownId))).status, 404);
  assert.equal((await client.getAudit(unknownId, readAs(BASE + "/audit/" + unknownId))).status, 404);
  assert.ok([...app.deps.operations.byId.values()].every((op) => op.status === "REJECTED"));
});

test("audit unavailability fails closed before any handler runs", async (t) => {
  const audit = memoryAudit({ fail: true });
  const { client } = await enabled(t, {}, { audit, operations: memoryOperations(audit) });
  const res = await client.getDatasets();
  assert.equal(res.status, 503);
  assert.equal(res.json.error.reason, "AUDIT_UNAVAILABLE");
  assert.equal(res.json.result, null);
});

test("readiness reports the database honestly and never claims upstream certification", async (t) => {
  const { app } = await enabled(t, {}, { dbReady: async () => false });
  const res = await F.rawRequest(app.port, { path: "/health/ready" });
  assert.equal(res.status, 503);
  assert.equal(res.json.database, "UNAVAILABLE");
  assert.equal(res.json.upstream_certified, false);
  const live = await F.rawRequest(app.port, { path: BASE + "/health/live" });
  assert.equal(live.status, 200);
});

test("command scope containment: every delegated dimension is required, non-empty and contained", () => {
  const { withinScope } = require("../src/protocol/handlers");
  const delegated = { market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: ["z1"] };
  assert.equal(withinScope({ market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: ["z1"] }, delegated), true);
  assert.equal(withinScope({}, delegated), false);
  assert.equal(withinScope({ market: ["NG-LAGOS"], organization: ["karryam-ng"] }, delegated), false, "zone omitted");
  assert.equal(withinScope({ market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: [] }, delegated), false, "zone empty");
  assert.equal(withinScope({ market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: ["z1"], tenant: ["t1"] }, delegated), false, "undelegated dimension");
  assert.equal(withinScope({ market: ["NG-ABUJA"], organization: ["karryam-ng"], zone: ["z1"] }, delegated), false);
  assert.equal(withinScope({ market: ["NG-LAGOS"] }, { market: ["NG-LAGOS"] }), false, "organization is always required");
  assert.equal(withinScope([], delegated), false);
});
