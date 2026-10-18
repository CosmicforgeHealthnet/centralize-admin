const { z } = require("zod");
const { canonicalJson } = require("../creative/creative.connector.interface");
const { uuidSchema, calendarDateSchema, inspectJson: inspectBoundedJson } = require("../validation-security");

const PLATFORMS = ["META", "TIKTOK", "X", "LINKEDIN", "GOOGLE_ADS"];
const METRICS = ["CTR", "CPC", "CPA", "CONVERSION_RATE"];
const SECRET_KEY = /token|secret|authorization|credential|cookie|signature|api.?key|client.?secret|oauth|password/i;
const EXECUTABLE_KEY = /script|command|executable|function|callback|shell/i;
const SECRET_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./i;
const EXECUTABLE_VALUE = /<script|javascript:|function\s*\(|=>|powershell|cmd\.exe|\/bin\/(?:ba)?sh/i;
const FORBIDDEN_KEY = new Set(["accesstoken", "refreshtoken", "authorization", "cookie", "clientsecret", "apikey", "password", "privatekey", "__proto__", "prototype", "constructor", "script", "function", "eval", "command", "providerwrite", "mutation"]);
const SIGNIFICANCE_CLAIM = /statistically\s+significant|statistical\s+significance|\b\d{2}(?:\.\d+)?%\s+confidence\b|\bp\s*[- ]?value\b|confidence\s+interval/i;
const date = calendarDateSchema;

function inspectJson(value, ctx, path = [], depth = 0) {
  if (depth > 6) { ctx.addIssue({ code: "custom", path, message: "JSON nesting cannot exceed 6 levels" }); return; }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) ctx.addIssue({ code: "custom", path, message: "Numbers must be finite" }); return; }
  if (typeof value === "string") {
    if (value.length > 4000) ctx.addIssue({ code: "custom", path, message: "String value is too long" });
    if (SECRET_VALUE.test(value)) ctx.addIssue({ code: "custom", path, message: "Secret-like values are not allowed" });
    if (EXECUTABLE_VALUE.test(value)) ctx.addIssue({ code: "custom", path, message: "Executable content is not allowed" });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) ctx.addIssue({ code: "custom", path, message: "Arrays cannot exceed 100 entries" });
    value.forEach((child, index) => inspectJson(child, ctx, [...path, index], depth + 1));
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) { ctx.addIssue({ code: "custom", path, message: "Only JSON values are allowed" }); return; }
  const entries = Object.entries(value);
  if (entries.length > 100) ctx.addIssue({ code: "custom", path, message: "Objects cannot exceed 100 fields" });
  for (const [key, child] of entries) {
    if (key.length > 100) ctx.addIssue({ code: "custom", path: [...path, key], message: "Field name is too long" });
    const normalizedKey = key.replace(/[^a-z0-9_]/gi, "").toLowerCase();
    if (FORBIDDEN_KEY.has(normalizedKey) || SECRET_KEY.test(key)) ctx.addIssue({ code: "custom", path: [...path, key], message: "Secret-bearing or unsafe fields are not allowed" });
    if (FORBIDDEN_KEY.has(normalizedKey) || EXECUTABLE_KEY.test(key)) ctx.addIssue({ code: "custom", path: [...path, key], message: "Executable or mutation fields are not allowed" });
    inspectJson(child, ctx, [...path, key], depth + 1);
  }
}

const variantSchema = z.any().superRefine((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) { ctx.addIssue({ code: "custom", message: "Variant must be a JSON object" }); return; }
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_error) { ctx.addIssue({ code: "custom", message: "Variant must be serializable JSON" }); return; }
  if (Buffer.byteLength(serialized, "utf8") > 16384) ctx.addIssue({ code: "custom", message: "Variant cannot exceed 16 KB" });
  inspectJson(value, ctx);
  try { inspectBoundedJson(value, { field: "variant", maxBytes: 16384, maxDepth: 6, maxFields: 100, maxArray: 100, maxString: 4000 }); }
  catch (error) { ctx.addIssue({ code: "custom", message: error.errors?.[0]?.message || error.message }); }
}).transform((value) => JSON.parse(canonicalJson(value)));

