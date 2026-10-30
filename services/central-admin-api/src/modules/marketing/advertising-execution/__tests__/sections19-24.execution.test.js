const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetingCriteria, FORBIDDEN_CATEGORIES } = require("../targeting/targeting.validator");
const { localDateTimeToUtc, validateSchedule } = require("../targeting/delivery-rules.validator");
const { createRecommendationExecutionBridge } = require("../recommendations/recommendation-execution-bridge.service");
const { ExecutionJobRepository } = require("../jobs/execution-job.repository");
const { createExecutionWorker } = require("../jobs/execution-worker");
const { createOperationRunner } = require("../operations/operation-runner.service");
const { operationIdentity, createProviderOperationKey, assertBeforeStateCurrent } = require("../operations/idempotency.service");
const { decideRetry } = require("../operations/retry-policy.service");
const { LAYERS, runValidationPipeline } = require("../validation/execution-validation-pipeline");
const { compareMaterialState, classifyReconciliation } = require("../reconciliation/reconciliation.service");
const { createFinalMutationGate } = require("../validation/final-mutation-gate.service");
const { hashExecutionJson } = require("../execution-json.validator");
const { mapRun } = require("../execution.response");

const CONNECTION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("typed targeting resolves account-scoped native IDs and preserves location, keyword, placement semantics", async () => {
  const input = [
    { clientReference: "loc", type: "LOCATION", query: "Rome", locationType: "RADIUS", radius: { value: 20, unit: "KM", latitude: 41.9, longitude: 12.5 }, excluded: false },
    { clientReference: "kw", type: "KEYWORD", value: "private care", matchType: "PHRASE", negative: true, scope: "GROUP", excluded: false },
    { clientReference: "place", type: "PLACEMENT", placement: "facebook_feed", mode: "MANUAL", device: "MOBILE", excluded: false },
  ];
  const resolved = await resolveTargetingCriteria(input, { provider: "META", apiVersion: "v25.0", connectionId: CONNECTION, accountExternalId: "act_1", accountPlacementAllowlist: ["FACEBOOK_FEED"], placementMode: "MANUAL", resolver: async () => ({ normalizedId: "location:rome", nativeId: "1021865", displayName: "Rome" }) });
  assert.equal(resolved[0].nativeId, "1021865"); assert.equal(resolved[1].scope, "GROUP"); assert.equal(resolved[2].device, "MOBILE");
});

test("all regulated and sensitive advertising categories fail closed from server policy", async () => {
  assert.deepEqual([...FORBIDDEN_CATEGORIES].sort(), ["CREDIT", "CRM_CUSTOMER_LIST", "CUSTOM_AUDIENCE_PII", "DATA_BROKER", "EMPLOYMENT", "HEALTHCARE", "HOUSING", "POLITICAL", "PROTECTED_CHARACTERISTIC", "SENSITIVE_TRAIT"].sort());
  for (const advertisingCategory of FORBIDDEN_CATEGORIES) await assert.rejects(resolveTargetingCriteria([], { provider: "META", advertisingCategory }), (error) => error.errors[0].reasonCode === "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN");
});

test("targeting detects include/exclude and positive/negative conflicts without rewriting", async () => {
  const keywords = [{ clientReference: "a", type: "KEYWORD", value: "Care", matchType: "EXACT", negative: false, scope: "CAMPAIGN", excluded: false }, { clientReference: "b", type: "KEYWORD", value: "care", matchType: "EXACT", negative: true, scope: "CAMPAIGN", excluded: false }];
  await assert.rejects(resolveTargetingCriteria(keywords, { provider: "GOOGLE_ADS" }), (error) => error.errors[0].reasonCode === "TARGETING_INCLUDE_EXCLUDE_CONFLICT");
});

