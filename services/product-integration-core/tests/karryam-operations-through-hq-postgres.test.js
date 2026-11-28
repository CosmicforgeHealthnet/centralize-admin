"use strict";

// Sections 10.1.4, 11.3 and 15 acceptance (simulated/CI, not a live Bridge):
//
//   authenticated HQ staff -> HQ RBAC/MFA/scope (PIC) -> request-bound
//   product delegation -> Karryam Admin (capability, risk, certification,
//   runtime availability, approval) -> pinned Bridge adapter -> disposable
//   secure Bridge (mTLS, HMAC v2, Ed25519) -> owner result -> Karryam Admin
//   durable receipt and readback -> authorized HQ response.
//
// Covers an R2 command and an R3 command with an independent approval, the
// HQ product-level operations switch (independent approver), operation and
// audit reads by the original requester only, and fail-closed refusals.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const C = require("../../../packages/admin-contracts");
const { available } = require("./helpers/harness");
const { startKarryamThroughHq, SCOPE, ALLOWED } = require("./helpers/karryam-e2e");
const { pgOperations } = require("../../karryam-admin/src/db/operations");
const { pgApprovals } = require("../../karryam-admin/src/db/approvals");
const { pgCertifications } = require("../../karryam-admin/src/db/certifications");
const { pgAudit } = require("../../karryam-admin/src/audit");
const { pgNonceStore } = require("../../karryam-admin/src/security/nonce-store");
const { createGovernanceStore } = require("../../karryam-admin/src/db/governance");
const { contractRevision } = require("../../karryam-admin/src/sync/bridge-consumer");
const R = require("../../karryam-admin/src/bridge/contracts/registry");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");

let opensslOk = true;
try { generatePki({ serverName: "probe.internal" }).cleanup(); } catch { opensslOk = false; }
const skip = (!available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)") || (!opensslOk && "openssl unavailable");

const R2 = "karryam.customer.review.submit";
const R3 = "karryam.hq.exports.create";
const single = { market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant };

