const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { readExecutionConfig } = require("../execution.config");
const { PLAN_STATES, OPERATION_STATES, PROVIDERS } = require("../execution.constants");
const { createExecutionAdapterRegistry } = require("../adapters/execution-adapter.registry");
const metaAdapter = require("../adapters/meta.execution-adapter");
const workerModule = require("../jobs/execution-worker");
const { fingerprintPlan } = require("../plans/plan-fingerprint");
const { validatePlanInput } = require("../plans/plan.validator");
const {
  assertEditable,
  assertEvidenceMutable,
  transitionPlan,
  createPlanService,
} = require("../plans/plan.service");
const {
  assertActionAllowed,
  assertApprovalEligibility,
  countEligibleApprovals,
  authorizeEmergencyOverride,
} = require("../policy/execution-policy.service");
const { createApprovalService } = require("../approvals/approval.service");
const { transitionOperation, scheduleRetry } = require("../operations/operation.service");
const { derivePlanOutcome } = require("../operations/operation-result");
const { createExecutionService } = require("../execution.service");
const { sanitizeExecutionEvent } = require("../execution.observability");

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const baseIntent = Object.freeze({
  provider: "META",
  connectionId: CONNECTION_ID,
  accountId: "account-1",
  currencyCode: "USD",
  objective: "CONVERSIONS",
  budgetLimit: 500,
  operations: [{ type: "CREATE_CAMPAIGN", sequence: 0, parameters: { dailyBudget: 25 } }],
  labels: ["beta", "alpha"],
  name: "Display only",
});

function productionSources(directory = path.resolve(__dirname, "..")) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    return entry.name.endsWith(".js") ? [[absolute, fs.readFileSync(absolute, "utf8")]] : [];
  });
}

test("Advertising Execution is a separate Marketing sibling domain", () => {
  const marketingRoot = path.resolve(__dirname, "../..");
  assert.ok(fs.statSync(path.join(marketingRoot, "advertising-execution")).isDirectory());
  assert.ok(fs.statSync(path.join(marketingRoot, "intelligence")).isDirectory());
  assert.ok(fs.statSync(path.join(marketingRoot, "social-operations")).isDirectory());
});

test("production module does not depend on mainPrisma or Social Operations", () => {
  const combined = productionSources().map(([, source]) => source).join("\n");
  assert.doesNotMatch(combined, /mainPrisma|mainDatabase/);
  assert.doesNotMatch(combined, /social-operations/);
});

test("controllers do not import adapters or construct provider-native payloads", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../execution.controller.js"), "utf8");
  assert.doesNotMatch(source, /execution-adapter|google-ads|meta\.execution|tiktok|linkedin|x\.execution/);
  assert.doesNotMatch(source, /providerPayload|nativePayload|mutationPayload/);
});