test("timezone normalization handles Europe and US DST gaps and overlaps explicitly", () => {
  assert.throws(() => localDateTimeToUtc("2026-03-29T02:30:00", "Europe/Rome", "REJECT"), (error) => error.errors[0].reasonCode === "NONEXISTENT_LOCAL_TIME");
  const euEarly = localDateTimeToUtc("2026-10-25T02:30:00", "Europe/Rome", "EARLIER"); const euLate = localDateTimeToUtc("2026-10-25T02:30:00", "Europe/Rome", "LATER");
  assert.equal(euLate - euEarly, 3600000);
  assert.throws(() => localDateTimeToUtc("2026-03-08T02:30:00", "America/New_York", "REJECT"), (error) => error.errors[0].reasonCode === "NONEXISTENT_LOCAL_TIME");
  const usEarly = localDateTimeToUtc("2026-11-01T01:30:00", "America/New_York", "EARLIER"); const usLate = localDateTimeToUtc("2026-11-01T01:30:00", "America/New_York", "LATER");
  assert.equal(usLate - usEarly, 3600000);
  const normalized = validateSchedule({ originalLocalStart: "2026-10-25T02:30:00", originalLocalEnd: "2026-10-25T04:30:00", accountTimezone: "Europe/Rome", dstDisambiguation: "LATER", minimumLeadMinutes: 0, maximumDurationDays: 2 }, { now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(normalized.storedTimezone, "UTC"); assert.equal(normalized.originalLocalStart, "2026-10-25T02:30:00");
});

test("accepted recommendation conversion is concurrency-idempotent and audit-compatible", async () => {
  const recommendation = { id: "rec-1", status: "ACCEPTED", platform: "META", connectionId: CONNECTION, evidence: {}, suggestedAction: { type: "PAUSE" }, reasoning: "CPA increased", confidence: "0.9", connection: { id: CONNECTION, accountId: "act_1", currency: "USD", status: "ACTIVE", requiresReauthorization: false } };
  let existing = null; const audits = [];
  const client = { marketingExecutionPlan: { findFirst: async () => existing }, marketing_recommendations: { findUnique: async () => recommendation } };
  const bridge = createRecommendationExecutionBridge({ client, planRepository: { create: async (input) => { existing = { id: "plan-1", status: "DRAFT", ...input }; return existing; } }, capabilityResolver: async () => ({ operationSupported: true }), liveStateResolver: async () => ({ status: "ACTIVE" }), audit: { event: async (event) => audits.push(event) } });
  const first = await bridge.createDraft({ recommendationId: "rec-1", actor: { id: "admin-1" } }); const second = await bridge.createDraft({ recommendationId: "rec-1", actor: { id: "admin-1" } });
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(audits[0].targetType, "marketing_execution_plan");
});

test("claim SQL directly qualifies exact plan version, fingerprint, expiry, approvals and account scope", async () => {
  let sql; const client = { $transaction: (callback) => callback({ $queryRaw: async (query) => { sql = query.strings.join(" "); return []; } }) };
  await new ExecutionJobRepository({ client, now: () => new Date("2026-07-22T10:00:00Z") }).claimEligibleApproved({ leaseOwner: "worker-1", enabledProviders: ["META"] });
  for (const pattern of [/FOR UPDATE OF job SKIP LOCKED/, /approved_plan_version = plan\.version/, /approval_fingerprint = plan\.validation_fingerprint/, /plan\.expires_at/, /approver_admin_user_id <> plan\.created_by_admin_user_id/, /active\.account_external_id = job\.account_external_id/]) assert.match(sql, pattern);
});

test("worker dry-run blocks before claim and enabled lifecycle owns account lock and job lease", async () => {
  let claims = 0;
  const disabled = createExecutionWorker({ env: { MARKETING_AD_EXECUTION_ENABLED: "true", MARKETING_AD_EXECUTION_DRY_RUN: "true", MARKETING_AD_EXECUTION_WORKER_ENABLED: "true", MARKETING_AD_EXECUTION_META_ENABLED: "true", MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" }, jobRepository: { claimEligibleApproved: async () => { claims += 1; } } });
  await assert.rejects(disabled.processNext(), (error) => error.errors[0].reasonCode === "DRY_RUN_BLOCKS_PROVIDER_MUTATION"); assert.equal(claims, 0);
  const calls = []; const env = { MARKETING_AD_EXECUTION_ENABLED: "true", MARKETING_AD_EXECUTION_DRY_RUN: "false", MARKETING_AD_EXECUTION_WORKER_ENABLED: "true", MARKETING_AD_EXECUTION_META_ENABLED: "true", MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" };
  const jobRepository = { recoverExpiredLeases: async () => [], claimEligibleApproved: async () => [{ id: "job-1", connectionId: CONNECTION, platform: "META", accountExternalId: "act_1" }], markRunningOwned: async () => calls.push("running"), loadExecutionBundle: async () => ({ id: "job-1", connectionId: CONNECTION, platform: "META", accountExternalId: "act_1" }), heartbeatOwned: async () => calls.push("heartbeat"), completeOwned: async ({ status }) => calls.push(status) };
  const accountLockRepository = { acquire: async () => ({ key: "META:scope" }), heartbeat: async () => calls.push("lock-heartbeat"), release: async () => calls.push("lock-release") };
  const worker = createExecutionWorker({ env, jobRepository, accountLockRepository, connectionGate: async () => true, executeBundle: async ({ heartbeat }) => { await heartbeat(); return { status: "SUCCEEDED" }; } });
  assert.equal((await worker.processNext({ leaseOwner: "worker-1" })).status, "SUCCEEDED"); assert.deepEqual(calls, ["running", "lock-heartbeat", "heartbeat", "SUCCEEDED", "lock-release"]); assert.equal(worker.isStarted(), false);
});

test("typed canonical idempotency cannot collide through delimiter ambiguity", () => {
  const base = { version: 2, provider: "META", connectionId: CONNECTION, accountExternalId: "act:1", approvedPlanId: "11111111-1111-4111-8111-111111111111", approvedPlanVersion: 2, itemId: "22222222-2222-4222-8222-222222222222", operationType: "UPDATE", resourceType: "CAMPAIGN", materialHash: "a".repeat(64) };
  const identity = operationIdentity(base); assert.match(createProviderOperationKey(identity), /^[a-f0-9]{64}$/); assert.notEqual(createProviderOperationKey(identity), createProviderOperationKey({ ...identity, accountExternalId: "act", approvedPlanId: "1:1111111-1111-4111-8111-111111111111" }));
});

test("retry telemetry never mutation-retries UNKNOWN, policy, stale precondition, or known provider success", () => {
  assert.equal(decideRetry({ category: "RATE_LIMIT", providerProcessing: "NOT_STARTED", outcomeCertain: true, attempt: 1, quotaResetAt: "2026-07-22T10:01:00Z" }).automaticRetry, true);
  assert.equal(decideRetry({ providerProcessing: "UNKNOWN", outcomeCertain: false }).action, "RECONCILE_BEFORE_RETRY");
  assert.equal(decideRetry({ localPersistenceFailed: true, outcomeCertain: true }).action, "RECONCILE_LOCAL_PERSISTENCE");
  assert.equal(decideRetry({ category: "POLICY", providerProcessing: "NOT_STARTED", outcomeCertain: true }).automaticRetry, false);
  assert.equal(decideRetry({ preconditionFresh: false }).action, "REVALIDATE_AND_REAPPROVE");
});

test("operation runner persists attempt before fake provider call and routes success to read-back", async () => {
  const order = []; const item = { id: "22222222-2222-4222-8222-222222222222", sequence: 0, operationType: "CREATE", resourceType: "CAMPAIGN", materialHash: "a".repeat(64), intent: {}, dependsOnItemIds: [] };
  const identity = operationIdentity({ version: 2, provider: "META", connectionId: CONNECTION, accountExternalId: "act_1", approvedPlanId: "11111111-1111-4111-8111-111111111111", approvedPlanVersion: 1, itemId: item.id, operationType: "CREATE", resourceType: "CAMPAIGN", materialHash: item.materialHash });
  const operation = { id: "op-1", itemId: item.id, providerOperationKey: createProviderOperationKey(identity), status: "READY", attempts: [], item, snapshots: [{ kind: "BEFORE", sequence: 1, hash: hashExecutionJson({ exists: false }, "beforeState").hash }] };
  const repository = { createAttempt: async () => { order.push("attempt"); return { id: "attempt-1" }; }, completeAttempt: async () => order.push("attempt-complete"), persistResult: async () => order.push("result") };
  const reconciliation = { enqueue: async ({ reason }) => order.push(reason) };
  const runner = createOperationRunner({ operationRepository: repository, providerReadRegistry: { resolve: () => ({ readResource: async () => { order.push("read"); return { exists: false }; } }) }, finalMutationGate: { assert: async () => ({ globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true }) }, adapterResolver: async () => ({ executeOperation: async () => { order.push("provider"); return { status: "SUCCEEDED", outcomeCertain: true, providerRequestId: "req", nativeResourceId: "1", returnedState: {}, warnings: [], error: null }; } }), reconciliationRepository: reconciliation });
  const bundle = { id: "job-1", run: { id: "run-1", approvedPlanVersion: 1, plan: { id: identity.approvedPlanId, version: 1, sourceType: "MANUAL", platform: "META", connectionId: CONNECTION, accountExternalId: "act_1" }, operations: [operation] } };
  assert.equal((await runner.run({ bundle, leaseOwner: "worker", lockKey: "lock" })).status, "SUCCEEDED"); assert.deepEqual(order, ["read", "attempt", "provider", "attempt-complete", "result", "POST_WRITE_VERIFICATION"]);
});

test("before-state hash mismatch blocks provider mutation", () => assert.throws(() => assertBeforeStateCurrent({ approvedHash: "b".repeat(64), currentState: { status: "ACTIVE" } }), (error) => error.code === "EXECUTION_PRECONDITION_CHANGED"));

test("seven-layer validation remains ordered and missing concrete layers fail closed", async () => {
  const order = []; const validators = Object.fromEntries(LAYERS.map((layer) => [layer, async (value) => { order.push(layer); return { value, issues: [] }; }]));
  await runValidationPipeline({}, validators); assert.deepEqual(order, LAYERS); await assert.rejects(runValidationPipeline({}, { transport: validators.transport }, { through: "domain" }), (error) => error.errors[0].reasonCode === "VALIDATION_LAYER_UNAVAILABLE");
});

test("final mutation gate checks dry-run before any provider write", async () => {
  const gate = createFinalMutationGate({ env: { MARKETING_AD_EXECUTION_ENABLED: "true", MARKETING_AD_EXECUTION_DRY_RUN: "true", MARKETING_AD_EXECUTION_WORKER_ENABLED: "true", MARKETING_AD_EXECUTION_META_ENABLED: "true", MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" } });
  await assert.rejects(gate.assert({ bundle: { run: { plan: { platform: "META" } } } }), (error) => error.errors[0].reasonCode === "DRY_RUN_BLOCKS_PROVIDER_MUTATION");
});

test("resource comparator normalizes decimals, URLs and unordered collections", () => {
  assert.deepEqual(compareMaterialState({ budget: "10.00", tags: ["b", "a"], url: "https://x.example/a?b=2&a=1" }, { budget: "10", tags: ["a", "b"], url: "https://x.example/a?a=1&b=2" }), []);
  assert.equal(classifyReconciliation({ desired: { status: "PAUSED" }, current: { status: "PAUSED" } }).status, "VERIFIED"); assert.equal(classifyReconciliation({ desired: { status: "PAUSED" }, current: null }).status, "UNKNOWN"); assert.equal(classifyReconciliation({ desired: { status: "PAUSED" }, current: { status: "ACTIVE" }, previousVerifiedHash: "a".repeat(64) }).status, "EXTERNAL_CHANGE");
});

test("public run mapper allowlists state and excludes lease, idempotency, and raw provider fields", () => {
  const mapped = mapRun({
    id: "run-1", planId: "plan-1", status: "RUNNING", trigger: "MANUAL", approvedPlanVersion: 1,
    summary: { ok: true, rawProviderResponse: "forbidden" },
    jobs: [{ id: "job-1", runId: "run-1", platform: "META", connectionId: CONNECTION, accountExternalId: "act_1", status: "RUNNING", attemptCount: 1, leaseOwner: "private-worker", submissionIdentity: "secret-identity" }],
    operations: [{ id: "op-1", itemId: "item-1", status: "UNKNOWN", outcomeCertainty: "UNKNOWN", idempotencyIdentity: { private: true }, normalizedResult: { status: "UNKNOWN", rawPayload: "forbidden" } }],
    reconciliations: [], reconciliationJobs: [],
  });
  const serialized = JSON.stringify(mapped);
  assert.equal(serialized.includes("private-worker"), false);
  assert.equal(serialized.includes("secret-identity"), false);
  assert.equal(serialized.includes("idempotencyIdentity"), false);
  assert.equal(serialized.includes("forbidden"), false);
});
