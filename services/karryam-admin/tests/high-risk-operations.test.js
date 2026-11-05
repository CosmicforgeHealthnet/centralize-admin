"use strict";

// Section 11.3 high-risk (R3) workflow against the disposable secure Bridge
// (real TLS 1.3 mTLS, HMAC v2, Ed25519): certification, runtime Bridge
// availability, independent approval bound to the exact intent, single use,
// races, expiry, revocation, payload/scope/version changes, policy change,
// and the Bridge's own refusal. Every unsafe case fails closed with no
// unauthorized source call.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { startBridgeHarness, opensslAvailable, SCOPE } = require("./helpers/bridge-harness");
const { memoryApprovals } = require("../src/db/approvals");
const { memoryCertifications } = require("../src/db/certifications");
const { contractRevision } = require("../src/sync/bridge-consumer");
const F = require("./helpers/fixtures");

const skip = !opensslAvailable() && "openssl unavailable";
const CAP = "karryam.hq.exports.create"; // R3, POST /hq/exports (Section 11.7)
const SOURCE = "hq.exports.create";
const scopeArrays = { market: [SCOPE.market], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] };
const single = { market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant };

function exportCommand({ rowLimit = 500, expectedVersion = 3, approvalRef, sourceApproval = "5f0a1c2e-3d4b-4a5c-8d6e-7f8091a2b3c4" } = {}) {
  return {
    command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id: CAP,
    target: { type: "export", id: "export-request", expected_version: expectedVersion },
    params: { body: { approval_id: sourceApproval, row_limit: rowLimit }, ...(approvalRef ? { approval_ref: approvalRef } : {}) },
    reason_code: "REGULATOR_REQUEST", case_reference: "case-77", scope: scopeArrays,
  };
}
const intentOf = (cmd, staff = "staff-17") => F.contracts.digestOf({ capability: CAP, target: cmd.target, body: cmd.params.body, scope: single, staff });

async function harness(t, { clock } = {}) {
  const now = clock ? () => clock.ms : Date.now;
  const certifications = memoryCertifications([{
    id: "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e", capability_id: CAP, risk: "R3", contract_revision: contractRevision(), source_policy_revision: "owner-policy-7",
    evidence_ref: "cab/2026-11/exports", valid_from: new Date(Date.now() - 3600000).toISOString(), expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  }]);
  const runtime = { state: "AVAILABLE" };
  const governance = { runtimeAvailability: async () => ({ ...runtime }) };
  const h = await startBridgeHarness(t, {
    configOverrides: { enabledCommands: Object.freeze([CAP]), highRiskCertified: Object.freeze([CAP]) },
    deps: { certifications, governance, approvals: memoryApprovals({ now }) },
  });
  h.fake.state.handlers[SOURCE] = () => ({ result: { export_id: randomUUID(), row_count: 42, download_token: "A".repeat(43), expires_at: new Date(Date.now() + 600000).toISOString(), plaintext_sha256: "b".repeat(64) } });
  const submit = (cmd, claims = {}) => h.client.submitOperation(cmd, { delegation: h.delegate(F.contracts.BASE_PATH + "/operations", { method: "POST", body: cmd, action: "operation.submit", scope: scopeArrays, ...claims }) });
  const local = (capability_id, params, claims = {}) => {
    const cmd = { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id, target: { type: "approval", id: "approval", expected_version: null }, params, reason_code: "HIGH_RISK_CHANGE", case_reference: null, scope: scopeArrays };
    return submit(cmd, claims).then((res) => ({ res, cmd }));
  };
  const approve = async (cmd, { approver = "staff-99", ttl = 600 } = {}) => {
    const { res, cmd: p } = await local("karryam.governance.approval.propose", { capability_id: CAP, intent_digest: intentOf(cmd), ttl_seconds: ttl, expected_version: cmd.target.expected_version });
    assert.equal(res.json.result && res.json.result.approval.status, "PROPOSED", JSON.stringify(res.json));
    const d = await local("karryam.governance.approval.decide", { approval_id: p.command_id, decision: "APPROVE" }, { sub: approver });
    assert.equal(d.res.json.result && d.res.json.result.approval.status, "APPROVED", JSON.stringify(d.res.json));
    return p.command_id;
  };
  const dispatched = () => h.fake.state.requests.filter((r) => r.capability === SOURCE).length;
  return { ...h, certifications, runtime, submit, local, approve, dispatched };
}

