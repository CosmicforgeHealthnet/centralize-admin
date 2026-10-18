const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizePlainText } = require("../../intelligence/validation-security");
const { sanitizeExecutionJson, hashExecutionJson } = require("../execution-json.validator");
const { validateNormalizedResult } = require("./normalized-result");
const { canonicalJson } = require("../execution-json.validator");

function safeIdentifier(value, maximum = 512) {
  if (value == null) return null;
  return sanitizePlainText(String(value).replace(/[^a-zA-Z0-9._:\/-]/g, ""), maximum) || null;
}

class OperationRepository {
  constructor({ client = prisma, now = () => new Date() } = {}) {
    this.client = client;
    this.now = now;
  }

  async createOperation(data) {
    const idempotencyIdentity = sanitizeExecutionJson(data.idempotencyIdentity, "summary");
    try { return await this.client.marketingProviderOperation.create({
      data: {
        runId: data.runId,
        itemId: data.itemId,
        providerOperationKey: data.providerOperationKey,
        providerRequestId: safeIdentifier(data.providerRequestId, 255),
        nativeResourceId: safeIdentifier(data.nativeResourceId),
        nativeResourceName: safeIdentifier(data.nativeResourceName),
        status: data.status || "PENDING",
        safeToRetry: Boolean(data.safeToRetry),
        outcomeCertainty: data.outcomeCertainty || "UNKNOWN",
        normalizedResult: data.normalizedResult == null ? null : validateNormalizedResult(data.normalizedResult),
        idempotencyIdentity,
      },
    }); } catch (error) {
      if (error?.code !== "P2002") throw error;
      const existing = await this.client.marketingProviderOperation.findUnique({ where: { providerOperationKey: data.providerOperationKey } });
      if (!existing || canonicalJson(existing.idempotencyIdentity) !== canonicalJson(idempotencyIdentity)) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "IDEMPOTENCY_IDENTITY_CONFLICT" });
      return existing;
    }
  }

  async createAttempt(data) {
    return this.client.marketingProviderOperationAttempt.create({
      data: {
        operationId: data.operationId,
        number: data.number,
        errorCode: safeIdentifier(data.errorCode, 100),
        errorCategory: safeIdentifier(data.errorCategory, 100),
        retryAfterAt: data.retryAfterAt || null,
        startedAt: data.startedAt || this.now(),
        completedAt: null,
        normalizedError: data.normalizedError == null ? null : sanitizeExecutionJson(data.normalizedError, "normalizedError"),
      },
    });
  }

  async completeAttempt({ id, completedAt = this.now(), errorCode, errorCategory, retryAfterAt, normalizedError, retryDecision }) {
    const updated = await this.client.marketingProviderOperationAttempt.updateMany({
      where: { id, completedAt: null },
      data: {
        completedAt,
        errorCode: safeIdentifier(errorCode, 100),
        errorCategory: safeIdentifier(errorCategory, 100),
        retryAfterAt: retryAfterAt || null,
        normalizedError: normalizedError == null ? null : sanitizeExecutionJson(normalizedError, "normalizedError"),
        retryDecision: retryDecision == null ? undefined : sanitizeExecutionJson(retryDecision, "summary"),
      },
    });
    if (updated.count !== 1) throw executionError("EXECUTION_ALREADY_TERMINAL", { reasonCode: "ATTEMPT_ALREADY_COMPLETED" });
    return this.client.marketingProviderOperationAttempt.findUnique({ where: { id } });
  }

  async persistResult({ id, expectedStatus, status, safeToRetry = false, outcomeCertainty, result }) {
    const normalizedResult = validateNormalizedResult(result);
    const updated = await this.client.marketingProviderOperation.updateMany({
      where: { id, status: expectedStatus },
      data: {
        status,
        safeToRetry,
        outcomeCertainty,
        normalizedResult,
        providerRequestId: safeIdentifier(result.providerRequestId, 255),
        nativeResourceId: safeIdentifier(result.nativeResourceId),
        nativeResourceName: safeIdentifier(result.nativeResourceName),
      },
    });
    if (updated.count !== 1) throw executionError("INVALID_OPERATION_TRANSITION", { id, expectedStatus, status });
    return this.client.marketingProviderOperation.findUnique({ where: { id } });
  }

  async createSnapshot({ operationId, kind, sequence = 1, normalizedState, capturedAt = this.now() }) {
    const { sanitized, hash } = hashExecutionJson(normalizedState, "normalizedState");
    return this.client.marketingExecutionStateSnapshot.create({
      data: { operationId, kind, sequence, normalizedState: sanitized, hash, capturedAt },
    });
  }

  async createReconciliation({ runId, operationId, status, differences, checkedAt = this.now() }) {
    return this.client.marketingExecutionReconciliation.create({
      data: { runId, operationId, status, differences: sanitizeExecutionJson(differences, "differences"), checkedAt },
    });
  }
}

module.exports = { OperationRepository, safeIdentifier };
