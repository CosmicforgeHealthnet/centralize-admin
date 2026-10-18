const crypto = require("crypto");
const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");
const { fingerprintPlan } = require("./plan-fingerprint");

function generatePlanNumber(now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `MEP-${day}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateItemSet(items) {
  const sequences = new Set();
  const references = new Set();
  const byId = new Map(items.filter((item) => item.id).map((item) => [item.id, item]));
  for (const item of items) {
    if (!Number.isInteger(item.sequence) || item.sequence < 0 || sequences.has(item.sequence)) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: "items.sequence", reasonCode: "INVALID_OR_DUPLICATE_ITEM_SEQUENCE" });
    }
    sequences.add(item.sequence);
    if (!String(item.clientReference || "").trim() || references.has(item.clientReference)) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: "items.clientReference", reasonCode: "MISSING_OR_DUPLICATE_CLIENT_REFERENCE" });
    }
    references.add(item.clientReference);
    if (item.id && !UUID_PATTERN.test(item.id)) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: "items.id", reasonCode: "INVALID_ITEM_ID" });
    }
    for (const dependencyId of item.dependsOnItemIds || []) {
      const dependency = byId.get(dependencyId);
      if (!UUID_PATTERN.test(dependencyId) || !dependency || dependency.sequence >= item.sequence) {
        throw executionError("INVALID_EXECUTION_PLAN", { field: "items.dependsOnItemIds", reasonCode: "INVALID_ITEM_DEPENDENCY" });
      }
    }
  }
  return items;
}

function normalizeItem(item, planId) {
  const intent = sanitizeExecutionJson(item.intent || {}, "intent");
  const beforeState = item.beforeState == null ? null : sanitizeExecutionJson(item.beforeState, "beforeState");
  return {
    id: item.id,
    planId,
    sequence: item.sequence,
    operationType: item.operationType,
    resourceType: item.resourceType,
    providerResourceId: item.providerResourceId || null,
    clientReference: item.clientReference,
    dependsOnItemIds: item.dependsOnItemIds || [],
    intent,
    beforeState,
    materialHash: item.materialHash || fingerprintPlan({
      operationType: item.operationType,
      resourceType: item.resourceType,
      providerResourceId: item.providerResourceId || null,
      clientReference: item.clientReference,
      dependsOnItemIds: item.dependsOnItemIds || [],
      intent,
    }, 1).fingerprint,
    status: item.status || "PENDING",
  };
}

class PlanRepository {
  constructor({ client = prisma, now = () => new Date(), planNumberFactory = generatePlanNumber } = {}) {
    this.client = client;
    this.now = now;
    this.planNumberFactory = planNumberFactory;
  }

  async create({ items = [], ...data }) {
    validateItemSet(items);
    const desiredState = sanitizeExecutionJson(data.desiredState || data.intent, "desiredState");
    const planData = {
      planNumber: data.planNumber || this.planNumberFactory(this.now()),
      sourceType: data.sourceType || "MANUAL",
      sourceRecommendationId: data.sourceRecommendationId || null,
      platform: data.platform || desiredState.provider,
      connectionId: data.connectionId || desiredState.connectionId,
      accountExternalId: data.accountExternalId || desiredState.accountId,
      name: data.name || desiredState.name || "Advertising execution plan",
      description: data.description || desiredState.description || null,
      status: "DRAFT",
      version: 1,
      currencyCode: data.currencyCode || desiredState.currencyCode,
      desiredState,
      validationFingerprint: null,
      validatedAt: null,
      expiresAt: null,
      createdByAdminUserId: data.createdByAdminUserId || data.authorId,
      updatedByAdminUserId: data.updatedByAdminUserId || data.authorId,
    };
    const transaction = typeof this.client.$transaction === "function" ? this.client.$transaction.bind(this.client) : async (handler) => handler(this.client);
    return transaction(async (tx) => {
      const plan = await tx.marketingExecutionPlan.create({ data: planData });
      if (items.length) {
        await tx.marketingExecutionPlanItem.createMany({ data: items.map((item) => normalizeItem(item, plan.id)) });
      }
      return tx.marketingExecutionPlan.findUnique({ where: { id: plan.id }, include: { items: { orderBy: { sequence: "asc" } } } });
    });
  }

  async getById(id) {
    return this.client.marketingExecutionPlan.findUnique({
      where: { id },
      include: {
        items: { orderBy: { sequence: "asc" } }, approvals: { include: { events: { orderBy: { decidedAt: "asc" } } }, orderBy: { decidedAt: "asc" } },
        runs: { orderBy: { createdAt: "desc" }, take: 20 }, validationPackets: { orderBy: { createdAt: "desc" }, take: 20 },
        validationIssues: { orderBy: { createdAt: "desc" }, take: 200 }, originalCompensations: true, compensationLinks: true,
      },
    });
  }

  async list({ where = {}, skip = 0, take = 25, orderBy = [{ createdAt: "desc" }, { id: "desc" }] } = {}) {
    const include = { _count: { select: { items: true, approvals: true, runs: true } }, runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true } }, validationPackets: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, valid: true, expiresAt: true, issueCount: true, warningCount: true } }, originalCompensations: { take: 1 }, compensationLinks: { take: 1 } };
    const [rows, total] = await Promise.all([this.client.marketingExecutionPlan.findMany({ where, skip, take, orderBy, include }), this.client.marketingExecutionPlan.count({ where })]);
    return { rows, total };
  }

  async listByConnectionStatus({ connectionId, status, cursor, limit = 50 }) {
    return this.client.marketingExecutionPlan.findMany({
      where: { connectionId, status },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(Number(limit) || 50, 1), 100),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  async updateMaterial({ id, expectedVersion, actorId, desiredState, name, description, items }) {
    const normalizedState = sanitizeExecutionJson(desiredState, "desiredState");
    return this.client.$transaction(async (tx) => {
      const updated = await tx.marketingExecutionPlan.updateMany({
        where: { id, version: expectedVersion, status: "DRAFT" },
        data: {
          desiredState: normalizedState,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          validationFingerprint: null,
          validatedAt: null,
          expiresAt: null,
          updatedByAdminUserId: actorId,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw executionError("PLAN_VERSION_CONFLICT", { id, expectedVersion, requiredState: "DRAFT" });
      if (items) {
        validateItemSet(items);
        await tx.marketingExecutionPlanItem.deleteMany({ where: { planId: id } });
        if (items.length) await tx.marketingExecutionPlanItem.createMany({ data: items.map((item) => normalizeItem(item, id)) });
      }
      return tx.marketingExecutionPlan.findUnique({ where: { id }, include: { items: { orderBy: { sequence: "asc" } } } });
    });
  }

  async save(plan) {
    return this.updateMaterial({
      id: plan.id,
      expectedVersion: plan.version - 1,
      actorId: plan.updatedByAdminUserId,
      desiredState: plan.intent || plan.desiredState,
      name: plan.name,
      description: plan.description,
      items: plan.items,
    });
  }

  async transition({ id, expectedVersion, fromStatus, toStatus, data = {} }) {
    const updated = await this.client.marketingExecutionPlan.updateMany({
      where: { id, version: expectedVersion, status: fromStatus },
      data: { ...data, status: toStatus },
    });
    if (updated.count !== 1) throw executionError("PLAN_VERSION_CONFLICT", { id, expectedVersion, fromStatus });
    return this.getById(id);
  }

  async persistValidationIssues({ planId, planVersion, validationFingerprint, issues }) {
    return this.client.marketingExecutionValidationIssue.createMany({
      data: issues.map((issue) => ({
        planId,
        itemId: issue.itemId || null,
        planVersion,
        validationFingerprint,
        severity: issue.severity,
        code: issue.code,
        fieldPath: issue.fieldPath,
        message: String(issue.message).slice(0, 2000),
        providerCode: issue.providerCode ? String(issue.providerCode).slice(0, 100) : null,
      })),
    });
  }

  async persistValidationPacket({ plan, actorId, packet, issues = [] }) {
    return this.client.$transaction(async (tx) => {
      const current = await tx.marketingExecutionPlan.findFirst({ where: { id: plan.id, version: plan.version, status: { in: ["DRAFT", "VALIDATED"] } }, select: { id: true } });
      if (!current) throw executionError("EXECUTION_PLAN_CONFLICT", { id: plan.id, expectedVersion: plan.version });
      let validationPacket = await tx.marketingExecutionValidationPacket.findUnique({ where: { planId_planVersion_validationFingerprint: { planId: plan.id, planVersion: plan.version, validationFingerprint: packet.fingerprint } } });
      if (!validationPacket) {
        validationPacket = await tx.marketingExecutionValidationPacket.create({ data: { planId: plan.id, planVersion: plan.version, validationFingerprint: packet.fingerprint, valid: packet.valid, providerApiVersion: packet.providerApiVersion || null, beforeStateHash: packet.beforeStateHash || null, beforeStateSummary: sanitizeExecutionJson(packet.beforeStateSummary || {}, "summary"), capabilitySummary: sanitizeExecutionJson(packet.capabilitySummary || {}, "summary"), budgetExposure: packet.budgetExposure || "0.00", activationExposure: packet.activationExposure === true, issueCount: issues.filter((issue) => issue.severity === "ERROR").length, warningCount: issues.filter((issue) => issue.severity === "WARNING").length, expiresAt: packet.expiresAt, validatedByAdminUserId: actorId } });
        if (issues.length) await tx.marketingExecutionValidationIssue.createMany({ data: issues.map((issue) => ({ planId: plan.id, itemId: issue.itemId || null, planVersion: plan.version, validationFingerprint: packet.fingerprint, severity: issue.severity, code: String(issue.code).slice(0, 100), fieldPath: String(issue.fieldPath || "plan").slice(0, 500), message: String(issue.message).slice(0, 2000), providerCode: issue.providerCode ? String(issue.providerCode).slice(0, 100) : null })) });
      }
      await tx.marketingExecutionPlan.update({ where: { id: plan.id }, data: { status: packet.valid ? "VALIDATED" : "DRAFT", validationFingerprint: packet.fingerprint, validatedAt: this.now(), expiresAt: packet.expiresAt, updatedByAdminUserId: actorId } });
      return validationPacket;
    });
  }

  async cancel({ id, expectedVersion, actorId, eligibleStatuses = ["DRAFT"] }) {
    const updated = await this.client.marketingExecutionPlan.updateMany({ where: { id, version: expectedVersion, status: { in: eligibleStatuses } }, data: { status: "CANCELLED", updatedByAdminUserId: actorId } });
    if (updated.count !== 1) throw executionError("EXECUTION_PLAN_CONFLICT", { id, expectedVersion, reasonCode: "PLAN_NOT_CANCELLABLE" });
    return this.getById(id);
  }

  async invalidateApprovals() {
    // Approval evidence is never deleted or rewritten. Version changes make
    // previous rows stale by definition.
    return { count: 0, strategy: "VERSIONED_STALENESS" };
  }
}

module.exports = { PlanRepository, generatePlanNumber, validateItemSet, normalizeItem };
