const { z } = require("zod");
const { sanitizePlainText } = require("../../intelligence/validation-security");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");

const normalizedErrorSchema = z.object({
  code: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1000),
  retryable: z.boolean(),
  retryAfterAt: z.string().datetime({ offset: true }).nullable(),
  providerCode: z.string().trim().max(100).nullable(),
  fieldPath: z.string().trim().max(500).nullable(),
}).strict();

const normalizedResultSchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  providerRequestId: z.string().trim().max(255).nullable(),
  nativeResourceId: z.string().trim().max(512).nullable(),
  nativeResourceName: z.string().trim().max(512).nullable(),
  retryable: z.boolean(),
  outcomeCertain: z.boolean(),
  error: normalizedErrorSchema.nullable(),
  warnings: z.array(z.string().trim().max(500)).max(20),
  returnedState: z.record(z.string(), z.unknown()),
}).strict().superRefine((result, ctx) => {
  if (result.status === "UNKNOWN" && result.outcomeCertain) ctx.addIssue({ code: "custom", path: ["outcomeCertain"], message: "UNKNOWN outcomes cannot be certain" });
  if (["SUCCEEDED", "FAILED"].includes(result.status) && !result.outcomeCertain) ctx.addIssue({ code: "custom", path: ["outcomeCertain"], message: "Known outcomes must be certain" });
  if (result.status === "SUCCEEDED" && result.error) ctx.addIssue({ code: "custom", path: ["error"], message: "Successful results cannot include an error" });
  if (result.status !== "SUCCEEDED" && !result.error) ctx.addIssue({ code: "custom", path: ["error"], message: "Failed or unknown results require a normalized error" });
});

function safeCorrelationId(value, maximum = 512) {
  if (value == null) return null;
  return sanitizePlainText(String(value).replace(/[^a-zA-Z0-9._:\/-]/g, ""), maximum) || null;
}

function safeErrorMessage(value) {
  return (sanitizePlainText(value || "Provider operation unavailable", 1000) || "Provider operation unavailable")
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|developer[_-]?token|api[_-]?key|password)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/)[0]}=<redacted>`);
}

function normalizeContractError(error = {}) {
  const retryAfter = error.retryAfterAt instanceof Date ? error.retryAfterAt.toISOString() : error.retryAfterAt || null;
  return {
    code: safeCorrelationId(error.code, 100) || "PROVIDER_ERROR",
    category: safeCorrelationId(error.category, 100) || "PROVIDER_UNAVAILABLE",
    message: safeErrorMessage(error.message),
    retryable: Boolean(error.retryable),
    retryAfterAt: retryAfter,
    providerCode: safeCorrelationId(error.providerCode, 100),
    fieldPath: sanitizePlainText(error.fieldPath, 500),
  };
}

function validateNormalizedResult(value) {
  const sanitized = sanitizeExecutionJson(value, "normalizedResult");
  const parsed = normalizedResultSchema.safeParse(sanitized);
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "normalizedResult", reasonCode: "INVALID_NORMALIZED_RESULT", issues: parsed.error.issues });
  return parsed.data;
}

function createNormalizedResult({
  status,
  providerRequestId = null,
  nativeResourceId = null,
  nativeResourceName = null,
  retryable = false,
  outcomeCertain = status !== "UNKNOWN",
  error = null,
  warnings = [],
  returnedState = {},
}) {
  return validateNormalizedResult({
    status,
    providerRequestId: safeCorrelationId(providerRequestId, 255),
    nativeResourceId: safeCorrelationId(nativeResourceId),
    nativeResourceName: safeCorrelationId(nativeResourceName),
    retryable: Boolean(retryable),
    outcomeCertain: Boolean(outcomeCertain),
    error: error ? normalizeContractError(error) : null,
    warnings: warnings.map((warning) => sanitizePlainText(warning, 500) || "").filter(Boolean),
    returnedState,
  });
}

module.exports = {
  normalizedErrorSchema,
  normalizedResultSchema,
  normalizeContractError,
  safeErrorMessage,
  validateNormalizedResult,
  createNormalizedResult,
};