test("R3 exposure needs the operator listing AND a certification in force; certified + approved executes once with the original staff identity", { skip }, async (t) => {
  const h = await harness(t);
  const cap = (await h.client.getCapabilities()).json.result.capabilities.find((c) => c.id === CAP);
  assert.equal(cap.state, "AVAILABLE");
  assert.equal(cap.requires_independent_approval, true);
  assert.equal(cap.requires_recent_mfa, true);

  // No approval reference: refused before anything is recorded or sent.
  const bare = await h.submit(exportCommand());
  assert.equal(bare.json.error.reason, "INDEPENDENT_APPROVAL_REQUIRED");
  assert.equal(h.dispatched(), 0);

  const cmd = exportCommand();
  cmd.params.approval_ref = await h.approve(cmd);
  const ok = await h.submit(cmd);
  assert.equal(ok.json.result.status, "SUCCEEDED", JSON.stringify(ok.json));
  assert.equal(ok.json.result.approval_ref, cmd.params.approval_ref);
  assert.equal(h.dispatched(), 1);
  const sent = h.fake.state.requests.find((r) => r.capability === SOURCE);
  assert.equal(sent.claims.sub, "staff-17", "the original requesting staff identity reaches the Bridge assertion");
  assert.deepEqual(sent.body, cmd.params.body);
  assert.equal(JSON.stringify(ok.json).includes("A".repeat(43)), false, "the single-use download token is never stored or returned in the operation receipt");
  assert.equal((await h.approvals.get(cmd.params.approval_ref)).status, "CONSUMED");

  // The same approval cannot be used again, even for an identical new command.
  const again = exportCommand();
  again.params.approval_ref = cmd.params.approval_ref;
  const reuse = await h.submit(again);
  assert.equal(reuse.json.error.reason, "APPROVAL_ALREADY_CONSUMED");
  assert.equal(h.dispatched(), 1);
  // A retried submission of the original command replays, never dispatches again.
  assert.equal((await h.submit(cmd)).json.result.replay, true);
  // Concurrent duplicates of one new command dispatch at most once.
  const dup = exportCommand();
  dup.params.approval_ref = await h.approve(dup);
  const both = await Promise.all([h.submit(dup), h.submit(dup)]);
  assert.equal(h.dispatched(), 2, JSON.stringify(both.map((b) => b.json.result || b.json.error)));
});

test("approval rules: independent, in-scope, approved role, recent MFA; racing approvers; requester cannot revoke", { skip }, async (t) => {
  const h = await harness(t);
  const cmd = exportCommand();
  const { cmd: proposal } = await h.local("karryam.governance.approval.propose", { capability_id: CAP, intent_digest: intentOf(cmd), ttl_seconds: 600, expected_version: 3 });
  const decide = (claims) => h.local("karryam.governance.approval.decide", { approval_id: proposal.command_id, decision: "APPROVE" }, claims).then((r) => r.res.json);
  assert.equal((await decide({})).error.reason, "APPROVER_MUST_BE_INDEPENDENT");
  assert.equal((await decide({ sub: "staff-50", scope: { ...scopeArrays, zone: ["abuja-central"] } })).error.reason, "SCOPE_DENIED");
  assert.equal((await decide({ sub: "staff-50", scope: { market: scopeArrays.market, organization: scopeArrays.organization, zone: scopeArrays.zone, tenant: ["tenant-a"] }, role: "karryam.unknown.role" })).error.reason, "APPROVER_ROLE_NOT_APPROVED");
  assert.equal((await decide({ sub: "staff-50", mfa_at: Math.floor(Date.now() / 1000) - 900 })).error.reason, "RECENT_MFA_REQUIRED");
  // An approver delegated only market/organization cannot approve a zone/tenant-scoped intent.
  const narrow = { market: scopeArrays.market, organization: scopeArrays.organization };
  const narrowDecide = { command_id: randomUUID(), idempotency_key: "idem-" + randomUUID(), capability_id: "karryam.governance.approval.decide", target: { type: "approval", id: "approval", expected_version: null },
    params: { approval_id: proposal.command_id, decision: "APPROVE" }, reason_code: "HIGH_RISK_CHANGE", case_reference: null, scope: narrow };
  assert.equal((await h.submit(narrowDecide, { sub: "staff-51", scope: narrow })).json.error.reason, "APPROVER_SCOPE_INSUFFICIENT");
  // Two approvers race: exactly one decision is recorded.
  const [a, b] = await Promise.all([decide({ sub: "staff-98" }), decide({ sub: "staff-99" })]);
  const outcomes = [a, b].map((r) => (r.result ? r.result.approval.status : r.error.reason)).sort();
  assert.deepEqual(outcomes, ["APPROVAL_ALREADY_DECIDED", "APPROVED"]);
  // The requester cannot revoke an approved reference (to re-shop approvers); someone else can.
  const own = await h.local("karryam.governance.approval.revoke", { approval_id: proposal.command_id, reason_code: "WITHDRAWN" });
  assert.equal(own.res.json.error.reason, "REQUESTER_CANNOT_REVOKE_APPROVAL");
  const other = await h.local("karryam.governance.approval.revoke", { approval_id: proposal.command_id, reason_code: "APPROVER_ACCESS_REMOVED" }, { sub: "staff-60" });
  assert.equal(other.res.json.result.approval.status, "REVOKED");
  cmd.params.approval_ref = proposal.command_id;
  assert.equal((await h.submit(cmd)).json.error.reason, "APPROVAL_REVOKED");
  assert.equal(h.dispatched(), 0);
});

