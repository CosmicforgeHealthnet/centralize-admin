const { prisma } = require("../../../../shared/config/database");
const ApiError = require("../../../../shared/utils/ApiError");
const { createCreativeRegistry } = require("./creative.registry");
const { assertUuid, utcDateRange } = require("../validation-security");

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value.toJSON === "function") return value.toJSON();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  return value;
}

function createCreativeQueryService({ prisma: db = prisma, registry = createCreativeRegistry() } = {}) {
  async function listCreatives(query = {}) {
    const page = query.page || 1;
    const limit = query.limit || 25;
    const where = {
      ...(query.platform && query.platform !== "all" ? { platform: query.platform } : {}),
      ...(query.connectionId ? { connectionId: query.connectionId } : {}),
      ...(query.accountExternalId ? { accountExternalId: query.accountExternalId } : {}),
      ...(query.campaignExternalId ? { campaignExternalId: query.campaignExternalId } : {}),
      ...(query.creativeType ? { type: query.creativeType } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.firstSeenFrom ? { firstSeenAt: { gte: utcDateRange(query.firstSeenFrom, query.firstSeenFrom).startInclusive } } : {}),
      ...(query.lastSeenTo ? { lastSeenAt: { lt: utcDateRange(query.lastSeenTo, query.lastSeenTo).endExclusive } } : {}),
    };
    const orderBy = query.sort === "firstSeenAt" ? [{ firstSeenAt: "desc" }, { id: "asc" }]
      : query.sort === "name" ? [{ name: "asc" }, { id: "asc" }]
        : [{ lastSeenAt: "desc" }, { id: "asc" }];
    const [total, items] = await Promise.all([
      db.marketing_creative_assets.count({ where }),
      db.marketing_creative_assets.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: { performanceSnapshots: { orderBy: { date: "desc" }, take: 1 } },
      }),
    ]);
    return jsonSafe({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }

  async function getCreative(id) {
    assertUuid(id, "creativeId");
    const asset = await db.marketing_creative_assets.findUnique({
      where: { id },
      include: {
        connection: { select: { id: true, platform: true, accountId: true, status: true } },
        performanceSnapshots: { orderBy: { date: "desc" }, take: 1 },
      },
    });
    if (!asset) throw new ApiError(404, "Creative asset not found");
    const [range, lastRun] = await Promise.all([
      db.marketing_creative_performance_snapshots.aggregate({
        where: { creativeAssetId: id },
        _min: { date: true },
        _max: { date: true },
      }),
      db.marketing_intelligence_evaluation_runs.findFirst({
        where: { runType: "CREATIVE_SYNC", connectionId: asset.connectionId },
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, startedAt: true, completedAt: true, errorCode: true },
      }),
    ]);
    const connector = registry[asset.platform];
    const capability = connector?.getCapability(asset.connection) || null;
    return jsonSafe({
      asset: { ...asset, performanceSnapshots: undefined },
      latestPerformance: asset.performanceSnapshots[0] || null,
      availableDateRange: { from: range._min.date, to: range._max.date },
      providerCapability: capability,
      lastSyncStatus: lastRun,
      dataLimitations: capability?.limitations || [],
    });
  }

  return { listCreatives, getCreative };
}

const defaultService = createCreativeQueryService();
module.exports = { createCreativeQueryService, listCreatives: defaultService.listCreatives, getCreative: defaultService.getCreative, jsonSafe };
