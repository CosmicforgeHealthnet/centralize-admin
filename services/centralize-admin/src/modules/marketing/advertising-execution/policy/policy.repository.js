const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson, canonicalJson } = require("../execution-json.validator");

const POLICY_RULES = Object.freeze({
  "execution.enabled": { type: "BOOLEAN", restrictiveGlobal: true },
  "execution.write.enabled": { type: "BOOLEAN", restrictiveGlobal: true },
  "budget.account.daily.max": { type: "DECIMAL", min: "0" },
  "budget.account.monthly.max": { type: "DECIMAL", min: "0" },
  "budget.campaign.daily.max": { type: "DECIMAL", min: "0" },
  "budget.shared.max": { type: "DECIMAL", min: "0" },
  "approval.required.count": { type: "INTEGER", min: 1, max: 10 },
  "approval.required.tier": { type: "STRING", values: ["ADMIN", "EXECUTIVE", "SUPER"] },
  "validation.freshness.minutes": { type: "INTEGER", min: 1, max: 1440 },
  "creative.destination.domains": { type: "JSON", domains: true },
  "creative.malware.policy": { type: "STRING", values: ["BLOCK", "WARN"] },
});

function validateTypedPolicyValue(valueType, value) {
  const sanitized = sanitizeExecutionJson(value, "policyValue");
  const valid = valueType === "BOOLEAN" ? typeof sanitized === "boolean"
    : valueType === "INTEGER" ? Number.isSafeInteger(sanitized)
      : valueType === "DECIMAL" ? typeof sanitized === "string" && /^\d+(?:\.\d{1,6})?$/.test(sanitized)
        : valueType === "STRING" ? typeof sanitized === "string" && sanitized.length <= 255
          : valueType === "JSON";
  if (!valid) throw executionError("INVALID_EXECUTION_PLAN", { field: "policyValue", reasonCode: "POLICY_VALUE_TYPE_MISMATCH", valueType });
  return sanitized;
}

function validatePolicyKey(key, valueType, value) {
  const rule = POLICY_RULES[key];
  if (!rule) throw executionError("INVALID_EXECUTION_PLAN", { field: "policy.key", reasonCode: "UNKNOWN_POLICY_KEY" });
  if (rule.type !== valueType) throw executionError("INVALID_EXECUTION_PLAN", { field: "policy.valueType", reasonCode: "POLICY_KEY_TYPE_MISMATCH", expected: rule.type });
  const safe = validateTypedPolicyValue(valueType, value);
  if (valueType === "INTEGER" && (safe < rule.min || safe > rule.max)) throw executionError("INVALID_EXECUTION_PLAN", { field: "policy.value", reasonCode: "POLICY_INTEGER_OUT_OF_RANGE" });
  if (valueType === "DECIMAL" && Number(safe) < Number(rule.min || 0)) throw executionError("INVALID_EXECUTION_PLAN", { field: "policy.value", reasonCode: "POLICY_DECIMAL_OUT_OF_RANGE" });
  if (rule.values && !rule.values.includes(String(safe).toUpperCase())) throw executionError("INVALID_EXECUTION_PLAN", { field: "policy.value", reasonCode: "POLICY_ENUM_VALUE_INVALID" });
  if (rule.domains) {
    if (!Array.isArray(safe) || safe.length > 100 || safe.some((domain) => typeof domain !== "string" || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))) throw executionError("INVALID_EXECUTION_PLAN", { field: "policy.value", reasonCode: "POLICY_DOMAIN_ALLOWLIST_INVALID" });
    return [...new Set(safe.map((domain) => domain.toLowerCase()))].sort();
  }
  return rule.values ? String(safe).toUpperCase() : safe;
}

function validatePolicyScope({ scope, platform, connectionId }) {
  if (scope === "GLOBAL" && !platform && !connectionId) return;
  if (scope === "PLATFORM" && platform && !connectionId) return;
  if (scope === "CONNECTION" && connectionId) return;
  throw executionError("INVALID_EXECUTION_PLAN", { field: "scope", reasonCode: "INVALID_POLICY_SCOPE" });
}

function scopeEvidence(policy) { return sanitizeExecutionJson({ scope: policy.scope, platform: policy.platform || null, connectionId: policy.connectionId || null }, "summary"); }

class PolicyRepository {
  constructor({ client = prisma } = {}) { this.client = client; }

