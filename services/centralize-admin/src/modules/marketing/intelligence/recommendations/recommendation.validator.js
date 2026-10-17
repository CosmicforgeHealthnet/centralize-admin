const { z } = require("zod");
const { uuidSchema, calendarDateSchema, isoTimestampSchema } = require("../validation-security");
const platform = z.enum(["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"]);
const date = calendarDateSchema;
const listSchema = z.object({
  status: z.enum(["PENDING", "ACCEPTED", "DISMISSED", "EXPIRED", "CONVERTED_TO_TASK"]).optional(),
  type: z.enum(["PAUSE", "SCALE", "REALLOCATE_BUDGET", "CREATE_CONTENT"]).optional(),
  platform: platform.optional(), connectionId: uuidSchema.optional(), targetCampaignExternalId: z.string().trim().min(1).max(255).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(), generatedFrom: date.optional(), generatedTo: date.optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), sort: z.enum(["generatedAt", "confidence", "expiresAt"]).default("generatedAt"),
}).strict().superRefine((value, ctx) => {
  if (value.generatedFrom && value.generatedTo) {
    const days = (Date.parse(`${value.generatedTo}T00:00:00Z`) - Date.parse(`${value.generatedFrom}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1) ctx.addIssue({ code: "custom", path: ["generatedTo"], message: "generatedTo must be on or after generatedFrom" });
    if (days > 366) ctx.addIssue({ code: "custom", path: ["generatedTo"], message: "recommendation query range cannot exceed 366 days" });
  }
});
const evaluateSchema = z.object({ platform: z.union([platform, z.literal("all")]).default("all"), connectionId: uuidSchema.optional(), from: date.optional(), to: date.optional(), ruleTypes: z.array(z.enum(["PAUSE", "SCALE", "REALLOCATE_BUDGET", "CREATE_CONTENT"])).max(4).optional() }).strict().superRefine((value, ctx) => {
  if (value.from && value.to) {
    const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1) ctx.addIssue({ code: "custom", path: ["to"], message: "to must be on or after from" });
    if (days > 366) ctx.addIssue({ code: "custom", path: ["to"], message: "evaluation range cannot exceed 366 days" });
  }
});
const dismissSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const convertToTaskSchema = z.object({
  assigneeAdminUserId: uuidSchema.optional(),
  dueDate: isoTimestampSchema.optional(),
}).strict();
module.exports = { recommendationListSchema: listSchema, recommendationEvaluateSchema: evaluateSchema, recommendationDismissSchema: dismissSchema, recommendationConvertToTaskSchema: convertToTaskSchema };