function pairRefinement(value, ctx) {
  if (value.variantAConfig !== undefined && value.variantBConfig !== undefined && canonicalJson(value.variantAConfig) === canonicalJson(value.variantBConfig)) ctx.addIssue({ code: "custom", path: ["variantBConfig"], message: "Variants must differ" });
}

const experimentCreateSchema = z.object({
  name: z.string().trim().min(1).max(255), hypothesis: z.string().trim().min(5).max(4000), metric: z.enum(METRICS),
  variantAConfig: variantSchema, variantBConfig: variantSchema,
  platform: z.enum(PLATFORMS).optional(), connectionId: uuidSchema.optional(), campaignExternalId: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine(pairRefinement);

const experimentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(), hypothesis: z.string().trim().min(5).max(4000).optional(), metric: z.enum(METRICS).optional(),
  variantAConfig: variantSchema.optional(), variantBConfig: variantSchema.optional(), platform: z.enum(PLATFORMS).nullable().optional(), connectionId: uuidSchema.nullable().optional(), campaignExternalId: z.string().trim().min(1).max(255).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one editable field is required").superRefine(pairRefinement);

const metricResult = z.object({ sampleSize: z.number().int().min(1).max(1000000000), metricValue: z.string().regex(/^-?(?:\d+)(?:\.\d{1,18})?$/).max(80) }).strict();
const experimentResultSchema = z.object({
  variantA: metricResult, variantB: metricResult, winner: z.enum(["A", "B", "TIE", "INCONCLUSIVE"]),
  confidenceNote: z.string().trim().max(1000).optional(), dataSource: z.string().trim().min(1).max(255),
  analysisWindow: z.object({ from: date, to: date }).strict(), significanceMethod: z.string().trim().min(3).max(255).optional(), significanceEvidence: z.string().trim().min(3).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.analysisWindow.from > value.analysisWindow.to) ctx.addIssue({ code: "custom", path: ["analysisWindow", "to"], message: "must not precede from" });
  if (SIGNIFICANCE_CLAIM.test(value.confidenceNote || "") && (!value.significanceMethod || !value.significanceEvidence)) ctx.addIssue({ code: "custom", path: ["confidenceNote"], message: "Significance claims require a method and supporting evidence" });
});

const experimentCompleteSchema = z.object({ result: experimentResultSchema, conclusion: z.string().trim().max(4000).nullable().optional() }).strict().superRefine((value, ctx) => {
  if (SIGNIFICANCE_CLAIM.test(value.conclusion || "") && (!value.result.significanceMethod || !value.result.significanceEvidence)) ctx.addIssue({ code: "custom", path: ["conclusion"], message: "Significance claims require a method and supporting evidence" });
});
const experimentCancelSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const experimentListSchema = z.object({
  status: z.enum(["DRAFT", "RUNNING", "COMPLETED", "CANCELLED"]).optional(), metric: z.enum(METRICS).optional(), platform: z.enum(PLATFORMS).optional(), connectionId: uuidSchema.optional(), campaignExternalId: z.string().trim().min(1).max(255).optional(), createdByAdminUserId: uuidSchema.optional(), createdFrom: date.optional(), createdTo: date.optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25), sort: z.enum(["newest", "oldest"]).default("newest"),
}).strict().superRefine((value, ctx) => {
  if (value.createdFrom && value.createdTo) {
    if (value.createdFrom > value.createdTo) ctx.addIssue({ code: "custom", path: ["createdTo"], message: "must not precede createdFrom" });
    if ((new Date(value.createdTo) - new Date(value.createdFrom)) / 86400000 + 1 > 366) ctx.addIssue({ code: "custom", path: ["createdTo"], message: "range must not exceed 366 days" });
  }
});

module.exports = { METRICS, variantSchema, experimentCreateSchema, experimentUpdateSchema, experimentResultSchema, experimentCompleteSchema, experimentCancelSchema, experimentListSchema };
