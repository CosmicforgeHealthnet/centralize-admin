"use strict";

// Section 29 — Approvals mandatory suite (self-approval, stale fingerprint,
// quorum, revoke, expiry, override) driving the production approval service,
// eligibility policy, approval-integrity checker and emergency override
// service with injected clocks — no real-time sleeps anywhere.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApprovalService } = require("../approvals/approval.service");
const { ApprovalRepository } = require("../approvals/approval.repository");
const { assertApprovalEligibility, countEligibleApprovals, authorizeEmergencyOverride } = require("../policy/execution-policy.service");
const { assertApprovalIntegrity } = require("../validation/approval-integrity.service");
const { assertOverrideMatches, consumeOverrideInTransaction, NON_OVERRIDABLE_CONTROLS, MAXIMUM_DURATION_MS } = require("../policy/emergency-override.service");
const { STABLE_ERROR_DEFINITIONS, CODE_ALIASES } = require("../execution.errors");

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT = "a".repeat(64);
const NOW = new Date("2026-07-23T10:00:00.000Z");

function plan(overrides = {}) {
  return {
    id: "plan-1", provider: "META", connectionId: CONNECTION, currencyCode: "USD",
    budgetLimit: 100, authorId: "author-1", version: 2, validationFingerprint: FINGERPRINT,
    state: "PENDING_APPROVAL",
    ...overrides,
  };
}

function approver(overrides = {}) {
  return {
    id: "approver-1", status: "ACTIVE", executionRoles: ["APPROVER"], hasEditPermission: true,
    eligibleProviders: ["META"], eligibleConnectionIds: [CONNECTION], eligibleCurrencies: ["USD"],
    eligibleApprovalTiers: ["EXECUTIVE"], maximumApprovalAmount: 1000,
    ...overrides,
  };
}

function approvalInput(overrides = {}) {
  return { planVersion: 2, validationFingerprint: FINGERPRINT, decision: "APPROVED", ...overrides };
}

test("29-APPROVAL self-approval: author is never the sole approver and roles cannot bypass separation", () => {
  const author = approver({ id: "author-1" });
  assert.throws(() => assertApprovalEligibility({ actor: author, plan: plan(), policy: {}, approval: approvalInput() }), (error) => error.code === "SELF_APPROVAL_FORBIDDEN");
  // Elevated execution-administrator role does not silently bypass separation of duties.
  const elevatedAuthor = approver({ id: "author-1", executionRoles: ["APPROVER", "EXECUTION_ADMINISTRATOR"] });
  assert.throws(() => assertApprovalEligibility({ actor: elevatedAuthor, plan: plan(), policy: {}, approval: approvalInput() }), (error) => error.code === "SELF_APPROVAL_FORBIDDEN");
  // A worker can never approve even when it also carries the approver role.
  assert.throws(() => assertApprovalEligibility({ actor: approver({ executionRoles: ["APPROVER", "SYSTEM_WORKER"] }), plan: plan(), policy: {}, approval: approvalInput() }), (error) => error.errors[0].reasonCode === "WORKER_CANNOT_APPROVE");
  // Author plus an independent approver is allowed only when the policy says so.
  assert.equal(assertApprovalEligibility({ actor: author, plan: plan(), policy: { allowAuthorAsNonSoleApprover: true, requiredApprovals: 2 }, approval: approvalInput() }), true);
  assert.throws(() => assertApprovalEligibility({ actor: author, plan: plan(), policy: { allowAuthorAsNonSoleApprover: true, requiredApprovals: 1 }, approval: approvalInput() }), (error) => error.code === "SELF_APPROVAL_FORBIDDEN");
  // The stable error mapping is 403 EXECUTION_SELF_APPROVAL_FORBIDDEN.
  assert.equal(CODE_ALIASES.SELF_APPROVAL_FORBIDDEN, "EXECUTION_SELF_APPROVAL_FORBIDDEN");
  assert.equal(STABLE_ERROR_DEFINITIONS.EXECUTION_SELF_APPROVAL_FORBIDDEN.status, 403);
});

