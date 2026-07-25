const { z } = require("zod");
const { AD_PLATFORMS } = require("./platforms");
const { SETTING_KEYS } = require("./setting-registry");
const { uuidSchema } = require("./validation-security");

const empty = (value) => value === "" || value === null ? undefined : value;
const boolQuery = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || String(value).toLowerCase() === "true") return true;
  if (value === false || String(value).toLowerCase() === "false") return false;
  return value;
}, z.boolean().optional());
const platform = z.preprocess((value) => value ? String(value).toUpperCase() : undefined, z.enum(AD_PLATFORMS).optional());
const currency = z.preprocess((value) => {
  const normalized = empty(value);
  return normalized === undefined ? undefined : String(normalized).trim().toUpperCase();
}, z.string().regex(/^[A-Z]{3}$/).optional());
const uuid = z.preprocess(empty, uuidSchema.optional());

const settingsQuerySchema = z.object({
  platform,
  connectionId: uuid,
  currencyCode: currency,
  includeConfigured: boolQuery.default(true),
  includeDefaults: boolQuery.default(true),
}).strict();

const settingUpdateSchema = z.object({
  key: z.enum(SETTING_KEYS),
  scope: z.enum(["GLOBAL", "PLATFORM", "CONNECTION"]),
  platform,
  connectionId: uuid,
  currencyCode: currency,
  value: z.union([z.boolean(), z.number(), z.string().max(255), z.null()]),
  expectedVersion: z.number().int().min(0),
}).strict();

const settingsPatchSchema = z.object({ updates: z.array(settingUpdateSchema).min(1).max(50) }).strict();

module.exports = { settingsQuerySchema, settingUpdateSchema, settingsPatchSchema };
