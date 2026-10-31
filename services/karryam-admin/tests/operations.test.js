"use strict";

// Governed action pipeline (spec 4.3-4.5) against the disposable secure
// Bridge. Uses the only kind of command this delivery allows an operator to
// enable (R1/R2) and proves: intent + audit before dispatch, exact
// server-bound fields, one dispatch only, UNKNOWN_OUTCOME on uncertain
// results, settlement only by authoritative readback, two-person approvals.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { startBridgeHarness, opensslAvailable, SCOPE } = require("./helpers/bridge-harness");
const { memoryApprovals } = require("../src/db/approvals");
const F = require("./helpers/fixtures");

const skip = !opensslAvailable() && "openssl unavailable";
const CAP = "karryam.customer.review.submit";
const scopeArrays = { market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] };

function reviewCommand(over = {}, bodyOver = {}) {
  const id = randomUUID();
  const idem = "idem-" + randomUUID();
  const cmd = {
    command_id: id, idempotency_key: idem, capability_id: CAP, target: { type: "customer", id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_version: 1 },
    params: { body: { contract_version: "customer.admin-review-request.v1", request_id: id, customer_id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_review_revision: 1, idempotency_key: idem, reason_code: "CUSTOMER_REQUEST", requested_at: new Date().toISOString(), ...bodyOver } },
    reason_code: "CUSTOMER_REQUEST", case_reference: "case-9", scope: scopeArrays, ...over,
  };
  return cmd;
}

function reviewOperation(cmd, status) {
  const scope = { product: "karryam", ...SCOPE };
  const out = { operation_id: cmd.command_id, customer_id: cmd.params.body.customer_id, scope, status, created_at: new Date().toISOString(), as_of: new Date().toISOString() };
  if (status === "CONFIRMED") out.receipt = { contract_version: "customer.admin-review-request.v1", status: "REVIEW_REQUEST_RECORDED", review_request_id: randomUUID(), request_id: cmd.command_id, customer_id: out.customer_id, idempotency_key: cmd.idempotency_key, intent_digest: "c".repeat(64), recorded_review_revision: 2, scope, recorded_at: new Date().toISOString() };
  return out;
}

async function harness(t) {
  return startBridgeHarness(t, { configOverrides: { enabledCommands: Object.freeze([CAP]) } });
}

const submit = (h, cmd, claims = {}) => h.client.submitOperation(cmd, { delegation: h.delegate(F.contracts.BASE_PATH + "/operations", { method: "POST", body: cmd, action: "operation.submit", scope: scopeArrays, ...claims }) });
const read = (h, id, claims = {}) => h.client.getOperation(id, { delegation: h.delegate(F.contracts.BASE_PATH + "/operations/" + id, { action: "operation.read", ...claims }) });

test("an operator-enabled R2 command executes once, confirmed by the owner, with intent and audit recorded first", { skip }, async (t) => {
  const h = await harness(t);
  const caps = (await h.client.getCapabilities()).json.result.capabilities;
  const cap = caps.find((c) => c.id === CAP);
  assert.equal(cap.state, "AVAILABLE");
  assert.equal(cap.request_schema.additionalProperties, false);
  assert.equal(caps.find((c) => c.id === "karryam.wallet.command.submit").state, "DISABLED", "R3 stays disabled");

  h.fake.state.handlers["customer.review.submit"] = ({ body }) => ({ result: reviewOperation({ command_id: body.request_id, idempotency_key: body.idempotency_key, params: { body } }, "CONFIRMED") });
  const cmd = reviewCommand();
  const res = await submit(h, cmd);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.result.status, "SUCCEEDED");
  assert.equal(res.json.result.executed, true);
  assert.equal(res.json.result.source_status, "CONFIRMED");
  assert.equal(h.fake.state.requests.filter((r) => r.capability === "customer.review.submit").length, 1);
  const sent = h.fake.state.requests.at(-1);
  assert.deepEqual(sent.body, cmd.params.body, "exact body bytes as validated");
  const outcomes = h.audit.rows.filter((r) => r.operation_id === cmd.command_id).map((r) => r.outcome);
  assert.deepEqual(outcomes, ["OPERATION_RECORDED", "OPERATION_DISPATCHED", "OPERATION_SUCCEEDED"]);

  // A retried submission reports the original and never dispatches again.
  const again = await submit(h, cmd);
  assert.equal(again.json.result.replay, true);
  assert.equal(h.fake.state.requests.filter((r) => r.capability === "customer.review.submit").length, 1);
});

