const { z } = require("zod");
const { DEPARTMENTS, TIERS, validateBody } = require("../hrm.utils");

const optionalString = z.string().trim().min(1).optional().nullable();

// ─── Grant Schemas ──────────────────────────────────────────────────────────

const grantSchema = z.object({
  module: z.string().trim().min(1, "Module is required"),
  section: z.string().trim().min(1, "Section is required"),
  mode: z.enum(["VIEW", "EDIT"]),
  reason: z.string().trim().optional(),
  expiresAt: z.string().trim().optional().nullable(),
});

const createGrantSchema = z.object({
  module: z.string().trim().min(1, "Module is required"),
  section: z.string().trim().min(1, "Section is required"),
  mode: z.enum(["VIEW", "EDIT"]),
  reason: z.string().trim().optional(),
  expiresAt: z.string().trim().optional().nullable(),
});

const syncGrantsSchema = z.object({
  grants: z.array(grantSchema).default([]),
});

// ─── Account Schemas ───────────────────────────────────────────────────────

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
    workPhone: optionalString,
    homePhone: optionalString,
    personalPhone: optionalString,
    // HR onboarding: optionally file a PENDING work-email request for IT.
    mailProvisioning: z
      .object({
        requested: z.boolean(),
        localPart: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._+-]+$/, "Invalid email local part").optional().nullable(),
        domainId: z.string().uuid().optional().nullable(),
      })
      .strict()
      .optional(),
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
    workPhone: optionalString,
    homePhone: optionalString,
    personalPhone: optionalString,
  })
  .strict();

const accountStatusSchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE"]),
    reassignTo: z.string().uuid().optional(),
  })
  .strict();

// ─── Grant Update Schema ───────────────────────────────────────────────────

const updateGrantSchema = z
  .object({
    mode: z.enum(["VIEW", "EDIT"]).optional(),
    reason: z.string().trim().optional(),
    expiresAt: z.string().trim().optional().nullable(),
  })
  .strict();

module.exports = {
  accountCreateSchema,
  accountStatusSchema,
  accountUpdateSchema,
  createGrantSchema,
  syncGrantsSchema,
  updateGrantSchema,
  validateBody,
};
