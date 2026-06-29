const { z } = require("zod");
const { DEPARTMENTS, validateBody, validateQuery } = require("../hrm.utils");

const vacancySchema = z
  .object({
    title: z.string().trim().min(1),
    department: z.enum(DEPARTMENTS).optional().nullable(),
    category: z.string().trim().optional().nullable(),
    location: z.string().trim().optional().nullable(),
    numberOfOpening: z.union([z.number().int().positive(), z.string()]).optional().nullable(),
    experienceLevel: z.string().trim().optional().nullable(),
    salaryRange: z.string().trim().optional().nullable(),
    benefitsAndBonus: z.string().trim().optional().nullable(),
    jobDescription: z.string().trim().optional().nullable(),
    responsibilities: z.string().trim().optional().nullable(),
    requirements: z.string().trim().optional().nullable(),
    hiringStages: z.array(z.string()).optional().nullable(),
    assignedRecruiter: z.string().trim().optional().nullable(),
    deadline: z.string().trim().optional().nullable(),
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

const vacanciesQuerySchema = z
  .object({
    page: z.string().trim().regex(/^\d+$/).refine((v) => Number(v) > 0).optional(),
    limit: z.string().trim().regex(/^\d+$/).refine((v) => Number(v) > 0).optional(),
    status: z.enum(["OPEN", "IN_REVIEW", "CLOSED"]).optional(),
    filterBy: z.enum(["Job", "Department", "Category"]).optional(),
    search: z.string().trim().optional(),
  })
  .passthrough();

const applicantsQuerySchema = z
  .object({
    page: z.string().trim().regex(/^\d+$/).refine((v) => Number(v) > 0).optional(),
    limit: z.string().trim().regex(/^\d+$/).refine((v) => Number(v) > 0).optional(),
    stage: z.enum(["All", "SCREENING", "INTERVIEW", "HIRED", "REJECTED"]).optional(),
    search: z.string().trim().optional(),
  })
  .passthrough();

module.exports = {
  applicantStageSchema,
  applicantsQuerySchema,
  vacanciesQuerySchema,
  vacancySchema,
  vacancyStatusSchema,
  validateBody,
  validateQuery,
};