test("29-APPROVAL stale fingerprint or version is rejected at approval, queue and retry boundaries", () => {
  // Approval against a stale fingerprint or version.
  assert.throws(() => assertApprovalEligibility({ actor: approver(), plan: plan(), policy: {}, approval: approvalInput({ validationFingerprint: "b".repeat(64) }) }), (error) => error.code === "STALE_VALIDATION_FINGERPRINT");
  assert.throws(() => assertApprovalEligibility({ actor: approver(), plan: plan(), policy: {}, approval: approvalInput({ planVersion: 1 }) }), (error) => error.code === "PLAN_VERSION_CONFLICT");
  assert.throws(() => assertApprovalEligibility({ actor: approver(), plan: plan({ validationFingerprint: null }), policy: {}, approval: approvalInput() }), (error) => error.code === "STALE_VALIDATION_FINGERPRINT");
  // Queue-time integrity rejects a run packet built against a different fingerprint.
  const queuedPlan = { id: "plan-1", status: "APPROVED", version: 2, validationFingerprint: FINGERPRINT, platform: "META", connectionId: CONNECTION, currencyCode: "USD", createdByAdminUserId: "author-1", desiredState: {} };
  assert.throws(() => assertApprovalIntegrity({ plan: queuedPlan, run: { planId: "plan-1", approvedPlanVersion: 1, approvalFingerprint: FINGERPRINT }, approvals: [], now: NOW }), (error) => error.errors[0].reasonCode === "APPROVAL_PACKET_MISMATCH");
  assert.throws(() => assertApprovalIntegrity({ plan: queuedPlan, run: { planId: "plan-1", approvedPlanVersion: 2, approvalFingerprint: "b".repeat(64) }, approvals: [], now: NOW }), (error) => error.errors[0].reasonCode === "APPROVAL_PACKET_MISMATCH");
  // A new validation invalidates prior approvals: only matching-version rows count.
  const staleApprovals = [{ planId: "plan-1", planVersion: 1, validationFingerprint: "b".repeat(64), decision: "APPROVED", approverAdminUserId: "approver-1", approvalScope: { approverTier: "EXECUTIVE" } }];
  assert.throws(() => assertApprovalIntegrity({ plan: queuedPlan, run: { planId: "plan-1", approvedPlanVersion: 2, approvalFingerprint: FINGERPRINT }, approvals: staleApprovals, now: NOW }), (error) => error.errors[0].reasonCode === "REQUIRED_APPROVALS_NOT_MET");
});

test("29-APPROVAL quorum: insufficient, exact, duplicate-actor, tier and revoked/rejected handling", () => {
  const currentPlan = plan();
  const approvalRow = (id, overrides = {}) => ({
    planId: "plan-1", planVersion: 2, validationFingerprint: FINGERPRINT, decision: "APPROVED",
    actorId: id, approverAdminUserId: id, events: [], ...overrides,
  });
  // One of two approvals is insufficient; the exact quorum passes; extra approvals stay fine.
  const service = createApprovalService({ repository: { create: async (data) => data } });
  const policy = { requiredApprovals: 2 };
  assert.equal(service.approvalThresholdMet({ approvals: [approvalRow("a1")], plan: currentPlan, policy }), false);
  assert.equal(service.approvalThresholdMet({ approvals: [approvalRow("a1"), approvalRow("a2")], plan: currentPlan, policy }), true);
  assert.equal(service.approvalThresholdMet({ approvals: [approvalRow("a1"), approvalRow("a2"), approvalRow("a3")], plan: currentPlan, policy }), true);
  // Duplicate approvals by the same actor count once.
  assert.equal(countEligibleApprovals([approvalRow("a1"), approvalRow("a1")], currentPlan), 1);
  // Rejected, revoked and stale rows never count.
  assert.equal(countEligibleApprovals([
    approvalRow("a1", { decision: "REJECTED" }),
    approvalRow("a2", { events: [{ decision: "REVOKED" }] }),
    approvalRow("a3", { active: false }),
    approvalRow("a4", { planVersion: 1 }),
    approvalRow("a5", { validationFingerprint: "b".repeat(64) }),
  ], currentPlan), 0);
  // Tier requirements and mixed eligible/ineligible approvals at queue time.
  const queuedPlan = { id: "plan-1", status: "APPROVED", version: 2, validationFingerprint: FINGERPRINT, platform: "META", connectionId: CONNECTION, currencyCode: "USD", createdByAdminUserId: "author-1", desiredState: { approvalPolicy: { requiredApprovals: 2, requiredTier: "EXECUTIVE" } } };
  const mixed = [
    approvalRow("author-1", { approvalScope: { approverTier: "EXECUTIVE" } }),
    approvalRow("a1", { approvalScope: { approverTier: "EMPLOYEE" } }),
    approvalRow("a2", { approvalScope: { approverTier: "EXECUTIVE" } }),
    approvalRow("a3", { approvalScope: { approverTier: "SUPER" } }),
  ];
  const integrity = assertApprovalIntegrity({ plan: queuedPlan, run: { planId: "plan-1", approvedPlanVersion: 2, approvalFingerprint: FINGERPRINT }, approvals: mixed, now: NOW });
  // The author row and the under-tier row are excluded; exactly a2 and a3 qualify.
  assert.equal(integrity.approvals.length, 2);
  // A rejected decision on the current packet blocks entirely.
  assert.throws(() => assertApprovalIntegrity({ plan: queuedPlan, run: { planId: "plan-1", approvedPlanVersion: 2, approvalFingerprint: FINGERPRINT }, approvals: [...mixed, approvalRow("a9", { decision: "REJECTED" })], now: NOW }), (error) => error.errors[0].reasonCode === "APPROVAL_REJECTED");
});

