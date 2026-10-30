const crypto = require("crypto");
const { prisma } = require("../../../shared/config/database");
const ApiError = require("../../../shared/utils/ApiError");
const logger = require("../../../shared/utils/logger");
const { structuredLogger } = require("./observability");
const { SETTING_REGISTRY, SETTING_KEYS } = require("./setting-registry");
const { requireActiveActor: validateActiveActor } = require("./actor-validation");
const { safeDecimal } = require("./utils/currency");

const ATTRIBUTION_WINDOW_KEY = "attributionWindowDays";
const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 30;
const MIN_ATTRIBUTION_WINDOW_DAYS = 1;
const MAX_ATTRIBUTION_WINDOW_DAYS = 90;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

function settingError(statusCode, message, code, field) {
  return new ApiError(statusCode, message, [{ code, ...(field ? { field } : {}) }]);
}

function rawValue(row) {
  const raw = row?.valueJson ?? row?.legacyValue ?? row?.value;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Object.hasOwn(raw, "value")) return raw.value;
    if (Object.hasOwn(raw, "days")) return raw.days;
  }
  return raw;
}

function normalizeCurrency(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toUpperCase();
  if (!CURRENCY.test(normalized)) throw settingError(400, "Setting currency is invalid", "SETTING_CURRENCY_INVALID", "currencyCode");
  return normalized;
}

function normalizeValue(key, value) {
  const definition = SETTING_REGISTRY[key];
  if (!definition) throw settingError(400, "Unknown Marketing Intelligence setting", "SETTING_INVALID", "key");
  if (value === null && definition.nullable) return null;
  if (definition.type === "BOOLEAN") {
    if (typeof value !== "boolean") throw settingError(400, `${key} must be Boolean`, "SETTING_INVALID", "value");
    return value;
  }
  if (definition.type === "STRING") {
    if (typeof value !== "string") throw settingError(400, `${key} must be a string`, "SETTING_INVALID", "value");
    const normalized = value.trim();
    if (definition.adminAssignee && !UUID.test(normalized)) throw settingError(400, `${key} must be a UUID or null`, "SETTING_INVALID", "value");
    return normalized;
  }
  if (definition.type === "DECIMAL") {
    if (!["string", "number"].includes(typeof value) || typeof value === "boolean") throw settingError(400, `${key} must be numeric`, "SETTING_INVALID", "value");
    const canonical = String(value).trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(canonical)) throw settingError(400, `${key} must use canonical non-negative decimal notation`, "SETTING_INVALID", "value");
    let decimal;
    try { decimal = safeDecimal(canonical, { allowNegative: false }); }
    catch (_error) { throw settingError(400, `${key} must be a finite decimal`, "SETTING_INVALID", "value"); }
    if (definition.min !== undefined && decimal.lt(String(definition.min))) throw settingError(400, `${key} is below its minimum`, "SETTING_OUT_OF_RANGE", "value");
    if (definition.max !== undefined && decimal.gt(String(definition.max))) throw settingError(400, `${key} exceeds its maximum`, "SETTING_OUT_OF_RANGE", "value");
    return decimal.toString();
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw settingError(400, `${key} must be a safe integer`, "SETTING_INVALID", "value");
  if (definition.min !== undefined && number < definition.min) throw settingError(400, `${key} is below its minimum`, "SETTING_OUT_OF_RANGE", "value");
  if (definition.max !== undefined && number > definition.max) throw settingError(400, `${key} exceeds its maximum`, "SETTING_OUT_OF_RANGE", "value");
  return number;
}

function scopeFingerprint({ scope, platform, connectionId, currencyCode }) {
  const base = scope === "GLOBAL" ? "GLOBAL" : scope === "PLATFORM" ? `PLATFORM:${platform}` : `CONNECTION:${connectionId}`;
  return currencyCode ? `${base}:CURRENCY:${currencyCode}` : base;
}