  async create(data) {
    validatePolicyScope(data); const safeValue = validatePolicyKey(data.key, data.valueType, data.value);
    const transaction = typeof this.client.$transaction === "function" ? this.client.$transaction.bind(this.client) : async (handler) => handler(this.client);
    return transaction(async (tx) => {
      const policy = await tx.marketingExecutionPolicy.create({ data: { scope: data.scope, platform: data.platform || null, connectionId: data.connectionId || null, key: data.key, valueType: data.valueType, value: safeValue, enabled: Boolean(data.enabled), version: 1, createdByAdminUserId: data.actorId, updatedByAdminUserId: data.actorId } });
      await tx.marketingExecutionPolicyHistory.create({ data: { policyId: policy.id, version: 1, valueType: policy.valueType, value: safeValue, enabled: policy.enabled, previousVersion: null, previousValue: null, previousEnabled: null, newVersion: 1, newValue: safeValue, newEnabled: policy.enabled, correlationId: data.correlationId || null, effectiveScope: scopeEvidence(policy), behaviorChanged: policy.enabled, reason: String(data.reason || "Initial policy creation").slice(0, 2000), changedFields: ["created"], changedByAdminUserId: data.actorId } });
      return policy;
    });
  }

  async update({ id, expectedVersion, actorId, valueType, value, enabled, reason, changedFields = [], correlationId = null }) {
    const transaction = typeof this.client.$transaction === "function" ? this.client.$transaction.bind(this.client) : async (handler) => handler(this.client);
    return transaction(async (tx) => {
      const previous = await tx.marketingExecutionPolicy.findUnique({ where: { id } });
      if (!previous || previous.version !== expectedVersion) throw executionError("PLAN_VERSION_CONFLICT", { entity: "POLICY", id, expectedVersion });
      const safeValue = validatePolicyKey(previous.key, valueType, value); const nextEnabled = Boolean(enabled);
      const updated = await tx.marketingExecutionPolicy.updateMany({ where: { id, version: expectedVersion }, data: { valueType, value: safeValue, enabled: nextEnabled, updatedByAdminUserId: actorId, version: { increment: 1 } } });
      if (updated.count !== 1) throw executionError("PLAN_VERSION_CONFLICT", { entity: "POLICY", id, expectedVersion });
      const policy = await tx.marketingExecutionPolicy.findUnique({ where: { id } });
      const behaviorChanged = previous.enabled !== nextEnabled || previous.valueType !== valueType || canonicalJson(previous.value) !== canonicalJson(safeValue);
      await tx.marketingExecutionPolicyHistory.create({ data: { policyId: id, version: policy.version, valueType, value: safeValue, enabled: nextEnabled, previousVersion: previous.version, previousValue: previous.value, previousEnabled: previous.enabled, newVersion: policy.version, newValue: safeValue, newEnabled: nextEnabled, correlationId, effectiveScope: scopeEvidence(previous), behaviorChanged, reason: String(reason).trim().slice(0, 2000), changedFields: sanitizeExecutionJson(changedFields, "summary"), changedByAdminUserId: actorId } });
      return policy;
    });
  }

  async list({ where = {}, skip = 0, take = 25, orderBy = [{ updatedAt: "desc" }, { id: "desc" }] } = {}) {
    const [rows, total] = await Promise.all([this.client.marketingExecutionPolicy.findMany({ where, skip, take, orderBy, include: { history: { orderBy: { version: "desc" }, take: 1 } } }), this.client.marketingExecutionPolicy.count({ where })]);
    return { rows, total };
  }

  async resolveEffective({ key, platform, connectionId }) {
    const candidates = await this.client.marketingExecutionPolicy.findMany({ where: { key, OR: [...(connectionId ? [{ scope: "CONNECTION", connectionId }] : []), ...(platform ? [{ scope: "PLATFORM", platform, connectionId: null }] : []), { scope: "GLOBAL", platform: null, connectionId: null }] } });
    const global = candidates.find((row) => row.scope === "GLOBAL");
    if (POLICY_RULES[key]?.restrictiveGlobal && !global) return null;
    if (POLICY_RULES[key]?.restrictiveGlobal && (!global.enabled || global.value !== true)) return { ...global, effectiveSource: "GLOBAL_RESTRICTIVE" };
    const rank = { GLOBAL: 1, PLATFORM: 2, CONNECTION: 3 }; const selected = candidates.sort((left, right) => rank[right.scope] - rank[left.scope])[0];
    return selected ? { ...selected, effectiveSource: selected.scope } : null;
  }
}

module.exports = { POLICY_RULES, PolicyRepository, validatePolicyKey, validatePolicyScope, validateTypedPolicyValue };