test("provider adapters contain no directly imported HTTP transport", () => {
  const sources = productionSources(path.resolve(__dirname, "../adapters")).map(([, source]) => source).join("\n");
  assert.doesNotMatch(sources, /require\(["'](?:axios|googleapis)["']\)|https?\.request|\bfetch\s*\(/);
});

test("observability sanitization removes nested secrets and raw provider payloads", () => {
  assert.deepEqual(sanitizeExecutionEvent({ planId: PLAN_ID, nested: { accessToken: "secret", rawPayload: { secret: true }, status: "SAFE" } }), {
    planId: PLAN_ID,
    nested: { status: "SAFE" },
  });
});

test("Phase 1 ingestion and Phase 2 recommendation modules remain independently available", () => {
  assert.ok(require.resolve("../../intelligence/funnel-ingestion.service"));
  assert.ok(require.resolve("../../intelligence/recommendations/recommendation-evaluation.service"));
});

function expectCode(code, fn) {
  assert.throws(fn, (error) => error.code === code);
}

function actor(overrides = {}) {
  return {
    id: "admin-1",
    status: "ACTIVE",
    executionRoles: ["APPROVER"],
    hasEditPermission: true,
    eligibleProviders: ["META"],
    eligibleConnectionIds: [CONNECTION_ID],
    eligibleCurrencies: ["USD"],
    maximumApprovalAmount: 1000,
    ...overrides,
  };
}

function pendingPlan(overrides = {}) {
  return {
    id: PLAN_ID,
    state: "PENDING_APPROVAL",
    version: 3,
    validationFingerprint: "a".repeat(64),
    authorId: "author-1",
    provider: "META",
    connectionId: CONNECTION_ID,
    currencyCode: "USD",
    budgetLimit: 500,
    ...overrides,
  };
}

test("configuration defaults execution and every provider to disabled", () => {
  const config = readExecutionConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.workerEnabled, false);
  assert.deepEqual(config.providers, Object.fromEntries(PROVIDERS.map((provider) => [provider, false])));
  assert.equal(config.connectionWriteEnabled, false);
});

test("provider and worker flags cannot bypass the global kill switch", () => {
  const config = readExecutionConfig({
    MARKETING_AD_EXECUTION_ENABLED: "false",
    MARKETING_AD_EXECUTION_WORKER_ENABLED: "true",
    MARKETING_AD_EXECUTION_META_ENABLED: "true",
    MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0",
  });
  assert.equal(config.workerConfigured, true);
  assert.equal(config.workerEnabled, false);
  assert.equal(config.configuredProviders.META, true);
  assert.equal(config.providers.META, false);
});

test("invalid boolean configuration is rejected rather than guessed", () => {
  expectCode("INVALID_EXECUTION_CONFIG", () => readExecutionConfig({ MARKETING_AD_EXECUTION_ENABLED: "yes" }));
});

test("registry rejects unknown providers and never falls back", () => {
  expectCode("UNSUPPORTED_PROVIDER", () => createExecutionAdapterRegistry({ env: {} }).get("FACEBOOK"));
});

test("registry blocks a supported provider at the global gate", () => {
  expectCode("EXECUTION_DISABLED", () => createExecutionAdapterRegistry({ env: {} }).resolve("META", { connectionWriteEnabled: true }));
});

test("registry blocks a provider-specific disabled gate", () => {
  expectCode("PROVIDER_CAPABILITY_UNAVAILABLE", () => createExecutionAdapterRegistry({ env: {
    MARKETING_AD_EXECUTION_ENABLED: "true",
  } }).resolve("META", { connectionWriteEnabled: true }));
});

test("connection write capability remains false even when environment flags are true", () => {
  expectCode("PROVIDER_CAPABILITY_UNAVAILABLE", () => createExecutionAdapterRegistry({ env: {
    MARKETING_AD_EXECUTION_ENABLED: "true",
    MARKETING_AD_EXECUTION_META_ENABLED: "true",
    MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0",
  } }).resolve("META", { connectionWriteEnabled: true }));
});

test("provider adapters never fake execution success while gates are disabled", async () => {
  assert.equal(metaAdapter.getCapabilities().writeReady, false);
  await assert.rejects(metaAdapter.executeOperation({}), (error) => error.code === "EXECUTION_DISABLED");
});

test("module import does not start an execution worker", () => {
  assert.equal(workerModule.isStarted(), false);
});

test("disabled kill switch blocks new worker claims", async () => {
  await assert.rejects(workerModule.createExecutionWorker({ env: {} }).claimNext(), (error) => error.code === "EXECUTION_DISABLED");
});

test("required plan and operation state sets are complete", () => {
  assert.equal(PLAN_STATES.length, 15);
  assert.equal(OPERATION_STATES.length, 11);
  assert.ok(PLAN_STATES.includes("PARTIAL_SUCCESS"));
  assert.ok(OPERATION_STATES.includes("UNKNOWN"));
});

test("fingerprint is deterministic across object-key insertion order", () => {
  const left = fingerprintPlan(baseIntent, 1);
  const right = fingerprintPlan({ ...baseIntent, operations: baseIntent.operations, provider: "META" }, 1);
  assert.equal(left.fingerprint, right.fingerprint);
  assert.match(left.fingerprint, /^[a-f0-9]{64}$/);
});

test("semantically unordered labels are canonicalized", () => {
  const left = fingerprintPlan(baseIntent, 1);
  const right = fingerprintPlan({ ...baseIntent, labels: ["alpha", "beta"] }, 1);
  assert.equal(left.fingerprint, right.fingerprint);
});

test("execution operation order remains material", () => {
  const operations = [
    { type: "ONE", parameters: {} },
    { type: "TWO", parameters: {} },
  ];
  const left = fingerprintPlan({ ...baseIntent, operations }, 1);
  const right = fingerprintPlan({ ...baseIntent, operations: [...operations].reverse() }, 1);
  assert.notEqual(left.fingerprint, right.fingerprint);
});

test("material edits change the fingerprint", () => {
  assert.notEqual(fingerprintPlan(baseIntent, 1).fingerprint, fingerprintPlan({ ...baseIntent, budgetLimit: 501 }, 1).fingerprint);
});

test("non-material display metadata does not change the fingerprint", () => {
  assert.equal(fingerprintPlan(baseIntent, 1).fingerprint, fingerprintPlan({ ...baseIntent, name: "Changed", notes: "Changed" }, 1).fingerprint);
});

test("fingerprinting rejects access tokens and encrypted credential envelopes", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => fingerprintPlan({ ...baseIntent, accessToken: "secret" }, 1));
  expectCode("INVALID_EXECUTION_PLAN", () => fingerprintPlan({ ...baseIntent, operations: [{ type: "X", parameters: { access_token: "secret" } }] }, 1));
  expectCode("INVALID_EXECUTION_PLAN", () => fingerprintPlan({ ...baseIntent, operations: [{ type: "X", parameters: { encryptedCredentials: "secret" } }] }, 1));
});