function rank(row, context) {
  if (row.scopeType === "CONNECTION" && context.connectionId && row.connectionId === context.connectionId) return 3;
  if (row.scopeType === "PLATFORM" && context.platform && row.platform === context.platform) return 2;
  if (row.scopeType === "GLOBAL") return 1;
  return 0;
}

function sanitizeSetting(row) {
  return {
    id: row.id,
    key: row.key,
    scope: row.scopeType,
    platform: row.platform || null,
    connectionId: row.connectionId || null,
    currencyCode: row.currencyCode || null,
    value: rawValue(row),
    valueType: row.valueType,
    version: row.version,
    updatedAt: row.updatedAt || null,
  };
}

function warningFor(row, reasonCode) {
  return { key: row.key, settingId: row.id, scope: row.scopeType, version: row.version, reasonCode };
}

function isEligibleAssignee(admin, now = new Date()) {
  if (!admin || admin.status !== "ACTIVE") return false;
  if (admin.tier === "SUPER" || admin.department === "MARKETING") return true;
  return (admin.sectionGrants || []).some((grant) => grant.module === "marketing" && ["intelligence", "*"].includes(grant.section) && grant.mode === "EDIT" && !grant.revokedAt && (!grant.expiresAt || new Date(grant.expiresAt) > now));
}

