const { z } = require("zod");
const { validateBody, validateQuery } = require("../hrm.utils");

const money = z.union([z.string(), z.number(), z.null()]).optional();

const payrollUpdateSchema = z
  .object({
    month: z.union([z.string(), z.number()]),
    year: z.union([z.string(), z.number()]),
    totalSalary: money,
    totalAllowance: money,
    totalBonus: money,
    totalDeductions: money,
    paymentMethod: z.string().trim().optional().nullable(),
    bankName: z.string().trim().optional().nullable(),
    bankAccount: z.string().trim().optional().nullable(),
  })
  .strict();

const payrollListQuerySchema = z
  .object({
    page: z.string().trim().regex(/^\d+$/).refine((v) => Number(v) > 0).optional(),
    limit: z.string().trim().regex(/^\d+$/).refine((v) => Number(v) > 0).optional(),
    status: z.enum(["Paid", "Pending", "PAID", "PENDING"]).optional(),
  })
  .passthrough();

module.exports = {
  payrollListQuerySchema,
  payrollUpdateSchema,
  validateBody,
  validateQuery,
};
