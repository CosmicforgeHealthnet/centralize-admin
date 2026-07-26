const { readExecutionConfig } = require("../execution.config");
const { executionError } = require("../execution.errors");
const { assertApprovalIntegrity } = require("./approval-integrity.service");

function createFinalMutationGate({ env = process.env, connectionPolicyResolver, accountLockRepository, jobRepository } = {}) {
  async function assert(input) {
    const config = readExecutionConfig(env); const { bundle, operation, leaseOwner, lockKey, idempotencyKey } = input;
    const plan = bundle.run.plan; const run = bundle.run;
    if (!config.enabled) throw executionError("EXECUTION_DISABLED", { reasonCode: "GLOBAL_EXECUTION_DISABLED" });
    if (config.dryRun) throw executionError("EXECUTION_DISABLED", { reasonCode: "DRY_RUN_BLOCKS_PROVIDER_MUTATION" });
    if (!config.workerEnabled) throw executionError("EXECUTION_DISABLED", { reasonCode: "WORKER_DISABLED" });
    if (!config.providers[plan.platform]) throw executionError("EXECUTION_DISABLED", { reasonCode: "PROVIDER_EXECUTION_DISABLED" });
    const connectionWriteEnabled = await connectionPolicyResolver({ platform: plan.platform, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId });
    if (!connectionWriteEnabled) throw executionError("EXECUTION_DISABLED", { reasonCode: "CONNECTION_WRITE_GATE_DISABLED" });
    assertApprovalIntegrity({ plan, run, approvals: plan.approvals });
    if (input.businessPolicyValid !== true || input.capabilityValid !== true || input.currencyValid !== true || input.budgetValid !== true || input.scheduleValid !== true || input.creativeReviewValid !== true || input.targetingValid !== true || input.beforeStateValid !== true) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "FINAL_MUTATION_POLICY_OR_PRECONDITION_FAILED" });
    if (!idempotencyKey || idempotencyKey !== operation.providerOperationKey) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "OPERATION_IDEMPOTENCY_IDENTITY_MISMATCH" });
    if (!await accountLockRepository.isOwned({ key: lockKey, owner: leaseOwner })) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "ACCOUNT_LOCK_NOT_OWNED" });
    const ownedJob = await jobRepository.client.marketingExecutionJob.findFirst({ where: { id: bundle.id, leaseOwner, status: "RUNNING", leaseExpiresAt: { gt: new Date() } }, select: { id: true } });
    if (!ownedJob) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "JOB_LEASE_NOT_OWNED" });
    return Object.freeze({ globalEnabled: true, dryRun: false, workerEnabled: true, providerEnabled: true, connectionWriteEnabled: true, permissionReady: true, approvalFingerprintCurrent: true, planVersionCurrent: true, preconditionsCurrent: true, accountLockOwned: true, jobLeaseOwned: true, idempotencyIdentityValid: true });
  }
  return Object.freeze({ assert });
}
module.exports = { createFinalMutationGate };
