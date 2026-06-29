const { z } = require("zod");
const { validateBody } = require("../hrm.utils");

const money = z.union([z.string(), z.number(), z.null()]).optional();

const payrollUpdateSchema = z
  .object({
    month: z.union([z.string(), z.number()]),
    year: z.union([z.string(), z.number()]),
    salary: money,
    allowance: money,
    bonus: money,
    deductions: money,
    paymentMethod: z.string().trim().optional().nullable(),
    bank: z.string().trim().optional().nullable(),
  })
  .strict();

module.exports = {
  payrollUpdateSchema,
  validateBody,
};
