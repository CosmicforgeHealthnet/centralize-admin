const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PrismaClient } = require("../src/generated/admin-client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { replayVerify, dropDatabase } = require("../scripts/social-operations/db-replay-verify");
const { PolicyRepository } = require("../src/modules/marketing/advertising-execution/policy/policy.repository");
const { PlanRepository } = require("../src/modules/marketing/advertising-execution/plans/plan.repository");
const { createAuditAdapter } = require("../src/modules/marketing/advertising-execution/integrations/audit.adapter");
const { createAdvertisingExecutionApplication } = require("../src/modules/marketing/advertising-execution/application");
const { createExecutionService } = require("../src/modules/marketing/advertising-execution/execution.service");
const { createExecutionQueueService } = require("../src/modules/marketing/advertising-execution/jobs/execution-queue.service");
const { createRetryReviewService } = require("../src/modules/marketing/advertising-execution/operations/retry-review.service");
const { ExecutionJobRepository } = require("../src/modules/marketing/advertising-execution/jobs/execution-job.repository");

const BASE_DATABASE_URL = process.env.DATABASE_URL;
const AUTHOR = "c0000000-0000-4000-8000-000000000001";
const APPROVER = "c0000000-0000-4000-8000-000000000002";
const CONNECTION = "d0000000-0000-4000-8000-000000000001";
const FP = "a".repeat(64);
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

async function seed(client) {
  await client.adminUser.createMany({ data: [
    { id: AUTHOR, email: "section25-author@example.invalid", password: "test-only", name: "Author", tier: "SUPER", status: "ACTIVE", mustChangePassword: false },
    { id: APPROVER, email: "section25-approver@example.invalid", password: "test-only", name: "Approver", tier: "SUPER", status: "ACTIVE", mustChangePassword: false },
  ] });
  await client.marketing_ad_platform_connections.create({ data: { id: CONNECTION, platform: "META", accountId: "act_section25", accessToken: "test-envelope", currency: "USD", status: "ACTIVE" } });
  const plan = await client.marketingExecutionPlan.create({ data: { planNumber: "S25-PLAN", sourceType: "MANUAL", platform: "META", connectionId: CONNECTION, accountExternalId: "act_section25", name: "Section 25 plan", status: "DRAFT", version: 1, currencyCode: "USD", desiredState: { approvalPolicy: { requiredApprovals: 1 } }, createdByAdminUserId: AUTHOR, updatedByAdminUserId: AUTHOR } });
  const item = await client.marketingExecutionPlanItem.create({ data: { planId: plan.id, sequence: 0, operationType: "UPDATE", resourceType: "CAMPAIGN", providerResourceId: "campaign-25", clientReference: "item-25", dependsOnItemIds: [], intent: { status: "PAUSED" }, beforeState: { status: "ACTIVE" }, materialHash: sha("item-25") } });
  const run = await client.marketingExecutionRun.create({ data: { planId: plan.id, submissionKey: sha("run-25"), status: "QUEUED", trigger: "MANUAL", approvalFingerprint: FP, approvedPlanVersion: 1 } });
  const operation = await client.marketingProviderOperation.create({ data: { runId: run.id, itemId: item.id, providerOperationKey: sha("operation-25"), status: "FAILED", safeToRetry: true, outcomeCertainty: "KNOWN_FAILURE", idempotencyIdentity: { version: 2, planId: plan.id, itemId: item.id } } });
  const reconciliation = await client.marketingExecutionReconciliation.create({ data: { runId: run.id, operationId: operation.id, status: "DRIFTED", differences: [{ fieldPath: "status", expected: "PAUSED", actual: "ACTIVE" }], checkedAt: new Date() } });
  return { plan, item, run, operation, reconciliation };
}

async function seedQualifiedPlan(client, label) {
  const fingerprint = sha(`fp:${label}`); const expiresAt = new Date(Date.now() + 600000);
  const plan = await client.marketingExecutionPlan.create({ data: { planNumber: `S25-${label}`.slice(0, 50), sourceType: "MANUAL", platform: "META", connectionId: CONNECTION, accountExternalId: "act_section25", name: label, status: "APPROVED", version: 1, currencyCode: "USD", desiredState: { approvalPolicy: { requiredApprovals: 1, requiredTier: "ADMIN" } }, validationFingerprint: fingerprint, validatedAt: new Date(), expiresAt, createdByAdminUserId: AUTHOR, updatedByAdminUserId: AUTHOR } });
  await client.marketingExecutionPlanItem.create({ data: { planId: plan.id, sequence: 0, operationType: "UPDATE", resourceType: "CAMPAIGN", providerResourceId: `campaign-${label}`, clientReference: "item-1", dependsOnItemIds: [], intent: { status: "PAUSED" }, beforeState: { status: "ACTIVE" }, materialHash: sha(`item:${label}`) } });
  await client.marketingExecutionValidationPacket.create({ data: { planId: plan.id, planVersion: 1, validationFingerprint: fingerprint, valid: true, beforeStateSummary: { status: "ACTIVE" }, capabilitySummary: { write: true }, budgetExposure: "0", activationExposure: false, expiresAt, validatedByAdminUserId: AUTHOR } });
  await client.marketingExecutionApproval.create({ data: { planId: plan.id, planVersion: 1, validationFingerprint: fingerprint, decision: "APPROVED", approverAdminUserId: APPROVER, approvalScope: { provider: "META", connectionId: CONNECTION, currencyCode: "USD", approverTier: "SUPER" }, decidedAt: new Date() } });
  return { plan, fingerprint };
}

test("Sections 25-28 evidence and concurrency rules use disposable PostgreSQL", { timeout: 240000 }, async (t) => {
  assert.ok(BASE_DATABASE_URL, "DATABASE_URL is required");
  const replay = await replayVerify({ keep: true });
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: replay.replayUrl }) });
  await client.$connect();
  try {
    const seeded = await seed(client);
    await t.test("policy updates are optimistic and preserve immutable version history", async () => {
      const repository = new PolicyRepository({ client });
      const policy = await repository.create({ scope: "CONNECTION", platform: "META", connectionId: CONNECTION, key: "execution.write.enabled", valueType: "BOOLEAN", value: false, actorId: AUTHOR });
      const updated = await repository.update({ id: policy.id, expectedVersion: 1, actorId: AUTHOR, valueType: "BOOLEAN", value: false, enabled: false, reason: "Keep writes disabled during Section 25 validation", changedFields: [] });
      assert.equal(updated.version, 2);
      assert.equal(await client.marketingExecutionPolicyHistory.count({ where: { policyId: policy.id } }), 2);
      const timeline = await client.marketingExecutionPolicyHistory.findMany({ where: { policyId: policy.id }, orderBy: { version: "asc" } });
      assert.equal(timeline[0].previousVersion, null); assert.equal(timeline[0].newVersion, 1);
      assert.equal(timeline[1].previousVersion, 1); assert.equal(timeline[1].newVersion, 2);
      await assert.rejects(repository.update({ id: policy.id, expectedVersion: 1, actorId: AUTHOR, valueType: "BOOLEAN", value: true, enabled: true, reason: "stale", changedFields: ["value"] }), (error) => error.code === "PLAN_VERSION_CONFLICT");
      const history = await client.marketingExecutionPolicyHistory.findFirst({ where: { policyId: policy.id } });
      await assert.rejects(client.marketingExecutionPolicyHistory.update({ where: { id: history.id }, data: { reason: "rewrite" } }), /append-only/);
      await assert.rejects(client.marketingExecutionPolicyHistory.delete({ where: { id: history.id } }), /append-only/);
    });

    await t.test("validation packets and approval evidence are append-only", async () => {
      const repository = new PlanRepository({ client });
      const packet = await repository.persistValidationPacket({ plan: seeded.plan, actorId: AUTHOR, packet: { fingerprint: FP, valid: true, providerApiVersion: "v25.0", beforeStateHash: sha("before"), beforeStateSummary: { status: "ACTIVE" }, capabilitySummary: { write: false }, budgetExposure: "25.00", activationExposure: false, expiresAt: new Date(Date.now() + 600000) }, issues: [] });
      assert.equal(packet.valid, true);
      await assert.rejects(client.marketingExecutionValidationPacket.update({ where: { id: packet.id }, data: { valid: false } }), /append-only/);
      const approval = await client.marketingExecutionApproval.create({ data: { planId: seeded.plan.id, planVersion: 1, validationFingerprint: FP, decision: "APPROVED", approverAdminUserId: APPROVER, approvalScope: { provider: "META" }, decidedAt: new Date() } });
      await assert.rejects(client.marketingExecutionApproval.update({ where: { id: approval.id }, data: { decision: "REJECTED" } }), /append-only/);
      await client.marketingExecutionApprovalEvent.create({ data: { approvalId: approval.id, decision: "REVOKED", reason: "Approval withdrawn before execution", decidedAt: new Date() } });
      assert.equal(await client.marketingExecutionApprovalEvent.count({ where: { approvalId: approval.id } }), 1);
    });

    await t.test("drift acknowledgment appends evidence without resolving or rewriting drift", async () => {
      const acknowledgment = await client.marketingExecutionDriftAcknowledgment.create({ data: { reconciliationId: seeded.reconciliation.id, acknowledgedByAdminUserId: AUTHOR, reason: "Operations team is reviewing the external change" } });
      assert.equal((await client.marketingExecutionReconciliation.findUnique({ where: { id: seeded.reconciliation.id } })).status, "DRIFTED");
      await assert.rejects(client.marketingExecutionDriftAcknowledgment.update({ where: { id: acknowledgment.id }, data: { reason: "rewrite" } }), /append-only/);
    });

    await t.test("retry-review idempotency and immutable review evidence are database-enforced", async () => {
      const key = sha("retry-review-25");
      const review = await client.marketingExecutionRetryReview.create({ data: { operationId: seeded.operation.id, reviewedByAdminUserId: APPROVER, reason: "Transient failure is known and safe to retry", decision: "RETRY_SCHEDULED", idempotencyKey: key } });
      await assert.rejects(client.marketingExecutionRetryReview.create({ data: { operationId: seeded.operation.id, reviewedByAdminUserId: APPROVER, reason: "duplicate", decision: "RETRY_SCHEDULED", idempotencyKey: key } }), (error) => error.code === "P2002");
      await assert.rejects(client.marketingExecutionRetryReview.delete({ where: { id: review.id } }), /append-only/);
      await assert.rejects(client.marketingExecutionRetryReview.create({ data: { operationId: seeded.operation.id, reviewedByAdminUserId: APPROVER, reason: "invalid action job", decision: "RETRY_SCHEDULED", idempotencyKey: sha("invalid-job"), actionJobId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } }), (error) => error.code === "P2003");
    });

    await t.test("new audit actions persist only sanitized metadata", async () => {
      const audit = createAuditAdapter({ client });
      const row = await audit.event({ actorId: AUTHOR, action: "EXECUTION_PLAN_UPDATED", targetId: seeded.plan.id, targetType: "marketing_execution_plan", metadata: { changedFields: ["name"], accessToken: "never-store" } });
      assert.equal(JSON.stringify(row.metadata).includes("never-store"), false);
      await assert.rejects(client.auditLog.update({ where: { id: row.id }, data: { targetType: "rewritten" } }), /append-only/);
      await assert.rejects(client.auditLog.delete({ where: { id: row.id } }), /append-only/);
    });

    await t.test("queue is atomic under injected failure and idempotent under concurrency", async () => {
      const actor = { id: AUTHOR, tier: "SUPER" }; const evidence = { capabilityValid: true, globalEnabled: true, providerEnabled: true, connectionWriteEnabled: true };
      const failed = await seedQualifiedPlan(client, "QUEUE-FAILURE");
      const before = { runs: await client.marketingExecutionRun.count({ where: { planId: failed.plan.id } }), audits: await client.auditLog.count({ where: { action: "EXECUTION_QUEUED" } }) };
      const failing = createExecutionQueueService({ client, failureInjector: async (point) => { if (point === "after-job") throw new Error("INJECTED_QUEUE_FAILURE"); } });
      await assert.rejects(failing.queue({ actor, planId: failed.plan.id, expectedVersion: 1, fingerprint: failed.fingerprint, policyEvidence: evidence }), /INJECTED_QUEUE_FAILURE/);
      assert.equal(await client.marketingExecutionRun.count({ where: { planId: failed.plan.id } }), before.runs);
      assert.equal(await client.marketingExecutionJob.count({ where: { run: { planId: failed.plan.id } } }), 0);
      assert.equal(await client.marketingProviderOperation.count({ where: { run: { planId: failed.plan.id } } }), 0);
      assert.equal(await client.auditLog.count({ where: { action: "EXECUTION_QUEUED" } }), before.audits);
      assert.equal((await client.marketingExecutionPlan.findUnique({ where: { id: failed.plan.id } })).status, "APPROVED");

      const concurrent = await seedQualifiedPlan(client, "QUEUE-CONCURRENT"); const queue = createExecutionQueueService({ client });
      const results = await Promise.all([1, 2, 3].map(() => queue.queue({ actor, planId: concurrent.plan.id, expectedVersion: 1, fingerprint: concurrent.fingerprint, policyEvidence: evidence })));
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(await client.marketingExecutionRun.count({ where: { planId: concurrent.plan.id } }), 1);
      assert.equal(await client.marketingExecutionJob.count({ where: { run: { planId: concurrent.plan.id } } }), 1);
      assert.equal(await client.marketingProviderOperation.count({ where: { run: { planId: concurrent.plan.id } } }), 1);
    });

    await t.test("reviewed retry revalidates state and creates job, review, state and audit atomically", async () => {
      const qualified = await seedQualifiedPlan(client, "RETRY-ATOMIC"); const queue = createExecutionQueueService({ client });
      const queued = await queue.queue({ actor: { id: AUTHOR, tier: "SUPER" }, planId: qualified.plan.id, expectedVersion: 1, fingerprint: qualified.fingerprint, policyEvidence: { capabilityValid: true, globalEnabled: true, providerEnabled: true, connectionWriteEnabled: true } });
      const operation = await client.marketingProviderOperation.findFirst({ where: { runId: queued.run.id } });
      await client.marketingProviderOperation.update({ where: { id: operation.id }, data: { status: "FAILED", safeToRetry: true, outcomeCertainty: "KNOWN_FAILURE" } });
      await client.marketingProviderOperationAttempt.create({ data: { operationId: operation.id, number: 1, errorCode: "TEMPORARY", errorCategory: "TRANSIENT", normalizedError: { providerProcessing: "NOT_STARTED" }, completedAt: new Date() } });
      const env = { MARKETING_AD_EXECUTION_ENABLED: "true", MARKETING_AD_EXECUTION_DRY_RUN: "false", MARKETING_AD_EXECUTION_WORKER_ENABLED: "true", MARKETING_AD_EXECUTION_META_ENABLED: "true", MARKETING_AD_EXECUTION_META_API_VERSION: "v25.0" };
      const shared = { client, env, connectionPolicyResolver: async () => true, adapterRegistry: { get: () => ({ getCapabilities: () => ({ configurationReady: true, operationSupported: true, permissionReady: true }) }) }, providerReadRegistry: { resolve: () => ({ readResource: async () => ({ status: "ACTIVE" }) }) }, events: { emit: async () => {} }, metrics: { increment: () => {} } };
      const initialJobs = await client.marketingExecutionJob.count({ where: { runId: queued.run.id } });
      const failingRetry = createRetryReviewService({ ...shared, failureInjector: async (point) => { if (point === "after-retry-job") throw new Error("INJECTED_RETRY_FAILURE"); } });
      await assert.rejects(failingRetry.schedule({ operationId: operation.id, actor: { id: APPROVER }, reason: "Known transient failure before provider processing" }), /INJECTED_RETRY_FAILURE/);
      assert.equal(await client.marketingExecutionJob.count({ where: { runId: queued.run.id } }), initialJobs);
      assert.equal(await client.marketingExecutionRetryReview.count({ where: { operationId: operation.id } }), 0);
      assert.equal((await client.marketingProviderOperation.findUnique({ where: { id: operation.id } })).status, "FAILED");
      const retry = createRetryReviewService(shared);
      const first = await retry.schedule({ operationId: operation.id, actor: { id: APPROVER }, reason: "Known transient failure before provider processing" });
      const duplicate = await retry.schedule({ operationId: operation.id, actor: { id: APPROVER }, reason: "Known transient failure before provider processing" });
      assert.equal(first.created, true); assert.equal(duplicate.created, false); assert.equal(first.jobId, duplicate.jobId);
      const review = await client.marketingExecutionRetryReview.findUnique({ where: { id: first.reviewId } });
      assert.equal(review.actionJobId, first.jobId); assert.equal((await client.marketingProviderOperation.findUnique({ where: { id: operation.id } })).status, "RETRY_SCHEDULED");
      assert.equal(await client.auditLog.count({ where: { action: "EXECUTION_OPERATION_RETRY_REVIEWED", targetId: operation.id } }), 1);
    });

    await t.test("claimed cancellation is durable and only the lease owner can observe it", async () => {
      const qualified = await seedQualifiedPlan(client, "CANCEL-CLAIMED"); const queue = createExecutionQueueService({ client });
      const queued = await queue.queue({ actor: { id: AUTHOR, tier: "SUPER" }, planId: qualified.plan.id, expectedVersion: 1, fingerprint: qualified.fingerprint, policyEvidence: { capabilityValid: true, globalEnabled: true, providerEnabled: true, connectionWriteEnabled: true } });
      await client.marketingExecutionJob.update({ where: { id: queued.job.id }, data: { status: "CLAIMED", leaseOwner: "worker-owner", leaseExpiresAt: new Date(Date.now() + 60000) } });
      const application = createAdvertisingExecutionApplication({ client, env: {} }); const service = createExecutionService({ application, env: {} });
      const response = await service.cancelPlan({ actor: { id: AUTHOR, tier: "SUPER" }, id: qualified.plan.id, input: { expectedVersion: 1, reason: "Operator requested cancellation before provider mutation" } });
      assert.equal(response.cancellationStatus, "REQUESTED");
      const requested = await client.marketingExecutionJob.findUnique({ where: { id: queued.job.id } });
      assert.equal(requested.status, "CLAIMED"); assert.equal(requested.leaseOwner, "worker-owner"); assert.ok(requested.cancellationRequestedAt);
      const repository = new ExecutionJobRepository({ client });
      assert.equal(await repository.observeCancellationOwned({ id: queued.job.id, leaseOwner: "wrong-owner" }), null);
      assert.equal((await client.marketingExecutionJob.findUnique({ where: { id: queued.job.id } })).leaseOwner, "worker-owner");
      const observed = await repository.observeCancellationOwned({ id: queued.job.id, leaseOwner: "worker-owner" });
      assert.equal(observed.status, "CANCELLED"); assert.equal(observed.cancellationOutcome, "CANCELLED_BEFORE_PROVIDER_MUTATION");
    });

    await t.test("production service creates, lists, edits, submits, approves and fail-closed queues without provider calls", async () => {
      let providerCalls = 0;
      const application = createAdvertisingExecutionApplication({ client, env: {}, providerClients: { read: {}, write: {} }, httpClient: async () => { providerCalls += 1; throw new Error("provider transport must not run"); } });
      const service = createExecutionService({ application, env: {} });
      const author = { id: AUTHOR, tier: "SUPER", status: "ACTIVE", twoFactorEnabled: true };
      const approver = { id: APPROVER, tier: "SUPER", status: "ACTIVE", twoFactorEnabled: true };
      const created = await service.createPlan({ actor: author, input: { provider: "META", connectionId: CONNECTION, accountExternalId: "act_section25", currency: "USD", name: "API lifecycle", desiredState: { objective: "CONVERSIONS", approvalPolicy: { requiredApprovals: 1, requiredTier: "ADMIN" } }, items: [] } });
      assert.equal(created.status, "DRAFT");
      const listed = await service.listPlans({ provider: "META", search: "API lifecycle", page: "1", limit: "10" });
      assert.equal(listed.items.some((plan) => plan.id === created.id), true);
      const edited = await service.updatePlan({ actor: author, id: created.id, input: { expectedVersion: 1, name: "API lifecycle edited", desiredState: { objective: "CONVERSIONS", approvalPolicy: { requiredApprovals: 1, requiredTier: "ADMIN" } } } });
      assert.equal(edited.version, 2);
      await assert.rejects(
        service.updatePlan({ actor: author, id: created.id, input: { expectedVersion: 1, name: "stale edit" } }),
        (error) => error.code === "EXECUTION_PLAN_CONFLICT" && error.statusCode === 409,
      );
      const expiry = new Date(Date.now() + 600000);
      await client.marketingExecutionValidationPacket.create({ data: { planId: created.id, planVersion: 2, validationFingerprint: FP, valid: true, beforeStateSummary: {}, capabilitySummary: {}, budgetExposure: "0", activationExposure: false, expiresAt: expiry, validatedByAdminUserId: AUTHOR } });
      await client.marketingExecutionPlan.update({ where: { id: created.id }, data: { status: "VALIDATED", validationFingerprint: FP, validatedAt: new Date(), expiresAt: expiry } });
      const submitted = await service.submitPlan({ actor: author, id: created.id, input: { expectedVersion: 2, fingerprint: FP } });
      assert.equal(submitted.plan.status, "PENDING_APPROVAL");
      const decision = await service.approvePlan({ actor: approver, id: created.id, input: { expectedVersion: 2, fingerprint: FP, comment: "Reviewed exact validated packet" } });
      assert.equal(decision.planStatus, "APPROVED");
      await assert.rejects(service.queuePlan({ actor: author, planId: created.id, input: { expectedVersion: 2, fingerprint: FP } }), (error) => error.code === "AD_EXECUTION_DISABLED");
      assert.equal(providerCalls, 0);
      assert.equal((await service.health()).state, "disabled");
    });
  } finally {
    await client.$disconnect();
    await dropDatabase(BASE_DATABASE_URL, replay.databaseName);
  }
});
