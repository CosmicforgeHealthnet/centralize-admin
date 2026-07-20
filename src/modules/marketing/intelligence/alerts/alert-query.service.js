const ApiError = require("../../../../shared/utils/ApiError");
const { assertUuid, utcDateRange } = require("../validation-security");
const { prisma } = require("../../../../shared/config/database");

function createAlertQueryService({ prisma: db = prisma } = {}) {
  async function list(filters = {}) {
    const { page = 1, limit = 25, sort = "newest", triggeredFrom, triggeredTo, ...where } = filters;
    const clean = Object.fromEntries(Object.entries(where).filter(([, value]) => value !== undefined));
    if (triggeredFrom || triggeredTo) clean.triggeredAt = { ...(triggeredFrom ? { gte: utcDateRange(triggeredFrom, triggeredFrom).startInclusive } : {}), ...(triggeredTo ? { lt: utcDateRange(triggeredTo, triggeredTo).endExclusive } : {}) };
    const [items, total] = await Promise.all([
      db.marketing_alerts.findMany({ where: clean, orderBy: [{ triggeredAt: sort === "oldest" ? "asc" : "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
      db.marketing_alerts.count({ where: clean }),
    ]);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }
  async function get(id) {
    assertUuid(id, "alertId");
    const alert = await db.marketing_alerts.findUnique({ where: { id } });
    if (!alert) throw new ApiError(404, "Marketing alert not found");
    return alert;
  }
  return { list, get };
}

module.exports = { createAlertQueryService };
