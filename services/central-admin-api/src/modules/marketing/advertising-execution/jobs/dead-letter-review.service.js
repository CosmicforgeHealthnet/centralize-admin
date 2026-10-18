const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");

function createDeadLetterReviewService({ client = prisma, jobRepository, reconciliationRepository, reconciliationService, audit, events } = {}) {
  async function review({ jobId, actor, decision, reason, compensation }) {
    if (!actor?.id || !["ADMIN", "SUPER"].includes(actor.tier) || !String(reason || "").trim()) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "ELEVATED_DEAD_LETTER_REVIEW_REQUIRED" });
    const job = await client.marketingExecutionJob.findUnique({ where: { id: jobId }, include: { deadLetterReview: true, run: { include: { plan: true, operations: true } } } });
    if (!job || job.status !== "DEAD_LETTER" || job.deadLetterReview?.status === "REVIEWED") throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "UNREVIEWED_DEAD_LETTER_REQUIRED" });
    let actionJob = null; let compensationPlan = null;
    if (decision === "CREATE_RETRY_JOB") actionJob = await jobRepository.create({ runId: job.runId, connectionId: job.connectionId, platform: job.platform, accountExternalId: job.accountExternalId, purpose: `REVIEWED_RETRY_${job.id}` });
    if (decision === "MARK_RECONCILIATION_ONLY") for (const operation of job.run.operations) await reconciliationRepository.enqueue({ operationId: operation.id, runId: job.runId, planId: job.run.planId, reason: "EXTERNAL_CHANGE_CHECK", providerIdentity: { providerRequestId: operation.providerRequestId, nativeResourceId: operation.nativeResourceId } });
    if (decision === "CREATE_COMPENSATION_DRAFT") {
      const operation = job.run.operations.find((entry) => entry.id === compensation?.originalOperationId) || job.run.operations[0];
      compensationPlan = await reconciliationService.createCompensationDraft({
        originalPlanId: job.run.plan.id,
        originalRunId: job.runId,
        originalOperationId: operation.id,
        reconciliationId: compensation?.reconciliationId || null,
        safeAction: compensation?.safeAction,
        proposedValues: compensation?.proposedValues || null,
        irreversibleWarning: compensation?.irreversibleWarning,
        actor,
        reason,
      });
    }
    const reviewRow = await client.marketingExecutionDeadLetterReview.update({ where: { jobId }, data: { status: "REVIEWED", reviewerAdminUserId: actor.id, reason: String(reason).trim(), decision, actionJobId: actionJob?.id || null, reviewedAt: new Date() } });
    if (audit) await audit.event({ actorId: actor.id, action: "MARKETING_EXECUTION_DEAD_LETTER_REVIEWED", targetId: jobId, targetType: "marketing_execution_job", metadata: { decision, actionJobId: actionJob?.id || null, compensationPlanId: compensationPlan?.id || null } });
    if (events) await events.emit("DEAD_LETTER_REVIEWED", { jobId, decision });
    return { review: reviewRow, actionJob, compensationPlan };
  }
  return Object.freeze({ review });
}
module.exports = { createDeadLetterReviewService };