function createSettingsService({ prisma: db = prisma, log = logger } = {}) {
  log = structuredLogger(log, "marketing.settings.operation");
  async function connectionFor(connectionId, client = db) {
    if (!connectionId) return null;
    return client.marketing_ad_platform_connections?.findUnique
      ? client.marketing_ad_platform_connections.findUnique({ where: { id: connectionId } })
      : null;
  }

  async function adminFor(id, client = db) {
    if (!id || !client.adminUser?.findUnique) return null;
    return client.adminUser.findUnique({ where: { id }, include: { sectionGrants: true } });
  }

  async function validateContext(context = {}, client = db) {
    const normalized = {
      platform: context.platform ? String(context.platform).toUpperCase() : undefined,
      connectionId: context.connectionId || undefined,
      currencyCode: normalizeCurrency(context.currencyCode),
    };
    if (normalized.connectionId) {
      const connection = await connectionFor(normalized.connectionId, client);
      if (!connection && client.marketing_ad_platform_connections?.findUnique) throw settingError(400, "Marketing connection was not found", "SETTING_CONNECTION_NOT_FOUND", "connectionId");
      if (!connection) return normalized;
      if (normalized.platform && connection.platform !== normalized.platform) throw settingError(400, "Connection does not belong to the requested platform", "SETTING_PLATFORM_MISMATCH", "platform");
      normalized.platform = normalized.platform || connection.platform;
      normalized.connection = connection;
      if (!normalized.currencyCode) {
        const candidate = String(connection.currency || connection.connectionMetadata?.currency || "").toUpperCase();
        if (CURRENCY.test(candidate)) normalized.currencyCode = candidate;
      }
    }
    return normalized;
  }

  async function validateCandidate(row, context, client = db) {
    const definition = SETTING_REGISTRY[row.key];
    if (!definition || !definition.scopes.includes(row.scopeType)) return "SETTING_SCOPE_INVALID";
    if (row.scopeType === "PLATFORM" && (!row.platform || row.connectionId)) return "SETTING_SCOPE_INVALID";
    if (row.scopeType === "CONNECTION" && (!row.connectionId || (context.connectionId && row.connectionId !== context.connectionId))) return "SETTING_SCOPE_INVALID";
    if (row.scopeType === "GLOBAL" && (row.platform || row.connectionId)) return "SETTING_SCOPE_INVALID";
    if (row.scopeType === "PLATFORM" && context.platform && row.platform !== context.platform) return "SETTING_PLATFORM_MISMATCH";
    if (definition.currencyAware) {
      if (!row.currencyCode) return "SETTING_CURRENCY_REQUIRED";
      if (context.currencyCode && row.currencyCode !== context.currencyCode) return "SETTING_CURRENCY_MISMATCH";
    } else if (row.currencyCode) return "SETTING_SCOPE_INVALID";
    try { normalizeValue(row.key, rawValue(row)); } catch (error) { return error.errors?.[0]?.code || "SETTING_INVALID_TYPE"; }
    if (definition.adminAssignee && rawValue(row)) {
      const admin = await adminFor(String(rawValue(row)), client);
      if (!admin) return "SETTING_ADMIN_NOT_FOUND";
      if (!isEligibleAssignee(admin)) return "SETTING_ADMIN_INACTIVE";
    }
    return null;
  }

  async function resolveSettings(context = {}, { keys = SETTING_KEYS, client = db } = {}) {
    const normalizedContext = await validateContext(context, client);
    const rows = client.marketing_intelligence_settings?.findMany
      ? await client.marketing_intelligence_settings.findMany({
        where: { key: { in: keys }, OR: [{ scopeType: "GLOBAL" }, ...(normalizedContext.platform ? [{ scopeType: "PLATFORM", platform: normalizedContext.platform }] : []), ...(normalizedContext.connectionId ? [{ scopeType: "CONNECTION", connectionId: normalizedContext.connectionId }] : [])] },
      })
      : [];
    const values = {}; const sources = {}; const warnings = [];
    for (const key of keys) {
      const definition = SETTING_REGISTRY[key];
      if (!definition) continue;
      if (definition.currencyAware && !normalizedContext.currencyCode) {
        const warning = { key, settingId: null, scope: "REQUEST", version: null, reasonCode: "SETTING_CURRENCY_CONTEXT_REQUIRED" };
        warnings.push(warning);
        values[key] = null;
        sources[key] = { scopeType: "UNAVAILABLE", version: null, currencyCode: null };
        continue;
      }
      const candidates = rows.filter((row) => row.key === key && rank(row, normalizedContext) > 0)
        .filter((row) => !definition.currencyAware || row.currencyCode === normalizedContext.currencyCode)
        .sort((a, b) => rank(b, normalizedContext) - rank(a, normalizedContext) || b.version - a.version);
      let selected = null;
      for (const row of candidates) {
        if (definition.nullable && rawValue(row) === null) continue;
        const reasonCode = await validateCandidate(row, normalizedContext, client);
        if (reasonCode) {
          const warning = warningFor(row, reasonCode); warnings.push(warning);
          log.warn(`[MarketingIntelligence] Invalid setting skipped: ${JSON.stringify(warning)}`);
          continue;
        }
        selected = row; break;
      }
      values[key] = selected ? normalizeValue(key, rawValue(selected)) : definition.default;
      sources[key] = selected ? { scopeType: selected.scopeType, id: selected.id, version: selected.version, currencyCode: selected.currencyCode || null } : { scopeType: "BOOTSTRAP_DEFAULT", version: null, currencyCode: definition.currencyAware ? normalizedContext.currencyCode : null };
      if (!selected && definition.currencyAware) warnings.push({ key, settingId: null, scope: "BOOTSTRAP", version: null, reasonCode: "SETTING_MONETARY_VALUE_UNAVAILABLE", currencyCode: normalizedContext.currencyCode });
    }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ context: { platform: normalizedContext.platform || null, connectionId: normalizedContext.connectionId || null, currencyCode: normalizedContext.currencyCode || null }, values, sources })).digest("hex");
    return { values, sources, invalidSettings: warnings, warnings, fingerprint, context: normalizedContext };
  }

  async function validateUpdate(update, actor, client) {
    const definition = SETTING_REGISTRY[update.key];
    if (!definition) throw settingError(400, "Unknown Marketing Intelligence setting", "SETTING_INVALID", "key");
    const scope = String(update.scope || "").toUpperCase();
    if (!definition.scopes.includes(scope)) throw settingError(400, "Setting is not allowed at this scope", "SETTING_SCOPE_INVALID", "scope");
    const platform = update.platform ? String(update.platform).toUpperCase() : null;
    const connectionId = update.connectionId || null;
    if (scope === "GLOBAL" && (platform || connectionId)) throw settingError(400, "GLOBAL setting cannot include platform or connection", "SETTING_SCOPE_INVALID", "scope");
    if (scope === "PLATFORM" && (!platform || connectionId)) throw settingError(400, "PLATFORM setting requires only platform", "SETTING_SCOPE_INVALID", "scope");
    if (scope === "CONNECTION" && !connectionId) throw settingError(400, "CONNECTION setting requires connectionId", "SETTING_SCOPE_INVALID", "connectionId");
    let connection = null;
    if (connectionId) {
      connection = await connectionFor(connectionId, client);
      if (!connection) throw settingError(400, "Marketing connection was not found", "SETTING_CONNECTION_NOT_FOUND", "connectionId");
      if (platform && connection.platform !== platform) throw settingError(400, "Connection does not belong to platform", "SETTING_PLATFORM_MISMATCH", "platform");
    }
    let currencyCode = normalizeCurrency(update.currencyCode);
    if (definition.currencyAware && !currencyCode && connection) {
      const derived = String(connection.currency || connection.connectionMetadata?.currency || "").toUpperCase();
      if (CURRENCY.test(derived)) currencyCode = derived;
    }
    if (definition.currencyAware && !currencyCode) throw settingError(400, "Currency is required for this setting", "SETTING_CURRENCY_REQUIRED", "currencyCode");
    if (!definition.currencyAware && currencyCode) throw settingError(400, "Currency is not allowed for this setting", "SETTING_SCOPE_INVALID", "currencyCode");
    const value = normalizeValue(update.key, update.value);
    if (definition.adminAssignee && value !== null) {
      const admin = await adminFor(value, client);
      if (!admin) throw settingError(400, "Default assignee was not found", "SETTING_ADMIN_NOT_FOUND", "value");
      if (!isEligibleAssignee(admin)) throw settingError(400, "Default assignee is inactive or ineligible", "SETTING_ADMIN_INACTIVE", "value");
    }
    return { key: update.key, scope, platform: scope === "PLATFORM" ? platform : connection?.platform || null, connectionId, currencyCode, value, valueType: definition.type, expectedVersion: update.expectedVersion, fingerprint: scopeFingerprint({ scope, platform, connectionId, currencyCode }), actor };
  }

  async function requireActiveActor(actor, client = db) {
    return validateActiveActor(client, actor, { minimumTier: "ADMIN" });
  }

  async function updateSettings(updates, actor) {
    if (!Array.isArray(updates) || !updates.length) throw settingError(400, "At least one setting update is required", "SETTING_INVALID", "updates");
    return db.$transaction(async (tx) => {
      await requireActiveActor(actor, tx);
      const normalized = [];
      for (const update of updates) normalized.push(await validateUpdate(update, actor, tx));
      if (new Set(normalized.map((item) => `${item.key}|${item.fingerprint}`)).size !== normalized.length) throw settingError(400, "Duplicate setting identity in batch", "SETTING_INVALID", "updates");
      const saved = [];
      for (const item of normalized) {
        const existing = await tx.marketing_intelligence_settings.findUnique({ where: { key_scopeFingerprint: { key: item.key, scopeFingerprint: item.fingerprint } } });
        const actualVersion = existing?.version || 0;
        const previousValue = existing ? rawValue(existing) : null;
        if (item.expectedVersion !== actualVersion) throw settingError(409, "Setting version conflict", "SETTING_VERSION_CONFLICT", "expectedVersion");
        const data = { scopeType: item.scope, platform: item.scope === "GLOBAL" ? null : item.platform, connectionId: item.connectionId, currencyCode: item.currencyCode, scopeFingerprint: item.fingerprint, valueType: item.valueType, valueJson: { value: item.value }, updatedByAdminUserId: actor.id };
        let row;
        if (existing) {
          const changed = await tx.marketing_intelligence_settings.updateMany({ where: { id: existing.id, version: item.expectedVersion }, data: { ...data, version: { increment: 1 } } });
          if (changed.count !== 1) throw settingError(409, "Setting version conflict", "SETTING_VERSION_CONFLICT", "expectedVersion");
          row = await tx.marketing_intelligence_settings.findUnique({ where: { id: existing.id } });
        } else {
          row = await tx.marketing_intelligence_settings.create({ data: { key: item.key, ...data, version: 1 } });
        }
        await tx.auditLog.create({ data: { adminUserId: actor.id, action: "MARKETING_INTELLIGENCE_SETTINGS_UPDATED", targetId: row.id, targetType: "marketing_intelligence_settings", metadata: { key: item.key, scope: item.scope, platform: item.platform, connectionId: item.connectionId, currencyCode: item.currencyCode, oldValue: previousValue, newValue: item.value, oldVersion: actualVersion, newVersion: row.version }, ipAddress: actor.ipAddress || null, userAgent: actor.userAgent || null } });
        saved.push(sanitizeSetting(row));
      }
      return saved;
    }, { isolationLevel: "Serializable" });
  }

  async function getSettings(context = {}, { includeConfigured = true, includeDefaults = true } = {}) {
    const resolved = await resolveSettings(context);
    if (resolved.values.llmCommentaryEnabled === true) {
      resolved.warnings.push({ code: "LLM_COMMENTARY_UNAVAILABLE", key: "llmCommentaryEnabled", message: "No approved commentary adapter is configured; deterministic output remains active and no external request will be made" });
    }
    const effective = Object.fromEntries(SETTING_KEYS.map((key) => [key, { value: resolved.values[key], source: resolved.sources[key].scopeType === "BOOTSTRAP_DEFAULT" ? "BOOTSTRAP" : resolved.sources[key].scopeType, version: resolved.sources[key].version, currencyCode: resolved.sources[key].currencyCode || null }]));
    let configured = [];
    if (includeConfigured && db.marketing_intelligence_settings?.findMany) {
      const rows = await db.marketing_intelligence_settings.findMany({ where: { key: { in: SETTING_KEYS } }, orderBy: [{ key: "asc" }, { scopeType: "asc" }, { version: "desc" }] });
      configured = rows.map(sanitizeSetting);
    }
    return { context: { platform: resolved.context.platform || null, connectionId: resolved.context.connectionId || null, currencyCode: resolved.context.currencyCode || null }, effective: includeDefaults ? effective : Object.fromEntries(Object.entries(effective).filter(([, value]) => value.source !== "BOOTSTRAP")), configured, warnings: resolved.warnings, settingsFingerprint: resolved.fingerprint };
  }

  async function getAttributionWindowDays() {
    const resolved = await resolveSettings({}, { keys: [ATTRIBUTION_WINDOW_KEY] });
    return Number(resolved.values[ATTRIBUTION_WINDOW_KEY]);
  }

  async function setAttributionWindowDays(days) {
    const value = normalizeValue(ATTRIBUTION_WINDOW_KEY, days);
    return db.marketing_intelligence_settings.upsert({ where: { key_scopeFingerprint: { key: ATTRIBUTION_WINDOW_KEY, scopeFingerprint: "GLOBAL" } }, create: { key: ATTRIBUTION_WINDOW_KEY, scopeType: "GLOBAL", scopeFingerprint: "GLOBAL", valueType: "INTEGER", valueJson: { value }, version: 1 }, update: { valueType: "INTEGER", valueJson: { value }, version: { increment: 1 } } });
  }

  return { resolveSettings, getSettings, updateSettings, validateUpdate, requireActiveActor, getAttributionWindowDays, setAttributionWindowDays };
}

const defaultService = createSettingsService();
module.exports = { ATTRIBUTION_WINDOW_KEY, DEFAULT_ATTRIBUTION_WINDOW_DAYS, MIN_ATTRIBUTION_WINDOW_DAYS, MAX_ATTRIBUTION_WINDOW_DAYS, SETTING_REGISTRY, normalizeValue, normalizeCurrency, scopeFingerprint, isEligibleAssignee, createSettingsService, getAttributionWindowDays: defaultService.getAttributionWindowDays, setAttributionWindowDays: defaultService.setAttributionWindowDays };
