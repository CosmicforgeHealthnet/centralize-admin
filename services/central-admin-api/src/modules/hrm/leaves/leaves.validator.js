const { z } = require("zod");
const { validateBody, validateQuery } = require("../hrm.utils");

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const positiveIntegerString = z
  .string()
  .trim()
  .regex(/^\d+$/, "Use a positive integer.")
  .refine((value) => Number(value) > 0, "Use a positive integer.");

const leaveStatusSchema = z.enum(["PENDING", "APPROVED", "DENIED"]);
const monthSchema = z.enum(MONTHS);
const uuidSchema = z.string().trim().regex(UUID_REGEX, "Invalid employeeId.");

const leaveDecisionSchema = z
  .object({
    note: z.string().trim().optional().nullable(),
    reason: z.string().trim().optional().nullable(),
  })
  .strict();

const leavesListQuerySchema = z
  .object({
    page: positiveIntegerString.optional(),
    limit: positiveIntegerString.optional(),
    period: monthSchema.optional(),
    status: leaveStatusSchema.optional(),
  })
  .passthrough();

const leavesDownloadQuerySchema = z
  .object({
    employeeId: uuidSchema.optional(),
    period: monthSchema.optional(),
  })
  .passthrough();

module.exports = {
  leaveDecisionSchema,
  leavesDownloadQuerySchema,
  leavesListQuerySchema,
  validateBody,
  validateQuery,
};