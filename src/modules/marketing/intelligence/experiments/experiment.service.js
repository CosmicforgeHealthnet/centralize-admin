const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { canonicalJson, stableHash } = require("../creative/creative.connector.interface");
const { variantSchema, experimentResultSchema } = require("./experiment.validator");
const { requireActiveActor } = require("../actor-validation");
const { assertUuid, utcDateRange } = require("../validation-security");

function canonical(value) { return JSON.parse(canonicalJson(value)); }
function variantFingerprint(a, b) { return stableHash(canonicalJson({ variantA: a, variantB: b })); }

function assertPair(a, b) {
  const left = variantSchema.safeParse(a); const right = variantSchema.safeParse(b);
  if (!left.success || !right.success) throw new ApiError(400, "Invalid experiment variant configuration");
  if (canonicalJson(left.data) === canonicalJson(right.data)) throw new ApiError(400, "Experiment variants must differ");
  return { variantAConfig: left.data, variantBConfig: right.data };
}

async function validateConnection(tx, payload) {
  if (!payload.connectionId) return;
  const connection = await tx.marketing_ad_platform_connections.findUnique({ where: { id: payload.connectionId }, select: { id: true, platform: true } });
  if (!connection) throw new ApiError(400, "Marketing connection not found");
  if (payload.platform && payload.platform !== connection.platform) throw new ApiError(400, "Experiment platform does not match its connection");
}

