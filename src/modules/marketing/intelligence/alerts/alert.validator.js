const { z } = require("zod");
const { uuidSchema, calendarDateSchema } = require("../validation-security");

const PLATFORM = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];
const TYPES = ["CPA_TARGET_BREACH", "SPEND_WITHOUT_CONVERSION", "CONVERSION_RATE_DROP", "CREATIVE_FATIGUE", "SYNC_STALE", "CAMPAIGN_PERFORMANCE_DROP", "HIGH_PERFORMING_CAMPAIGN", "TOKEN_REFRESH_FAILED", "CONNECTION_DEGRADED", "PLATFORM_PERMISSION_ERROR"];
const date = calendarDateSchema;

const alertListSchema = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]).optional(),
  type: z.enum(TYPES).optional(),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional(),
  platform: z.enum(PLATFORM).optional(),
  connectionId: uuidSchema.optional(),
  campaignExternalId: z.string().trim().min(1).max(255).optional(),
  creativeAssetId: uuidSchema.optional(),
  triggeredFrom: date.optional(), triggeredTo: date.optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["newest", "oldest"]).default("newest"),
}).strict().superRefine((value, ctx) => {
  if (value.triggeredFrom && value.triggeredTo) {
    if (value.triggeredFrom > value.triggeredTo) ctx.addIssue({ code: "custom", path: ["triggeredTo"], message: "must not precede triggeredFrom" });
    if ((new Date(value.triggeredTo) - new Date(value.triggeredFrom)) / 86400000 + 1 > 366) ctx.addIssue({ code: "custom", path: ["triggeredTo"], message: "range must not exceed 366 days" });
  }
});

const alertEvaluateSchema = z.object({
  platform: z.union([z.literal("all"), z.enum(PLATFORM)]).default("all"),
  connectionId: uuidSchema.optional(), from: date.optional(), to: date.optional(),
  types: z.array(z.enum(TYPES)).min(1).max(TYPES.length).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) ctx.addIssue({ code: "custom", path: ["to"], message: "must not precede from" });
  if (value.from && value.to && (new Date(value.to) - new Date(value.from)) / 86400000 > 366) ctx.addIssue({ code: "custom", path: ["to"], message: "range must not exceed 366 days" });
});

const alertResolveSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

module.exports = { TYPES, alertListSchema, alertEvaluateSchema, alertResolveSchema };