test("plan validation rejects raw provider mutation payloads", () => {
  expectCode("RAW_PROVIDER_PAYLOAD_FORBIDDEN", () => validatePlanInput({ ...baseIntent, operations: [{ type: "X", parameters: { providerPayload: {} } }] }));
});

test("plan validation rejects unsupported fields", () => {
  expectCode("INVALID_EXECUTION_PLAN", () => validatePlanInput({ ...baseIntent, arbitrary: true }));
});

test("plan validation returns the stable unsupported-provider error", () => {
  expectCode("UNSUPPORTED_PROVIDER", () => validatePlanInput({ ...baseIntent, provider: "FACEBOOK" }));
});

test("only DRAFT plans are editable", () => {
  assert.equal(assertEditable({ state: "DRAFT" }), undefined);
  expectCode("PLAN_NOT_EDITABLE", () => assertEditable({ state: "VALIDATED" }));
});

test("valid plan transitions follow the required lifecycle", () => {
  let plan = { state: "DRAFT" };
  plan = transitionPlan(plan, "VALIDATING");
  plan = transitionPlan(plan, "VALIDATED");
  plan = transitionPlan(plan, "PENDING_APPROVAL");
  plan = transitionPlan(plan, "APPROVED", { approvalThresholdMet: true });
  plan = transitionPlan(plan, "QUEUED", { approvalPacketCurrent: true });
  plan = transitionPlan(plan, "EXECUTING");
  plan = transitionPlan(plan, "SUCCEEDED");
  assert.equal(plan.state, "SUCCEEDED");
});

test("arbitrary backward plan transitions are rejected", () => {
  expectCode("INVALID_PLAN_TRANSITION", () => transitionPlan({ state: "APPROVED" }, "DRAFT"));
});

test("APPROVED is not treated as executed", () => {
  const approved = transitionPlan({ state: "PENDING_APPROVAL" }, "APPROVED", { approvalThresholdMet: true });
  assert.equal(approved.state, "APPROVED");
  assert.notEqual(approved.state, "SUCCEEDED");
});