test("unsafe executions fail closed: changed payload, scope, version, runtime availability, certification, policy, expiry, missing MFA, Bridge refusal", { skip }, async (t) => {
  const clock = { ms: Date.now() };
  const h = await harness(t, { clock });

  // Changed payload after approval.
  const cmd = exportCommand();
  const ref = await h.approve(cmd);
  const changed = exportCommand({ rowLimit: 9000, approvalRef: ref });
  assert.equal((await h.submit(changed)).json.error.reason, "APPROVAL_BINDING_MISMATCH");
  // Changed expected source version (part of the bound intent).
  assert.equal((await h.submit(exportCommand({ expectedVersion: 4, approvalRef: ref }))).json.error.reason, "APPROVAL_BINDING_MISMATCH");
  // Changed scope: outside the delegation, refused before anything else.
  const wider = exportCommand({ approvalRef: ref });
  wider.scope = { ...scopeArrays, tenant: ["tenant-b"] };
  assert.equal((await h.submit(wider)).json.error.reason, "SCOPE_DENIED");
  assert.equal(h.dispatched(), 0);

  // Runtime availability unknown or reported unavailable by the Bridge.
  h.runtime.state = "UNKNOWN";
  assert.equal((await h.submit(exportCommand({ approvalRef: ref }))).json.error.reason, "RUNTIME_AVAILABILITY_UNKNOWN");
  h.runtime.state = "DISABLED";
  assert.equal((await h.submit(exportCommand({ approvalRef: ref }))).json.error.reason, "RUNTIME_CAPABILITY_DISABLED");
  h.runtime.state = "AVAILABLE";
  assert.equal(h.dispatched(), 0);
  assert.equal((await h.approvals.get(ref)).status, "APPROVED", "refused submissions never consume the approval");

  // Missing recent MFA on the requester.
  assert.equal((await h.submit(exportCommand({ approvalRef: ref }), { mfa_at: Math.floor(Date.now() / 1000) - 900 })).json.error.reason, "RECENT_MFA_REQUIRED");

  // Expiry between approval and execution.
  const late = exportCommand();
  late.params.approval_ref = await h.approve(late, { ttl: 60 });
  clock.ms += 120000;
  assert.equal((await h.submit(late)).json.error.reason, "APPROVAL_EXPIRED");
  clock.ms = Date.now();

  // Certification revoked: refused immediately, even with a valid approval.
  const cert = h.certifications.rows[0];
  cert.revoked_at = new Date().toISOString();
  assert.equal((await h.submit(exportCommand({ approvalRef: ref }))).json.error.reason, "HIGH_RISK_CERTIFICATION_REQUIRED");
  // Re-certified under a new owner policy revision: approvals reviewed under the old one are void.
  h.certifications.rows.push({ ...cert, id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", source_policy_revision: "owner-policy-8", revoked_at: null });
  const stale = exportCommand({ approvalRef: ref });
  assert.equal((await h.submit(stale)).json.error.reason, "APPROVAL_CERTIFICATION_CHANGED");
  assert.equal(h.dispatched(), 0);

  // The Bridge refuses an otherwise locally approved command: FAILED, never retried.
  h.fake.state.handlers[SOURCE] = () => ({ status: 403, error: "forbidden" });
  const refused = exportCommand();
  refused.params.approval_ref = await h.approve(refused);
  const res = await h.submit(refused);
  assert.equal(res.json.result.status, "FAILED", JSON.stringify(res.json));
  assert.equal(res.json.result.executed, false);
  assert.equal(h.dispatched(), 1);
  assert.equal((await h.submit(refused)).json.result.replay, true);
  assert.equal(h.dispatched(), 1);
});
