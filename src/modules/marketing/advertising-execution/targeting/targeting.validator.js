const { z } = require("zod");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");

const base = { clientReference: z.string().trim().min(1).max(128), excluded: z.boolean().default(false) };
const targetingSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("LOCATION"), query: z.string().trim().min(1).max(255), locationType: z.enum(["COUNTRY", "REGION", "CITY", "POSTAL_CODE", "RADIUS"]), radius: z.object({ value: z.number().positive().max(500), unit: z.enum(["KM", "MILE"]), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict().nullable().default(null) }).strict(),
  z.object({ ...base, type: z.literal("LANGUAGE"), query: z.string().trim().min(1).max(100) }).strict(),
  z.object({ ...base, type: z.literal("KEYWORD"), value: z.string().trim().min(1).max(80), matchType: z.enum(["EXACT", "PHRASE", "BROAD"]), negative: z.boolean().default(false), scope: z.enum(["CAMPAIGN", "GROUP"]) }).strict(),
  z.object({ ...base, type: z.literal("DEMOGRAPHIC"), dimension: z.enum(["AGE_RANGE", "GENDER", "PARENTAL_STATUS", "HOUSEHOLD_INCOME"]), value: z.string().trim().min(1).max(100) }).strict(),
  z.object({ ...base, type: z.literal("INTEREST"), query: z.string().trim().min(1).max(255) }).strict(),
  z.object({ ...base, type: z.literal("PLACEMENT"), placement: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()), mode: z.enum(["MANUAL", "AUTOMATIC"]), device: z.enum(["ALL", "DESKTOP", "MOBILE", "TABLET"]).default("ALL") }).strict(),
]);

const FORBIDDEN_CATEGORIES = new Set(["POLITICAL", "HOUSING", "EMPLOYMENT", "CREDIT", "HEALTHCARE", "PROTECTED_CHARACTERISTIC", "SENSITIVE_TRAIT", "CRM_CUSTOMER_LIST", "CUSTOM_AUDIENCE_PII", "DATA_BROKER"]);

async function resolveTargetingCriteria(input, {
  provider, apiVersion, connectionId, accountExternalId, resolver, objective, creativeFormat,
  accountPlacementAllowlist = [], advertisingCategory = "GENERAL", providerMetadata = {},
  radiusRules = { min: 1, max: 80 }, placementMode,
} = {}) {
  if (FORBIDDEN_CATEGORIES.has(String(advertisingCategory).toUpperCase()) || providerMetadata.sensitive === true || providerMetadata.protectedCharacteristic === true) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, reasonCode: "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN" });
  if (!Array.isArray(input) || input.length > 200) throw executionError("INVALID_EXECUTION_PLAN", { field: "targeting", reasonCode: "INVALID_TARGETING_COLLECTION" });
  const parsed = input.map((criterion, index) => {
    const result = targetingSchema.safeParse(sanitizeExecutionJson(criterion, "intent"));
    if (!result.success) throw executionError("INVALID_EXECUTION_PLAN", { field: `targeting.${index}`, reasonCode: "INVALID_TYPED_TARGETING", issues: result.error.issues });
    return result.data;
  });
  const seen = new Map();
  const resolved = [];
  for (const criterion of parsed) {
    if (criterion.type === "LOCATION") {
      if (criterion.locationType === "RADIUS" && (!criterion.radius || criterion.radius.value < radiusRules.min || criterion.radius.value > radiusRules.max)) throw executionError("INVALID_EXECUTION_PLAN", { field: criterion.clientReference, reasonCode: "LOCATION_RADIUS_UNSUPPORTED" });
      if (criterion.locationType !== "RADIUS" && criterion.radius) throw executionError("INVALID_EXECUTION_PLAN", { field: criterion.clientReference, reasonCode: "LOCATION_RADIUS_TYPE_MISMATCH" });
    }
    if (criterion.type === "KEYWORD" && /[\u0000-\u001f<>]/.test(criterion.value)) throw executionError("INVALID_EXECUTION_PLAN", { field: criterion.clientReference, reasonCode: "KEYWORD_SYMBOLS_UNSUPPORTED" });
    if (criterion.type === "PLACEMENT") {
      if (placementMode && criterion.mode !== placementMode) throw executionError("INVALID_EXECUTION_PLAN", { field: criterion.clientReference, reasonCode: "MIXED_PLACEMENT_MODE_FORBIDDEN" });
      if (criterion.mode === "MANUAL" && accountPlacementAllowlist.length && !accountPlacementAllowlist.includes(criterion.placement)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, field: criterion.clientReference, reasonCode: "PLACEMENT_NOT_ALLOWLISTED" });
    }
    const materialValue = criterion.type === "KEYWORD" ? criterion.value.normalize("NFC").trim().toLocaleLowerCase("en-US") : String(criterion.value || criterion.query || criterion.placement).normalize("NFC").trim().toLowerCase();
    const conflictKey = JSON.stringify([criterion.type, materialValue, criterion.matchType || null, criterion.scope || null]);
    const polarity = criterion.type === "KEYWORD" ? Boolean(criterion.negative) : Boolean(criterion.excluded);
    if (seen.has(conflictKey)) {
      if (seen.get(conflictKey) !== polarity) throw executionError("INVALID_EXECUTION_PLAN", { field: criterion.clientReference, reasonCode: "TARGETING_INCLUDE_EXCLUDE_CONFLICT" });
      throw executionError("INVALID_EXECUTION_PLAN", { field: criterion.clientReference, reasonCode: "DUPLICATE_TARGETING_CRITERION" });
    }
    seen.set(conflictKey, polarity);
    let discovery = null;
    if (["LOCATION", "LANGUAGE", "INTEREST"].includes(criterion.type)) {
      if (typeof resolver !== "function") throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, reasonCode: "TARGETING_DISCOVERY_REQUIRED" });
      discovery = await resolver({ provider, apiVersion, connectionId, accountExternalId, criterion, objective, creativeFormat });
      if (!discovery?.normalizedId || !discovery?.nativeId) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider, field: criterion.clientReference, reasonCode: "TARGETING_VALUE_UNRESOLVED" });
    }
    resolved.push(Object.freeze({ ...criterion, normalizedId: discovery?.normalizedId || materialValue, nativeId: discovery?.nativeId || null, displayName: discovery?.displayName || criterion.query || criterion.value || criterion.placement }));
  }
  return Object.freeze(resolved);
}

module.exports = { targetingSchema, FORBIDDEN_CATEGORIES, resolveTargetingCriteria };