test("approval threshold and current packet are required before approval and queueing", () => {
  expectCode("APPROVAL_NOT_ELIGIBLE", () => transitionPlan({ state: "PENDING_APPROVAL" }, "APPROVED"));
  expectCode("STALE_VALIDATION_FINGERPRINT", () => transitionPlan({ state: "APPROVED" }, "QUEUED"));
});

test("EXECUTING cannot be directly cancelled", () => {
  expectCode("INVALID_PLAN_TRANSITION", () => createPlanService().cancel({ state: "EXECUTING" }));
});

test("rollback requires an approved compensation workflow", () => {
  expectCode("COMPENSATION_APPROVAL_REQUIRED", () => transitionPlan({ state: "FAILED" }, "ROLLBACK_PENDING"));
  assert.equal(transitionPlan({ state: "FAILED" }, "ROLLBACK_PENDING", { compensationApproved: true }).state, "ROLLBACK_PENDING");
});

test("terminal execution evidence cannot be rewritten", () => {
  for (const state of ["SUCCEEDED", "FAILED", "PARTIAL_SUCCESS", "ROLLED_BACK", "CANCELLED"]) {
    expectCode("EXECUTION_ALREADY_TERMINAL", () => assertEvidenceMutable({ state }));
  }
});

test("material edit of a validated plan increments version and invalidates approval state", () => {
  const service = createPlanService();
  const edited = service.reopenValidatedForMaterialEdit({
    state: "VALIDATED", version: 4, intent: baseIntent,
    validationFingerprint: "a".repeat(64), approvals: [{ status: "APPROVED" }],
  }, { ...baseIntent, budgetLimit: 700 });
  assert.equal(edited.state, "DRAFT");
  assert.equal(edited.version, 5);
  assert.equal(edited.validationFingerprint, null);
  assert.deepEqual(edited.approvals, []);
});

