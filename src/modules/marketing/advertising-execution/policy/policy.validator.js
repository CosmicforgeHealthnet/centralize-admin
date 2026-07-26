const { z } = require("zod");
const { executionError } = require("../execution.errors");

const emergencyOverrideSchema = z.object({
  reason: z.string().trim().min(20).max(2000),
  scope: z.object({
    provider: z.string().trim().min(1).optional(),
    connectionId: z.string().uuid().optional(),
    planId: z.string().uuid().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Override scope cannot be empty"),
  controlsBypassed: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
}).strict();

function validateEmergencyOverride(value) {
  const parsed = emergencyOverrideSchema.safeParse(value);
  if (!parsed.success) {
    throw executionError("APPROVAL_REASON_REQUIRED", {
      issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

module.exports = { emergencyOverrideSchema, validateEmergencyOverride };
