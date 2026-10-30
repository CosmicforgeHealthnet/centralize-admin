const ApiError = require("../../../../shared/utils/ApiError");
const { assertUuid, utcDateRange } = require("../validation-security");
const { prisma } = require("../../../../shared/config/database");

function createRecommendationQueryService({ prisma: db = prisma } = {}) {
  async function list(query = {}) {
    const { page = 1, limit = 25, sort = "generatedAt", generatedFrom, generatedTo, ...filters } = query;
    const where = {
      ...filters,
      ...((generatedFrom || generatedTo) ? { generatedAt: { ...(generatedFrom ? { gte: utcDateRange(generatedFrom, generatedFrom).startInclusive } : {}), ...(generatedTo ? { lt: utcDateRange(generatedTo, generatedTo).endExclusive } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      db.marketing_recommendations.findMany({ where, orderBy: [{ [sort]: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
      db.marketing_recommendations.count({ where }),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }
  async function get(id) {
    assertUuid(id, "recommendationId");
    const row = await db.marketing_recommendations.findUnique({ where: { id } });
    if (!row) throw new ApiError(404, "Marketing recommendation not found");
    return row;
  }
  return { list, get };
}
module.exports = { createRecommendationQueryService };