test("validation creates a normalized snapshot and SHA-256 fingerprint bound to the version", () => {
  const service = createPlanService();
  const validating = service.beginValidation({ state: "DRAFT", version: 7, intent: baseIntent });
  const validated = service.completeValidation(validating);
  assert.equal(validated.state, "VALIDATED");
  assert.match(validated.validationFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(validated.validationSnapshot.budgetLimit, 500);
  assert.equal(validated.version, 7);
});

test("editing with a stale expected version is rejected", async () => {
  const service = createPlanService({ repository: { save: async (value) => value } });
  await assert.rejects(service.editDraft({ plan: { state: "DRAFT", version: 4 }, input: baseIntent, expectedVersion: 3 }), (error) => error.code === "PLAN_VERSION_CONFLICT");
});

test("viewer and auditor cannot mutate plans", () => {
  for (const role of ["VIEWER", "AUDITOR"]) {
    expectCode("APPROVAL_NOT_ELIGIBLE", () => assertActionAllowed(actor({ executionRoles: [role] }), "CREATE_PLAN"));
  }
});

test("author may create and edit but cannot directly execute", () => {
  const author = actor({ executionRoles: ["AUTHOR"] });
  assert.equal(assertActionAllowed(author, "CREATE_PLAN"), true);
  assert.equal(assertActionAllowed(author, "EDIT_PLAN"), true);
  expectCode("APPROVAL_NOT_ELIGIBLE", () => assertActionAllowed(author, "EXECUTE_OPERATION"));
});

test("approver must be active and have EDIT permission", () => {
  const plan = pendingPlan();
  const approval = { planVersion: 3, validationFingerprint: plan.validationFingerprint };
  expectCode("APPROVAL_NOT_ELIGIBLE", () => assertApprovalEligibility({ actor: actor({ status: "INACTIVE" }), plan, policy: {}, approval }));
  expectCode("APPROVAL_NOT_ELIGIBLE", () => assertApprovalEligibility({ actor: actor({ hasEditPermission: false }), plan, policy: {}, approval }));
});

test("provider, connection, currency and threshold eligibility are enforced", () => {
  const plan = pendingPlan();
  const approval = { planVersion: 3, validationFingerprint: plan.validationFingerprint };
  for (const overrides of [
    { eligibleProviders: [] }, { eligibleConnectionIds: [] }, { eligibleCurrencies: [] }, { maximumApprovalAmount: 499 },
  ]) expectCode("APPROVAL_NOT_ELIGIBLE", () => assertApprovalEligibility({ actor: actor(overrides), plan, policy: {}, approval }));
});

test("stale plan version approval is rejected", () => {
  const plan = pendingPlan();
  expectCode("PLAN_VERSION_CONFLICT", () => assertApprovalEligibility({ actor: actor(), plan, policy: {}, approval: { planVersion: 2, validationFingerprint: plan.validationFingerprint } }));
});

test("stale fingerprint approval is rejected", () => {
  expectCode("STALE_VALIDATION_FINGERPRINT", () => assertApprovalEligibility({ actor: actor(), plan: pendingPlan(), policy: {}, approval: { planVersion: 3, validationFingerprint: "b".repeat(64) } }));
});

test("author cannot be the sole approver", () => {
  const plan = pendingPlan({ authorId: "admin-1" });
  expectCode("SELF_APPROVAL_FORBIDDEN", () => assertApprovalEligibility({ actor: actor(), plan, policy: { requiredApprovals: 1 }, approval: { planVersion: 3, validationFingerprint: plan.validationFingerprint } }));
});

test("system worker cannot approve even if it also carries approver role", () => {
  const plan = pendingPlan();
  expectCode("APPROVAL_NOT_ELIGIBLE", () => assertApprovalEligibility({ actor: actor({ executionRoles: ["APPROVER", "SYSTEM_WORKER"] }), plan, policy: {}, approval: { planVersion: 3, validationFingerprint: plan.validationFingerprint } }));
});

test("rejected, revoked and stale approvals do not count", () => {
  const plan = pendingPlan();
  const current = { actorId: "approver-1", status: "APPROVED", active: true, planVersion: 3, validationFingerprint: plan.validationFingerprint };
  assert.equal(countEligibleApprovals([
    current,
    { ...current, status: "REJECTED" },
    { ...current, active: false },
    { ...current, planVersion: 2 },
    { ...current, validationFingerprint: "b".repeat(64) },
  ], plan), 1);
});

test("duplicate approvals from one actor count only once", () => {
  const plan = pendingPlan();
  const approval = { actorId: "approver-1", status: "APPROVED", active: true, planVersion: 3, validationFingerprint: plan.validationFingerprint };
  assert.equal(countEligibleApprovals([approval, { ...approval }], plan), 1);
});

test("approval service persists an exact immutable version and fingerprint packet", async () => {
  let saved;
  const service = createApprovalService({ repository: { create: async (value) => { saved = value; return value; } } });
  const plan = pendingPlan();
  await service.decide({ actor: actor(), plan, policy: {}, input: { decision: "APPROVED", planVersion: 3, validationFingerprint: plan.validationFingerprint } });
  assert.equal(saved.planVersion, 3);
  assert.equal(saved.validationFingerprint, plan.validationFingerprint);
});

test("emergency override requires reason, exact audit and cannot bypass global switch", async () => {
  const admin = actor({ executionRoles: ["EXECUTION_ADMINISTRATOR"], tier: "ADMIN", twoFactorEnabled: true });
  const override = { reason: "Urgent documented business recovery", scope: { planId: PLAN_ID }, controlsBypassed: ["APPROVAL_THRESHOLD"] };
  await assert.rejects(authorizeEmergencyOverride({ actor: admin, override, executionConfig: { enabled: false }, policy: { emergencyOverrideAllowed: true }, auditWriter: {} }), (error) => error.code === "EXECUTION_DISABLED");
  await assert.rejects(authorizeEmergencyOverride({ actor: admin, override: { ...override, reason: "short" }, executionConfig: { enabled: true }, policy: { emergencyOverrideAllowed: true }, auditWriter: { writeImmutable: async () => {} } }), (error) => error.code === "APPROVAL_REASON_REQUIRED");
  let event;
  await authorizeEmergencyOverride({ actor: admin, override, executionConfig: { enabled: true }, policy: { emergencyOverrideAllowed: true }, auditWriter: { writeImmutable: async (value) => { event = value; } } });
  assert.equal(event.reason, override.reason);
  assert.deepEqual(event.controlsBypassed, override.controlsBypassed);
});

test("operation happy path requires a verification stage", () => {
  let operation = { id: "op-1", state: "PENDING" };
  for (const state of ["VALIDATED", "READY", "EXECUTING", "SUCCEEDED", "VERIFYING", "VERIFIED"]) operation = transitionOperation(operation, state);
  assert.equal(operation.state, "VERIFIED");
  expectCode("INVALID_OPERATION_TRANSITION", () => transitionOperation({ state: "SUCCEEDED" }, "VERIFIED"));
});

test("UNKNOWN must verify and cannot be blindly retried", () => {
  const unknown = transitionOperation({ state: "EXECUTING" }, "UNKNOWN");
  expectCode("OPERATION_OUTCOME_UNKNOWN", () => scheduleRetry(unknown, { retryable: true, safe: true }));
  assert.equal(transitionOperation(unknown, "VERIFYING").state, "VERIFYING");
});

test("unsafe FAILED operation cannot be retried but an explicitly safe retry can", () => {
  const failed = { state: "FAILED" };
  expectCode("OPERATION_RETRY_NOT_SAFE", () => scheduleRetry(failed, { retryable: true, safe: false }));
  assert.equal(scheduleRetry(failed, { retryable: true, safe: true }).state, "RETRY_SCHEDULED");
});

test("DRIFTED remains distinct from FAILED", () => {
  assert.equal(transitionOperation({ state: "VERIFYING" }, "DRIFTED").state, "DRIFTED");
  expectCode("INVALID_OPERATION_TRANSITION", () => transitionOperation({ state: "DRIFTED" }, "FAILED"));
});

test("plan outcome retains individual operation detail and distinguishes partial success", () => {
  const operations = [{ id: "one", state: "VERIFIED", providerResultId: "safe-id" }, { id: "two", state: "FAILED", errorCode: "RATE_LIMIT" }];
  const outcome = derivePlanOutcome(operations);
  assert.equal(outcome.planState, "PARTIAL_SUCCESS");
  assert.deepEqual(outcome.operations, operations);
  assert.notEqual(outcome.planState, "SUCCEEDED");
});

test("UNKNOWN, FAILED and DRIFTED never produce a global success", () => {
  assert.equal(derivePlanOutcome([{ state: "UNKNOWN" }]).planState, "EXECUTING");
  assert.equal(derivePlanOutcome([{ state: "FAILED" }]).planState, "FAILED");
  assert.equal(derivePlanOutcome([{ state: "DRIFTED" }]).planState, "FAILED");
});

test("provider and account failures are isolated from unrelated contexts", async () => {
  const service = createExecutionService({ env: {} });
  const contexts = [{ provider: "META", accountId: "bad" }, { provider: "X", accountId: "good" }];
  const results = await service.runIsolatedContexts(contexts, async (context) => {
    if (context.accountId === "bad") throw new Error("isolated");
    return "ok";
  });
  assert.equal(results[0].status, "REJECTED");
  assert.equal(results[1].status, "FULFILLED");
  assert.equal(results[1].value, "ok");
});

test("preflight returns a stable execution-disabled error and never calls an adapter", () => {
  expectCode("EXECUTION_DISABLED", () => createExecutionService({ env: {} }).preflight(baseIntent));
});