test("29-APPROVAL decide persists an immutable packet and only PENDING_APPROVAL plans accept decisions", async () => {
  const persisted = [];
  const service = createApprovalService({ repository: { create: async (data) => { persisted.push(data); return { id: "approval-1", ...data }; } } });
  const created = await service.decide({ actor: approver(), plan: plan(), policy: {}, input: approvalInput() });
  assert.equal(created.planVersion, 2);
  assert.equal(created.validationFingerprint, FINGERPRINT);
  assert.equal(created.approvalScope.provider, "META");
  assert.equal(created.approvalScope.currencyCode, "USD");
  await assert.rejects(service.decide({ actor: approver(), plan: plan({ state: "DRAFT" }), policy: {}, input: approvalInput() }), (error) => error.code === "INVALID_PLAN_TRANSITION");
  await assert.rejects(service.decide({ actor: approver(), plan: plan({ state: "QUEUED" }), policy: {}, input: approvalInput() }), (error) => error.code === "INVALID_PLAN_TRANSITION");
  // Invalid decision enums and malformed fingerprints are rejected.
  await assert.rejects(service.decide({ actor: approver(), plan: plan(), policy: {}, input: approvalInput({ decision: "MAYBE" }) }), (error) => error.errors[0].reasonCode === "INVALID_APPROVAL_INPUT");
  await assert.rejects(service.decide({ actor: approver(), plan: plan(), policy: {}, input: approvalInput({ validationFingerprint: "xyz" }) }), (error) => error.errors[0].reasonCode === "INVALID_APPROVAL_INPUT");
  assert.equal(persisted.length, 1);
});

test("29-APPROVAL revoke is an append-only event by the owning actor with a mandatory reason", async () => {
  const events = [];
  const client = {
    marketingExecutionApproval: {
      findUnique: async ({ where }) => where.id === "approval-1" ? { id: "approval-1", approverAdminUserId: "approver-1", decision: "APPROVED" } : null,
      create: async ({ data }) => data,
    },
    marketingExecutionApprovalEvent: { create: async ({ data }) => { events.push(data); return { id: `event-${events.length}`, ...data }; } },
  };
  const repository = new ApprovalRepository({ client, now: () => NOW });
  const revocation = await repository.revoke("approval-1", "approver-1", "No longer safe");
  assert.equal(revocation.decision, "REVOKED");
  assert.equal(events.length, 1, "revocation is a new event; the original row is untouched");
  // Reason is mandatory; a non-owner cannot revoke; a rejected row cannot be revoked.
  await assert.rejects(repository.revoke("approval-1", "approver-1", "  "), (error) => error.code === "APPROVAL_REASON_REQUIRED");
  await assert.rejects(repository.revoke("approval-1", "someone-else", "reason"), (error) => error.errors[0].reasonCode === "APPROVAL_NOT_REVOCABLE");
  await assert.rejects(repository.revoke("missing", "approver-1", "reason"), (error) => error.errors[0].reasonCode === "APPROVAL_NOT_REVOCABLE");
  // Service layer: only current APPROVED decisions are revocable, and quorum
  // recalculates because revoked rows no longer count.
  const service = createApprovalService({ repository });
  await assert.rejects(service.revoke({ actor: approver(), approval: { id: "approval-1", decision: "REJECTED" }, reason: "r" }), (error) => error.errors[0].reasonCode === "APPROVAL_NOT_CURRENT");
  const revokedRow = { planId: "plan-1", planVersion: 2, validationFingerprint: FINGERPRINT, decision: "APPROVED", actorId: "a1", events: [{ decision: "REVOKED" }] };
  assert.equal(countEligibleApprovals([revokedRow], plan()), 0);
  // Revocation after queue/execution is rejected by integrity (plan no longer queue-eligible without quorum).
  const queuedPlan = { id: "plan-1", status: "QUEUED", version: 2, validationFingerprint: FINGERPRINT, platform: "META", connectionId: CONNECTION, currencyCode: "USD", createdByAdminUserId: "author-1", desiredState: {} };
  assert.throws(() => assertApprovalIntegrity({ plan: queuedPlan, run: { planId: "plan-1", approvedPlanVersion: 2, approvalFingerprint: FINGERPRINT }, approvals: [revokedRow], now: NOW }), (error) => error.errors[0].reasonCode === "REQUIRED_APPROVALS_NOT_MET");
});

