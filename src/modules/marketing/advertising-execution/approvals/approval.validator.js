const { z } = require("zod");
const { executionError } = require("../execution.errors");

const approvalInputSchema = z.object({
  planVersion: z.number().int().min(1),
  validationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

function validateApprovalInput(value) {
  const parsed = approvalInputSchema.safeParse(value);
  if (!parsed.success) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "INVALID_APPROVAL_INPUT", issues: parsed.error.issues });
  return parsed.data;
}

module.exports = { approvalInputSchema, validateApprovalInput };