function createExperimentService({ prisma: db = prisma, now = () => new Date() } = {}) {
  async function audit(tx, action, experiment, actor, previousStatus, metadata = {}) {
    return tx.auditLog.create({ data: { adminUserId: actor.id, action, targetId: experiment.id, targetType: "marketing_experiment", metadata: { experimentId: experiment.id, action, previousStatus: previousStatus || null, newStatus: experiment.status, metric: experiment.metric, platform: experiment.platform || null, campaignExternalId: experiment.campaignExternalId || null, timestamp: now().toISOString(), ...metadata }, ipAddress: actor.ipAddress || null, userAgent: actor.userAgent || null } });
  }

  async function create(payload, actor) {
    return db.$transaction(async (tx) => {
      await requireActiveActor(tx, actor);
      await validateConnection(tx, payload);
      const variants = assertPair(payload.variantAConfig, payload.variantBConfig);
      const experiment = await tx.marketing_experiments.create({ data: { ...payload, ...variants, status: "DRAFT", version: 1, createdByAdminUserId: actor.id } });
      await audit(tx, "MARKETING_EXPERIMENT_CREATED", experiment, actor, null, { variantFingerprint: variantFingerprint(variants.variantAConfig, variants.variantBConfig) });
      return experiment;
    });
  }

  async function get(id, client = db) {
    assertUuid(id, "experimentId");
    const experiment = await client.marketing_experiments.findUnique({ where: { id } });
    if (!experiment) throw new ApiError(404, "Marketing experiment not found");
    return experiment;
  }

  async function list(filters = {}) {
    const { page = 1, limit = 25, sort = "newest", createdFrom, createdTo, ...rest } = filters;
    const where = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    if (createdFrom || createdTo) where.createdAt = { ...(createdFrom ? { gte: utcDateRange(createdFrom, createdFrom).startInclusive } : {}), ...(createdTo ? { lt: utcDateRange(createdTo, createdTo).endExclusive } : {}) };
    const [items, total] = await Promise.all([db.marketing_experiments.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: sort === "oldest" ? "asc" : "desc" }, { id: "desc" }] }), db.marketing_experiments.count({ where })]);
    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async function update(id, payload, actor) {
    return db.$transaction(async (tx) => {
      await requireActiveActor(tx, actor);
      const before = await get(id, tx);
      if (before.status !== "DRAFT") throw new ApiError(409, "Only a draft experiment can be edited");
      const previousStatus = before.status;
      const previousVersion = before.version;
      const combined = { ...before, ...payload };
      await validateConnection(tx, combined);
      const variants = assertPair(combined.variantAConfig, combined.variantBConfig);
      const data = { ...payload, ...(payload.variantAConfig ? { variantAConfig: variants.variantAConfig } : {}), ...(payload.variantBConfig ? { variantBConfig: variants.variantBConfig } : {}), version: { increment: 1 } };
      const changed = await tx.marketing_experiments.updateMany({ where: { id, status: "DRAFT", version: previousVersion }, data });
      if (changed.count !== 1) throw new ApiError(409, "Experiment was modified concurrently");
      const experiment = await get(id, tx);
      await audit(tx, "MARKETING_EXPERIMENT_UPDATED", experiment, actor, previousStatus, { previousVersion, newVersion: experiment.version, changedFields: Object.keys(payload).sort(), variantFingerprint: variantFingerprint(variants.variantAConfig, variants.variantBConfig) });
      return experiment;
    }, { isolationLevel: "Serializable" });
  }

  async function start(id, actor) {
    return db.$transaction(async (tx) => {
      await requireActiveActor(tx, actor);
      const before = await get(id, tx);
      if (before.status !== "DRAFT") throw new ApiError(409, "Only a draft experiment can be started");
      const previousStatus = before.status;
      const previousVersion = before.version;
      if (!before.hypothesis || !before.metric) throw new ApiError(400, "Experiment is missing required tracking fields");
      assertPair(before.variantAConfig, before.variantBConfig);
      const changed = await tx.marketing_experiments.updateMany({ where: { id, status: "DRAFT", version: previousVersion }, data: { status: "RUNNING", startedAt: now(), version: { increment: 1 } } });
      if (changed.count !== 1) throw new ApiError(409, "Experiment was modified concurrently");
      const experiment = await get(id, tx);
      await audit(tx, "MARKETING_EXPERIMENT_STARTED", experiment, actor, previousStatus);
      return experiment;
    }, { isolationLevel: "Serializable" });
  }

  async function complete(id, payload, actor) {
    const parsed = experimentResultSchema.safeParse(payload.result);
    if (!parsed.success) throw new ApiError(400, "Invalid experiment result");
    return db.$transaction(async (tx) => {
      await requireActiveActor(tx, actor);
      const before = await get(id, tx);
      if (before.status !== "RUNNING") throw new ApiError(409, "Only a running experiment can be completed");
      const previousStatus = before.status;
      const previousVersion = before.version;
      const changed = await tx.marketing_experiments.updateMany({ where: { id, status: "RUNNING", version: previousVersion }, data: { status: "COMPLETED", endedAt: now(), result: canonical(parsed.data), conclusion: payload.conclusion ? sanitizeProviderText(payload.conclusion).slice(0, 4000) : null, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ApiError(409, "Experiment was modified concurrently");
      const experiment = await get(id, tx);
      await audit(tx, "MARKETING_EXPERIMENT_COMPLETED", experiment, actor, previousStatus, { winner: parsed.data.winner, resultFingerprint: stableHash(canonicalJson(parsed.data)) });
      return experiment;
    }, { isolationLevel: "Serializable" });
  }

  async function cancel(id, reason, actor) {
    return db.$transaction(async (tx) => {
      await requireActiveActor(tx, actor);
      const before = await get(id, tx);
      if (!["DRAFT", "RUNNING"].includes(before.status)) throw new ApiError(409, "Experiment cannot be cancelled from its current status");
      const previousStatus = before.status;
      const previousVersion = before.version;
      const safeReason = sanitizeProviderText(reason).slice(0, 1000);
      const changed = await tx.marketing_experiments.updateMany({ where: { id, status: previousStatus, version: previousVersion }, data: { status: "CANCELLED", cancelledAt: now(), cancellationReason: safeReason, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ApiError(409, "Experiment was modified concurrently");
      const experiment = await get(id, tx);
      await audit(tx, "MARKETING_EXPERIMENT_CANCELLED", experiment, actor, previousStatus, { reason: safeReason });
      return experiment;
    }, { isolationLevel: "Serializable" });
  }

  return { create, get, list, update, start, complete, cancel };
}

module.exports = { assertPair, variantFingerprint, createExperimentService };