test("governed commands through HQ: R2 and approved R3, original identity, independent switches, fail closed", { skip, timeout: 240000 }, async (t) => {
  const env = await startKarryamThroughHq(t, {
    configOverrides: { enabledCommands: Object.freeze([R2, R3]), highRiskCertified: Object.freeze([R3]) },
    karryamDeps: (pool) => ({ audit: pgAudit(pool), operations: pgOperations(pool), approvals: pgApprovals(pool), certifications: pgCertifications(pool), governance: createGovernanceStore(pool), nonceStore: pgNonceStore(pool), dbReady: async () => true }),
  });
  const { h, fake, ka, id } = env;
  const hqRows = (sql, params) => h.pool.query(sql, params).then((r) => r.rows);
  const kaRows = (sql, params) => ka.pool.query(sql, params).then((r) => r.rows);

  // Operator certification of the R3 command (migration identity) and the
  // Bridge's runtime observation that it is available for the staff role.
  await ka.owner.query(`INSERT INTO karryam_admin.high_risk_certifications (id, capability_id, risk, contract_revision, source_policy_revision, evidence_ref, certified_by, second_reviewer, valid_from, expires_at)
    VALUES ($1,$2,'R3',$3,'owner-policy-7','cab/2026-11/exports','rev-a','rev-b', now() - interval '1 hour', now() + interval '30 days')`, [randomUUID(), R3, contractRevision()]);
  await createGovernanceStore(ka.pool).recordCapabilityDiscovery({ registry: R, contractRevision: contractRevision(), staff: { sub: "staff-ops", role: "hq.karryam.read", market: SCOPE.market, organization: SCOPE.organization },
    discovery: { contract_version: "1.0", openapi_sha256: R.summary().source_artifacts.openapi_sha256, capabilities: [{ id: "hq.exports.create", state: "AVAILABLE" }, { id: "customer.review.submit", state: "AVAILABLE" }] } });

  // Staff grants: the requester and an independent approver, both in scope.
  await h.bootstrapPlatformGrant("staff-ops-approver", ["integration.read", "integration.approve", "integration.suspend"]);
  for (const staff of ["staff-ops", "staff-ops-2"]) {
    const g = await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: "karryam", staff_id: staff, role: "karryam.ops.viewer", actions: ["product.view", "operation.submit", "operation.read"], scope: ALLOWED });
    assert.equal(g.status, 201, JSON.stringify(g.json));
  }

  const reviewCommand = () => {
    const cid = randomUUID();
    const idem = "idem-" + randomUUID();
    return { command_id: cid, idempotency_key: idem, capability_id: R2, target: { type: "customer", id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_version: 1 },
      params: { body: { contract_version: "customer.admin-review-request.v1", request_id: cid, customer_id: "7a1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", expected_review_revision: 1, idempotency_key: idem, reason_code: "CUSTOMER_REQUEST", requested_at: new Date().toISOString() } },
      reason_code: "CUSTOMER_REQUEST", case_reference: "case-9", scope: ALLOWED };
  };
  fake.state.handlers["customer.review.submit"] = ({ body }) => {
    const scope = { product: "karryam", ...SCOPE };
    return { result: { operation_id: body.request_id, customer_id: body.customer_id, scope, status: "CONFIRMED", created_at: new Date().toISOString(), as_of: new Date().toISOString(),
      receipt: { contract_version: "customer.admin-review-request.v1", status: "REVIEW_REQUEST_RECORDED", review_request_id: randomUUID(), request_id: body.request_id, customer_id: body.customer_id, idempotency_key: body.idempotency_key, intent_digest: "c".repeat(64), recorded_review_revision: 2, scope, recorded_at: new Date().toISOString() } } };
  };
  fake.state.handlers["hq.exports.create"] = () => ({ result: { export_id: randomUUID(), row_count: 12, download_token: "Z".repeat(43), expires_at: new Date(Date.now() + 600000).toISOString(), plaintext_sha256: "d".repeat(64) } });
  const sent = (cap) => fake.state.requests.filter((r) => r.capability === cap);
  const submit = (who, cmd, opts) => h.call(who, "POST", "/products/karryam/operations", cmd, opts);

  await t.test("operations stay off until an independent approver switches them on", async () => {
    const off = await submit("staff-ops", reviewCommand());
    assert.equal(off.status, 403);
    assert.equal(off.json.error.reason, "OPERATIONS_NOT_ENABLED_FOR_PRODUCT");
    assert.equal(sent("customer.review.submit").length, 0);
    assert.equal((await env.step("staff-requester", "/operations/enable", { evidence_ref: "cab:ops-1" })).status, 403, "the registration requester cannot enable operations");
    const byActivator = await env.step("staff-approver", "/operations/enable", { evidence_ref: "cab:ops-1" });
    assert.equal(byActivator.json.error.reason, "INDEPENDENT_APPROVER_REQUIRED");
    assert.equal((await env.step("staff-ops-approver", "/operations/enable", {})).json.error.reason, "EVIDENCE_REQUIRED");
    const on = await env.step("staff-ops-approver", "/operations/enable", { evidence_ref: "cab:ops-1" });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.data.operations_enabled, true);
    const [decision] = await hqRows(`SELECT decision, actor_id, evidence_ref FROM hq_integration.hq_product_admin_onboarding_approvals WHERE product_admin_id = $1 AND decision = 'OPERATIONS_ENABLED'`, [id]);
    assert.deepEqual(decision, { decision: "OPERATIONS_ENABLED", actor_id: "staff-ops-approver", evidence_ref: "cab:ops-1" });
  });

  let r2;
  await t.test("R2 through HQ: executed once by the owner with the original staff identity; receipt, readback and audit for the requester only", async () => {
    r2 = reviewCommand();
    const res = await submit("staff-ops", r2);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.result.status, "SUCCEEDED");
    assert.equal(sent("customer.review.submit").length, 1);
    assert.equal(sent("customer.review.submit")[0].claims.sub, "staff-ops", "HQ staff identity reaches the Bridge assertion");
    const [op] = await kaRows(`SELECT status, staff_ref, dispatch_count, reason_code FROM karryam_admin.operation_requests WHERE id = $1`, [r2.command_id]);
    assert.deepEqual(op, { status: "SUCCEEDED", staff_ref: "staff-ops", dispatch_count: 1, reason_code: "SOURCE_CONFIRMED" });
    const [fwd] = await hqRows(`SELECT outcome, metadata FROM hq_integration.hq_product_admin_security_audit WHERE action = 'operation.submit.forward' ORDER BY id DESC LIMIT 1`);
    assert.equal(fwd.outcome, "RECORDED");
    assert.equal(fwd.metadata.command_digest, C.digestOf(r2));
    // Retrying through HQ replays; never a second dispatch.
    assert.equal((await submit("staff-ops", r2)).json.result.replay, true);
    assert.equal(sent("customer.review.submit").length, 1);
    // Readback and audit: requester yes, anyone else "not found".
    const read = await h.call("staff-ops", "GET", "/products/karryam/operations/" + r2.command_id);
    assert.equal(read.json.result.status, "SUCCEEDED");
    const audit = await h.call("staff-ops", "GET", "/products/karryam/operations/" + r2.command_id + "/audit");
    assert.deepEqual(audit.json.result.records.map((x) => x.outcome), ["OPERATION_RECORDED", "OPERATION_DISPATCHED", "OPERATION_SUCCEEDED"]);
    assert.equal((await h.call("staff-ops-2", "GET", "/products/karryam/operations/" + r2.command_id)).status, 404);
    assert.equal((await h.call("staff-ops-2", "GET", "/products/karryam/operations/" + r2.command_id + "/audit")).status, 404);
  });

  await t.test("R3 through HQ: independent approval bound to the exact intent, then a single execution", async () => {
    const cmd = { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id: R3, target: { type: "export", id: "export-request", expected_version: 3 },
      params: { body: { approval_id: "5f0a1c2e-3d4b-4a5c-8d6e-7f8091a2b3c4", row_limit: 200 } }, reason_code: "REGULATOR_REQUEST", case_reference: "case-77", scope: ALLOWED };
    const intent = C.digestOf({ capability: R3, target: cmd.target, body: cmd.params.body, scope: single, staff: "staff-ops" });
    const local = (who, capability_id, params) => submit(who, { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id, target: { type: "approval", id: "approval", expected_version: null }, params, reason_code: "HIGH_RISK_CHANGE", case_reference: null, scope: ALLOWED });
    // Without approval: refused, nothing sent.
    const bare = await submit("staff-ops", cmd);
    assert.equal(bare.json.error.reason, "INDEPENDENT_APPROVAL_REQUIRED");
    const proposal = await local("staff-ops", "karryam.governance.approval.propose", { capability_id: R3, intent_digest: intent, ttl_seconds: 600, expected_version: 3 });
    assert.equal(proposal.json.result.approval.status, "PROPOSED", JSON.stringify(proposal.json));
    const approvalId = proposal.json.result.approval.approval_id;
    assert.equal((await local("staff-ops", "karryam.governance.approval.decide", { approval_id: approvalId, decision: "APPROVE" })).json.error.reason, "APPROVER_MUST_BE_INDEPENDENT");
    const approved = await local("staff-ops-2", "karryam.governance.approval.decide", { approval_id: approvalId, decision: "APPROVE" });
    assert.equal(approved.json.result.approval.status, "APPROVED", JSON.stringify(approved.json));
    const [stored] = await kaRows(`SELECT status, requested_by, decided_by, source_policy_revision, certification_id IS NOT NULL AS certified FROM karryam_admin.approval_references WHERE id = $1`, [approvalId]);
    assert.deepEqual(stored, { status: "APPROVED", requested_by: "staff-ops", decided_by: "staff-ops-2", source_policy_revision: "owner-policy-7", certified: true });
    cmd.params.approval_ref = approvalId;
    const res = await submit("staff-ops", cmd);
    assert.equal(res.json.result.status, "SUCCEEDED", JSON.stringify(res.json));
    assert.equal(sent("hq.exports.create").length, 1);
    assert.equal(sent("hq.exports.create")[0].claims.sub, "staff-ops");
    assert.equal(JSON.stringify(res.json).includes("Z".repeat(43)), false, "single-use download token never returned through HQ");
    const [consumed] = await kaRows(`SELECT status, consumed_by FROM karryam_admin.approval_references WHERE id = $1`, [approvalId]);
    assert.deepEqual(consumed, { status: "CONSUMED", consumed_by: cmd.command_id });
    // The same approval can never authorize a different command.
    const reuse = { ...cmd, command_id: randomUUID(), idempotency_key: "idem-" + randomUUID() };
    assert.equal((await submit("staff-ops", reuse)).json.error.reason, "APPROVAL_ALREADY_CONSUMED");
    assert.equal(sent("hq.exports.create").length, 1);
  });

  await t.test("fail closed: missing MFA, scope outside the grant, and operations switched off again", async () => {
    assert.equal((await submit("staff-ops", reviewCommand(), { mfa: false })).json.error.reason, "RECENT_MFA_REQUIRED");
    const outside = reviewCommand();
    outside.scope = { ...ALLOWED, tenant: ["tenant-b"] };
    assert.equal((await submit("staff-ops", outside)).json.error.reason, "SCOPE_DENIED");
    assert.equal((await env.step("staff-ops-approver", "/operations/disable", {})).json.error.reason, "REASON_CODE_REQUIRED");
    const off = await env.step("staff-ops-approver", "/operations/disable", { reason_code: "INCIDENT_FREEZE" });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const after = await submit("staff-ops", reviewCommand());
    assert.equal(after.json.error.reason, "OPERATIONS_NOT_ENABLED_FOR_PRODUCT");
    assert.equal(sent("customer.review.submit").length, 1);
    // A direct database switch-on without a reviewed revision is refused.
    await assert.rejects(h.pool.query(`UPDATE hq_integration.hq_product_admins SET operations_enabled = true WHERE id = $1`, [id]), /reviewed revision/);
  });
});
