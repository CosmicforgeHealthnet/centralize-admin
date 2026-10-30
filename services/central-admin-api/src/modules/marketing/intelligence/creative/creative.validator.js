const { z } = require("zod");
const { uuidSchema, calendarDateSchema } = require("../validation-security");

const platform = z.enum(["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]);
const date = calendarDateSchema;

function rangeDays(since, until) {
  return Math.floor((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000) + 1;
}

const creativeListQuerySchema = z.object({
  platform: z.union([platform, z.literal("all")]).default("all"),
  connectionId: uuidSchema.optional(),
  accountExternalId: z.string().trim().min(1).max(255).optional(),
  campaignExternalId: z.string().trim().min(1).max(255).optional(),
  creativeType: z.enum(["IMAGE", "VIDEO", "CAROUSEL", "TEXT", "RESPONSIVE", "OTHER", "UNKNOWN"]).optional(),
  status: z.string().trim().min(1).max(100).optional(),
  firstSeenFrom: date.optional(),
  lastSeenTo: date.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["lastSeenAt", "firstSeenAt", "name"]).default("lastSeenAt"),
}).strict().superRefine((value, ctx) => {
  if (value.firstSeenFrom && value.lastSeenTo) {
    const days = rangeDays(value.firstSeenFrom, value.lastSeenTo);
    if (days < 1) ctx.addIssue({ code: "custom", path: ["lastSeenTo"], message: "lastSeenTo must be on or after firstSeenFrom" });
    if (days > 366) ctx.addIssue({ code: "custom", path: ["lastSeenTo"], message: "creative query range cannot exceed 366 days" });
  }
});

const creativeSyncSchema = z.object({
  since: date.optional(),
  until: date.optional(),
  platforms: z.array(platform).min(1).max(5).optional(),
  connectionIds: z.array(uuidSchema).min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.since && value.until && value.since > value.until) {
    ctx.addIssue({ code: "custom", path: ["until"], message: "until must be on or after since" });
  }
  if (value.since && value.until && rangeDays(value.since, value.until) > 366) {
    ctx.addIssue({ code: "custom", path: ["until"], message: "creative sync date range cannot exceed 366 days" });
  }
});

const creativeScoreSchema = z.object({
  platform: z.union([platform, z.literal("all")]).default("all"),
  connectionIds: z.array(uuidSchema).min(1).max(100).optional(),
  creativeAssetIds: z.array(uuidSchema).min(1).max(500).optional(),
  since: date.optional(),
  until: date.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.since && value.until) {
    const days = rangeDays(value.since, value.until);
    if (days <= 0) ctx.addIssue({ code: "custom", path: ["until"], message: "until must be on or after since" });
    if (days > 366) ctx.addIssue({ code: "custom", path: ["until"], message: "score date range cannot exceed 366 days" });
  }
});

const scoreListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

module.exports = { creativeListQuerySchema, creativeSyncSchema, creativeScoreSchema, scoreListQuerySchema };
