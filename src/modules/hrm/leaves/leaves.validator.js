const { z } = require("zod");
const { validateBody } = require("../hrm.utils");

const leaveDecisionSchema = z
  .object({
    note: z.string().trim().optional().nullable(),
    reason: z.string().trim().optional().nullable(),
  })
  .strict();

module.exports = {
  leaveDecisionSchema,
  validateBody,
};