test("29-APPROVAL expiry uses injected clocks with exact boundary semantics", () => {
  const expiringPlan = {
    id: "plan-1", status: "APPROVED", version: 2, validationFingerprint: FINGERPRINT,
    platform: "META", connectionId: CONNECTION, currencyCode: "USD", createdByAdminUserId: "author-1",
    desiredState: {}, expiresAt: new Date("2026-07-23T10:00:00.000Z"),
  };
  const run = { planId: "plan-1", approvedPlanVersion: 2, approvalFingerprint: FINGERPRINT };
  const approvals = [{ planId: "plan-1", planVersion: 2, validationFingerprint: FINGERPRINT, decision: "APPROVED", approverAdminUserId: "a1", approvalScope: { approverTier: "EXECUTIVE" } }];
  // One millisecond before expiry passes; the exact boundary fails closed.
  assert.equal(assertApprovalIntegrity({ plan: expiringPlan, run, approvals, now: new Date("2026-07-23T09:59:59.999Z") }).approvals.length, 1);
  assert.throws(() => assertApprovalIntegrity({ plan: expiringPlan, run, approvals, now: new Date("2026-07-23T10:00:00.000Z") }), (error) => error.errors[0].reasonCode === "APPROVAL_PACKET_EXPIRED");
  assert.throws(() => assertApprovalIntegrity({ plan: expiringPlan, run, approvals, now: new Date("2026-07-23T10:00:00.001Z") }), (error) => error.errors[0].reasonCode === "APPROVAL_PACKET_EXPIRED");
});

test("29-APPROVAL override requires elevated MFA-capable actor, explicit scope and bounded duration", async () => {
  const audits = [];
  const auditWriter = { writeImmutable: async (entry) => audits.push(entry) };
  const operator = { id: "super-1", status: "ACTIVE", executionRoles: ["EXECUTION_ADMINISTRATOR"], tier: "SUPER", twoFactorEnabled: true };
  const override = { reason: "Emergency connection unblock for incident CF-99", scope: { planId: "plan-1" }, expiresAt: "2026-07-23T11:00:00.000Z" };
  await assert.rejects(authorizeEmergencyOverride({ actor: { ...operator, executionRoles: ["APPROVER"] }, override, executionConfig: { enabled: true }, policy: { emergencyOverrideAllowed: true }, auditWriter }), (error) => error.errors[0].reasonCode === "ROLE_ACTION_FORBIDDEN");
  await assert.rejects(authorizeEmergencyOverride({ actor: { ...operator, tier: "EMPLOYEE" }, override, executionConfig: { enabled: true }, policy: { emergencyOverrideAllowed: true }, auditWriter }), (error) => error.errors[0].reasonCode === "ELEVATED_AUTHORIZATION_REQUIRED");
  await assert.rejects(authorizeEmergencyOverride({ actor: { ...operator, twoFactorEnabled: false }, override, executionConfig: { enabled: true }, policy: { emergencyOverrideAllowed: true }, auditWriter }), (error) => error.errors[0].reasonCode === "TWO_FACTOR_REQUIRED");
  await assert.rejects(authorizeEmergencyOverride({ actor: operator, override, executionConfig: { enabled: true }, policy: { emergencyOverrideAllowed: false }, auditWriter }), (error) => error.errors[0].reasonCode === "OVERRIDE_POLICY_DISABLED");
  // The global switch can never be bypassed by an override.
  await assert.rejects(authorizeEmergencyOverride({ actor: operator, override, executionConfig: { enabled: false }, policy: { emergencyOverrideAllowed: true }, auditWriter }), (error) => error.code === "EXECUTION_DISABLED");
  assert.equal(MAXIMUM_DURATION_MS, 2 * 60 * 60 * 1000);
});

