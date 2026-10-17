const { z } = require("zod");
const { AD_PLATFORMS } = require("./platforms");
const { uuidSchema, calendarDateSchema } = require("./validation-security");

const empty = (value) => value === "" || value === null ? undefined : value;
const date = z.preprocess(empty, calendarDateSchema.optional());
const runListSchema = z.object({
  type: z.preprocess(empty, z.enum(["SYNC", "CONNECTION_TEST", "VALIDATION", "CREATIVE_SYNC", "SCORE", "RECOMMEND", "ALERT", "FULL_EVALUATION"]).optional()),
  trigger: z.preprocess(empty, z.string().trim().max(100).optional()),
  status: z.preprocess(empty, z.enum(["STARTED", "SUCCEEDED", "PARTIALLY_SUCCEEDED", "FAILED", "SKIPPED_LOCKED", "LOCK_RENEWAL_FAILED", "PARTIAL_SUCCESS"]).optional()),
  platform: z.preprocess((value) => value ? String(value).toUpperCase() : undefined, z.enum(AD_PLATFORMS).optional()),
  connectionId: z.preprocess(empty, uuidSchema.optional()),
  from: date, to: date,
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(["startedAt", "completedAt", "createdAt", "status", "runType"]).default("startedAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
}).strict()
  .refine((data) => !data.from || !data.to || data.from <= data.to, { path: ["from"], message: "from must not be later than to" })
  .refine((data) => !data.from || !data.to || (new Date(data.to) - new Date(data.from)) / 86400000 + 1 <= 366, { path: ["to"], message: "run query range cannot exceed 366 days" });

module.exports = { runListSchema };
