const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const { sanitizeProviderText } = require("./connectors/provider-http");
const { sanitizeBoundedJson, assertUuid, utcDateRange } = require("./validation-security");

function sanitizeSummary(value) {
  return sanitizeBoundedJson(value, { maxBytes: 64 * 1024, maxDepth: 8, maxFields: 100, maxArray: 200, maxString: 1000 });
}

function dto(row) {
  return {
    id: row.id, type: row.runType, trigger: row.trigger, status: row.status,
    startedAt: row.startedAt, completedAt: row.completedAt,
    scope: { platform: row.platform || null, connectionId: row.connectionId || null, accountExternalId: row.accountExternalId || null, windowStart: row.windowStart || null, windowEnd: row.windowEnd || null },
    counts: { processed: row.processedCount, created: row.createdCount, updated: row.updatedCount, succeeded: row.succeededCount, failed: row.failedCount, skipped: row.skippedCount },
    errorCode: row.errorCode || null,
    sanitizedError: row.sanitizedError ? sanitizeProviderText(row.sanitizedError).slice(0, 1000) : null,
    summary: sanitizeSummary(row.summary),
  };
}

function createRunQueryService({ prisma: db = prisma } = {}) {
  async function list(query) {
    const where = {
      ...(query.type ? { runType: query.type } : {}), ...(query.trigger ? { trigger: query.trigger } : {}),
      ...(query.status ? { status: query.status } : {}), ...(query.platform ? { platform: query.platform } : {}),
      ...(query.connectionId ? { connectionId: query.connectionId } : {}),
      ...((query.from || query.to) ? (() => {
        const from = query.from || "1970-01-01";
        const to = query.to || "9999-12-30";
        const range = utcDateRange(from, to, { maximumDays: 4000000 });
        return { startedAt: { ...(query.from ? { gte: range.startInclusive } : {}), ...(query.to ? { lt: range.endExclusive } : {}) } };
      })() : {}),
    };
    const [total, rows] = await Promise.all([db.marketing_intelligence_evaluation_runs.count({ where }), db.marketing_intelligence_evaluation_runs.findMany({ where, orderBy: [{ [query.sort]: query.direction }, { id: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit })]);
    return { items: rows.map(dto), pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  }
  async function get(id) {
    assertUuid(id, "evaluationRunId");
    const row = await db.marketing_intelligence_evaluation_runs.findUnique({ where: { id } });
    if (!row) throw new ApiError(404, "Marketing Intelligence evaluation run not found", [{ code: "NOT_FOUND" }]);
    return dto(row);
  }
  return { list, get };
}

module.exports = { sanitizeSummary, createRunQueryService };
