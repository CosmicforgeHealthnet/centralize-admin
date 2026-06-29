const { z } = require("zod");
const { DEPARTMENTS, validateBody } = require("../hrm.utils");

const vacancySchema = z
  .object({
    title: z.string().trim().min(1),
    department: z.enum(DEPARTMENTS).optional().nullable(),
    category: z.string().trim().optional().nullable(),
    employmentType: z.string().trim().optional().nullable(),
    location: z.string().trim().optional().nullable(),
    description: z.string().trim().optional().nullable(),
    requirements: z.string().trim().optional().nullable(),
    salaryRange: z.string().trim().optional().nullable(),
    closingDate: z.string().trim().optional().nullable(),
    status: z.enum(["OPEN", "IN_REVIEW", "CLOSED"]).optional(),
  })
  .strict();

const vacancyStatusSchema = z
  .object({
    status: z.enum(["OPEN", "IN_REVIEW", "CLOSED"]),
  })
  .strict();

const applicantStageSchema = z
  .object({
    stage: z.enum(["SCREENING", "INTERVIEW", "HIRED", "REJECTED"]),
  })
  .strict();

module.exports = {
  applicantStageSchema,
  vacancySchema,
  vacancyStatusSchema,
  validateBody,
};
