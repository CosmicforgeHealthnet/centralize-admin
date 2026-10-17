const { prisma } = require("../../../shared/config/database");
const { sanitizeProviderText } = require("./connectors/provider-http");
const { safeHash } = require("./utils/event-id");
const { sanitizeBoundedJson, sanitizePlainText } = require("./validation-security");
const { EVENTS, logEvent } = require("./observability");

function hasDelegate(db) {
  return Boolean(db?.marketing_intelligence_evaluation_runs);
}

function createRunLedgerService({ prisma: db = prisma, log } = {}) {
  async function startRun({
    runType = "SYNC",
    status = "STARTED",
    trigger,
    platform,
    connectionId,
    accountExternalId,
    requestedByAdminUserId,
    windowStart,
    windowEnd,
    lockKey,
    lockOwner,
    startedAt = new Date(),
    summary,
  } = {}) {
    if (!hasDelegate(db)) return null;
    return db.marketing_intelligence_evaluation_runs.create({
      data: {
        runType,
        status,
        trigger,
        platform,
        connectionId,
        accountExternalId,
        requestedByAdminUserId,
        windowStart,
        windowEnd,
        startedAt,
        lockKeyHash: safeHash(lockKey),
        lockOwnerHash: safeHash(lockOwner),
        summary: summary === undefined ? undefined : sanitizeBoundedJson(summary),
      },
    });
  }

  async function finishRun(id, data = {}) {
    if (!id || !hasDelegate(db)) return null;
    const sanitizedError = data.sanitizedError
      ? sanitizePlainText(sanitizeProviderText(String(data.sanitizedError)), 1000)
      : undefined;
    const { summary, lockKey, lockOwner, errorMessage, ...safeData } = data;
    const updated = await db.marketing_intelligence_evaluation_runs.update({
      where: { id },
      data: {
        ...safeData,
        ...(summary !== undefined && { summary: sanitizeBoundedJson(summary) }),
        ...(sanitizedError !== undefined && { sanitizedError }),
        completedAt: data.completedAt || new Date(),
      },
    });
    logEvent(EVENTS.EVALUATION_RUN_COMPLETED, {
      runId: id, status: safeData.status || updated?.status || null,
      processedCount: safeData.processedCount ?? updated?.processedCount ?? 0,
      succeededCount: safeData.succeededCount ?? updated?.succeededCount ?? 0,
      failedCount: safeData.failedCount ?? updated?.failedCount ?? 0,
      durationMs: null,
    }, { log });
    return updated;
  }

  async function updateRun(id, data = {}) {
    if (!id || !hasDelegate(db)) return null;
    const { lockKey, lockOwner, ...safeData } = data;
    return db.marketing_intelligence_evaluation_runs.update({
      where: { id },
      data: {
        ...safeData,
        ...(safeData.summary !== undefined && { summary: sanitizeBoundedJson(safeData.summary) }),
        ...(lockKey !== undefined && { lockKeyHash: safeHash(lockKey) }),
        ...(lockOwner !== undefined && { lockOwnerHash: safeHash(lockOwner) }),
      },
    });
  }

  return { startRun, updateRun, finishRun };
}

const defaultService = createRunLedgerService();

module.exports = {
  createRunLedgerService,
  startRun: defaultService.startRun,
  updateRun: defaultService.updateRun,
  finishRun: defaultService.finishRun,
};
