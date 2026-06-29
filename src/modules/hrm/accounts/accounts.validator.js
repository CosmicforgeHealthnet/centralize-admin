const { z } = require("zod");
const { DEPARTMENTS, TIERS, validateBody } = require("../hrm.utils");

const optionalString = z.string().trim().min(1).optional().nullable();

const accountCreateSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters"),
    email: z.string().trim().email("Invalid email address"),
    position: optionalString,
    department: z.enum(DEPARTMENTS).optional().nullable(),
    tier: z.enum(TIERS).default("EMPLOYEE"),
    isTeamLead: z.boolean().optional(),
    employmentType: optionalString,
    employmentCategory: optionalString,
    location: optionalString,
  })
  .strict();

const accountUpdateSchema = z
  .object({
    name: z.string().trim().min(2).optional(),
    email: z.string().trim().email().optional(),
    position: optionalString,
    department: z.enum(DEPARTMENTS).optional().nullable(),
    tier: z.enum(TIERS).optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "LOCKED", "PENDING"]).optional(),
    isTeamLead: z.boolean().optional(),
    employmentType: optionalString,
    employmentCategory: optionalString,
    location: optionalString,
  })
  .strict();

const accountStatusSchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE"]),
  })
  .strict();

module.exports = {
  accountCreateSchema,
  accountStatusSchema,
  accountUpdateSchema,
  validateBody,
};