test("29-APPROVAL override matching rejects expired, revoked, scope-mismatched and control-weakened overrides", () => {
  const scopePlan = { id: "plan-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_123" };
  const actor = { id: "operator-1", tier: "ADMIN" };
  const goodOverride = {
    status: "ACTIVE", revokedAt: null, startsAt: new Date("2026-07-23T09:00:00.000Z"), expiresAt: new Date("2026-07-23T11:00:00.000Z"),
    approvedByAdminUserId: "operator-1", mfaEvidenceReference: "admin-user-2fa-enabled:operator-1",
    allowedControls: ["CONNECTION_WRITE_GATE"], nonOverridableControls: [...NON_OVERRIDABLE_CONTROLS],
    planId: "plan-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_123",
    requestedByAdminUserId: "operator-1",
  };
  assert.equal(assertOverrideMatches(goodOverride, { actor, plan: scopePlan, now: NOW }), goodOverride);
  const failures = [
    [{ ...goodOverride, expiresAt: NOW }, "EMERGENCY_OVERRIDE_INACTIVE_OR_EXPIRED"],
    [{ ...goodOverride, revokedAt: NOW }, "EMERGENCY_OVERRIDE_INACTIVE_OR_EXPIRED"],
    [{ ...goodOverride, status: "REVOKED" }, "EMERGENCY_OVERRIDE_INACTIVE_OR_EXPIRED"],
    [{ ...goodOverride, mfaEvidenceReference: null }, "EMERGENCY_OVERRIDE_APPROVAL_OR_MFA_REQUIRED"],
    [{ ...goodOverride, planId: "plan-2" }, "EMERGENCY_OVERRIDE_SCOPE_MISMATCH"],
    [{ ...goodOverride, connectionId: "22222222-2222-4222-8222-222222222222" }, "EMERGENCY_OVERRIDE_SCOPE_MISMATCH"],
    [{ ...goodOverride, requestedByAdminUserId: "someone-else" }, "EMERGENCY_OVERRIDE_ACTOR_MISMATCH"],
    [{ ...goodOverride, nonOverridableControls: ["IDEMPOTENCY"] }, "NON_OVERRIDABLE_CONTROLS_INCOMPLETE"],
    [{ ...goodOverride, allowedControls: ["GLOBAL_HARD_SHUTDOWN"] }, "OVERRIDE_CONTROL_NOT_ALLOWED"],
  ];
  for (const [override, reasonCode] of failures) {
    assert.throws(() => assertOverrideMatches(override, { actor, plan: scopePlan, now: NOW }), (error) => error.errors[0].reasonCode === reasonCode, reasonCode);
  }
  // The full non-overridable control set can never be reduced.
  assert.ok(NON_OVERRIDABLE_CONTROLS.includes("REGULATED_CATEGORY_PROHIBITION"));
  assert.ok(NON_OVERRIDABLE_CONTROLS.includes("GLOBAL_HARD_SHUTDOWN"));
});

test("29-APPROVAL EXECUTION_OVERRIDE_USED is written only when the override is actually consumed", async () => {
  const scopePlan = { id: "plan-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_123" };
  const actor = { id: "operator-1", tier: "ADMIN" };
  const override = {
    id: "override-1", status: "ACTIVE", revokedAt: null, useCount: 0,
    startsAt: new Date("2026-07-23T09:00:00.000Z"), expiresAt: new Date("2026-07-23T11:00:00.000Z"),
    approvedByAdminUserId: "operator-1", mfaEvidenceReference: "admin-user-2fa-enabled:operator-1",
    allowedControls: ["CONNECTION_WRITE_GATE"], nonOverridableControls: [...NON_OVERRIDABLE_CONTROLS],
    planId: "plan-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_123",
    requestedByAdminUserId: "operator-1", reason: "incident", runId: null, operationId: null,
  };
  const audits = [];
  const tx = {
    marketingExecutionEmergencyOverride: {
      findUnique: async () => override,
      updateMany: async ({ where }) => ({ count: where.useCount === override.useCount ? 1 : 0 }),
    },
    auditLog: { create: async ({ data }) => audits.push(data) },
  };
  // Verification without consumption writes no audit row.
  await consumeOverrideInTransaction(tx, { overrideId: "override-1", actor, plan: scopePlan, consume: false, now: NOW });
  assert.equal(audits.length, 0);
  // Consumption increments use count and writes exactly one immutable audit row.
  const consumed = await consumeOverrideInTransaction(tx, { overrideId: "override-1", actor, plan: scopePlan, consume: true, now: NOW });
  assert.equal(consumed.useCount, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "EXECUTION_OVERRIDE_USED");
  // A concurrent consumption (changed useCount predicate) fails closed.
  const racingTx = { ...tx, marketingExecutionEmergencyOverride: { ...tx.marketingExecutionEmergencyOverride, updateMany: async () => ({ count: 0 }) } };
  await assert.rejects(consumeOverrideInTransaction(racingTx, { overrideId: "override-1", actor, plan: scopePlan, consume: true, now: NOW }), (error) => error.errors[0].reasonCode === "EMERGENCY_OVERRIDE_CHANGED");
});