test("arbitrary or unbound fields, missing MFA and ambiguous scope are refused before anything is recorded", { skip }, async (t) => {
  const h = await harness(t);
  const cases = [
    [reviewCommand({}, { request_id: randomUUID() }), "BODY_FIELD_NOT_BOUND"],
    [reviewCommand({}, { idempotency_key: "idem-someone-else" }), "BODY_FIELD_NOT_BOUND"],
    [reviewCommand({}, { reason_code: "OTHER" }), "BODY_FIELD_NOT_BOUND"],
    [reviewCommand({}, { requested_at: "2020-01-01T00:00:00Z" }), "BODY_FIELD_NOT_BOUND"],
    [reviewCommand({}, { performed_by: "staff-99" }), "BODY_DOES_NOT_MATCH_SOURCE_CONTRACT"],
  ];
  for (const [cmd, reason] of cases) assert.equal((await submit(h, cmd)).json.error.reason, reason);
  const extraParam = reviewCommand();
  extraParam.params.execute_now = true;
  assert.equal((await submit(h, extraParam)).json.error.reason, "PARAMS_INVALID");
  assert.equal((await submit(h, reviewCommand(), { mfa_at: null })).json.error.reason, "RECENT_MFA_REQUIRED");
  const wide = reviewCommand({ scope: { ...scopeArrays, zone: [SCOPE.zone, "z2"] } });
  assert.equal((await submit(h, wide, { scope: { ...scopeArrays, zone: [SCOPE.zone, "z2"] } })).json.error.reason, "SINGLE_EXACT_SCOPE_REQUIRED");
  assert.equal(h.operations.byId.size, 0);
  assert.equal(h.fake.state.requests.length, 0);
});

test("uncertain results become UNKNOWN_OUTCOME, are never resubmitted, and settle only from owner readback", { skip }, async (t) => {
  const h = await harness(t);
  h.fake.state.handlers["customer.review.submit"] = () => ({ destroy: true });
  const cmd = reviewCommand();
  const res = await submit(h, cmd);
  assert.equal(res.status, 200);
  assert.equal(res.json.result.status, "UNKNOWN_OUTCOME");
  assert.equal(res.json.result.executed, false);
  assert.equal(res.json.result.outcome_known, false);
  // Retry of the same command: no second submission.
  assert.equal((await submit(h, cmd)).json.result.status, "UNKNOWN_OUTCOME");
  assert.equal(h.fake.state.requests.filter((r) => r.capability === "customer.review.submit").length, 1);

  let readbackStatus = "EXECUTING";
  h.fake.state.handlers["customer.review.readback"] = ({ params }) => ({ result: reviewOperation({ command_id: params.operation_id, idempotency_key: cmd.idempotency_key, params: cmd.params }, readbackStatus) });
  const still = await read(h, cmd.command_id);
  assert.equal(still.json.result.status, "UNKNOWN_OUTCOME");
  assert.equal(still.json.result.readback.state, "STILL_UNKNOWN");
  assert.ok(h.fake.state.requests.at(-1).url.includes("/customer/review-requests/" + cmd.command_id + "?"), "readback of the ORIGINAL operation");
  readbackStatus = "CONFIRMED";
  const settled = await read(h, cmd.command_id);
  assert.equal(settled.json.result.status, "SUCCEEDED");
  assert.equal(settled.json.result.readback.state, "SETTLED_BY_READBACK");
  const calls = h.fake.state.requests.length;
  assert.equal((await read(h, cmd.command_id)).json.result.readback, null, "settled operations are not read back again");
  assert.equal(h.fake.state.requests.length, calls);
  assert.equal(h.fake.state.requests.filter((r) => r.capability === "customer.review.submit").length, 1);
  // Readback needs the requester's own fresh staff context.
  const other = reviewCommand();
  h.fake.state.handlers["customer.review.submit"] = () => ({ status: 503, error: "owner_unavailable" });
  assert.equal((await submit(h, other)).json.result.status, "UNKNOWN_OUTCOME", "a 503 after submission is not success");
  assert.equal((await read(h, other.command_id, { mfa_at: null })).json.result.readback.state, "READBACK_REQUIRES_STAFF_CONTEXT");
  assert.equal((await read(h, other.command_id, { sub: "staff-99" })).status, 404, "only the requester can read it");
});

test("definite refusals are FAILED; disabled and high-risk commands are durably REJECTED", { skip }, async (t) => {
  const h = await harness(t);
  h.fake.state.handlers["customer.review.submit"] = () => ({ status: 503, error: "capability_blocked" });
  const cmd = reviewCommand();
  const res = await submit(h, cmd);
  assert.equal(res.json.result.status, "FAILED");
  assert.equal(res.json.result.reason_code, "SOURCE_CAPABILITY_DISABLED");
  h.fake.state.handlers["customer.review.submit"] = () => ({ status: 403, error: "forbidden" });
  assert.equal((await submit(h, reviewCommand())).json.result.status, "FAILED");
  const r3 = reviewCommand({ capability_id: "karryam.wallet.command.submit" });
  const rejected = await submit(h, r3);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.json.error.code, "DISABLED");
  assert.equal(h.operations.byId.get(r3.command_id).status, "REJECTED");
  assert.equal(h.fake.state.requests.filter((r) => r.capability === "wallet.command.submit").length, 0);
});

test("two-person approval foundation: independent, MFA-fresh, digest/scope bound, expiring, single use", { skip }, async (t) => {
  const h = await harness(t);
  const local = (capability_id, params, claims = {}) => {
    const cmd = { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id, target: { type: "approval", id: "approval", expected_version: null }, params, reason_code: "HIGH_RISK_CHANGE", case_reference: null, scope: scopeArrays };
    return submit(h, cmd, claims).then((res) => ({ res, cmd }));
  };
  const digest = "sha256:" + "d".repeat(64);
  const { res: proposed, cmd: proposal } = await local("karryam.governance.approval.propose", { capability_id: "karryam.wallet.command.submit", intent_digest: digest, ttl_seconds: 600 });
  assert.equal(proposed.json.result.status, "SUCCEEDED", JSON.stringify(proposed.json));
  assert.equal(proposed.json.result.approval.status, "PROPOSED");
  const self = await local("karryam.governance.approval.decide", { approval_id: proposal.command_id, decision: "APPROVE" });
  assert.equal(self.res.json.error.reason, "APPROVER_MUST_BE_INDEPENDENT");
  const stale = await local("karryam.governance.approval.decide", { approval_id: proposal.command_id, decision: "APPROVE" }, { sub: "staff-99", mfa_at: Math.floor(Date.now() / 1000) - 900 });
  assert.equal(stale.res.json.error.reason, "RECENT_MFA_REQUIRED");
  const approved = await local("karryam.governance.approval.decide", { approval_id: proposal.command_id, decision: "APPROVE" }, { sub: "staff-99" });
  assert.equal(approved.res.json.result.approval.status, "APPROVED");
  const unknownTarget = await local("karryam.governance.approval.propose", { capability_id: "karryam.taxi.read", intent_digest: digest, ttl_seconds: 600 });
  assert.equal(unknownTarget.res.json.error.reason, "APPROVAL_TARGET_INVALID");

  // Consumption: binding, requester, single use.
  const a = h.approvals;
  const base = { id: proposal.command_id, operationId: randomUUID(), capabilityId: "karryam.wallet.command.submit", intentDigest: digest, scope: scopeArrays, requestedBy: "staff-17" };
  await assert.rejects(a.consume({ ...base, intentDigest: "sha256:" + "e".repeat(64) }), (e) => e.reason === "APPROVAL_BINDING_MISMATCH");
  await assert.rejects(a.consume({ ...base, scope: { ...scopeArrays, zone: ["z2"] } }), (e) => e.reason === "APPROVAL_BINDING_MISMATCH");
  await assert.rejects(a.consume({ ...base, requestedBy: "staff-55" }), (e) => e.reason === "APPROVAL_REQUESTER_MISMATCH");
  assert.equal(await a.consume(base), true);
  await assert.rejects(a.consume({ ...base, operationId: randomUUID() }), (e) => e.reason === "APPROVAL_ALREADY_CONSUMED");
  // Expiry.
  let clock = Date.now();
  const timed = memoryApprovals({ now: () => clock });
  await timed.propose({ id: randomUUID(), capabilityId: "c", intentDigest: digest, scope: {}, requestedBy: "a", ttlSeconds: 60 }).then(async (p) => {
    clock += 120000;
    await assert.rejects(timed.decide({ id: p.approval_id, decidedBy: "b", approve: true }), (e) => e.reason === "APPROVAL_EXPIRED");
  });
});
