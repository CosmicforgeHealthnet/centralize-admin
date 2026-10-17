const { z } = require("zod");
const { DEPARTMENTS, validateBody } = require("../hrm.utils");

const nullableString = z.string().trim().optional().nullable();
const optionalDate = z.string().trim().optional().nullable();
const optionalDecimal = z.union([z.string(), z.number(), z.null()]).optional();

const employeePersonalSchema = z
  .object({
    name: z.string().trim().min(2).optional(),
    preferredName: nullableString,
    birthday: optionalDate,
    nationality: nullableString,
    gender: nullableString,
    maritalStatus: nullableString,
  })
  .strict();

const employeeContactSchema = z
  .object({
    workPhone: nullableString,
    homePhone: nullableString,
    personalPhone: nullableString,
    fax: nullableString,
    address: nullableString,
    state: nullableString,
    country: nullableString,
  })
  .strict();

const employeeEmploymentSchema = z
  .object({
    position: nullableString,
    department: z.enum(DEPARTMENTS).optional().nullable(),
    employmentType: nullableString,
    employmentCategory: nullableString,
    location: nullableString,
    isTeamLead: z.boolean().optional(),
    tier: z.enum(["SUPER", "EXECUTIVE", "ADMIN", "EMPLOYEE"]).optional(),
    status: z.enum(["ACTIVE", "INACTIVE", "LOCKED", "PENDING"]).optional(),
  })
  .strict();

const employeeEmergencySchema = z
  .object({
    emergencyName: nullableString,
    emergencyPhone: nullableString,
    emergencyEmail: z.string().trim().email().optional().nullable(),
    emergencyRelation: nullableString,
  })
  .strict();

const employeeSocialSchema = z
  .object({
    links: z
      .array(
        z
          .object({
            platform: z.string().trim().min(1),
            username: z.string().trim().min(1),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();

const employeeSensitiveSchema = z
  .object({
    salary: optionalDecimal,
    bonus: optionalDecimal,
    equity: optionalDecimal,
  })
  .strict();

const employeeEducationSchema = z
  .object({
    degreeTitle: z.string().trim().min(1),
    institution: z.string().trim().min(1),
    from: nullableString,
    to: nullableString,
  })
  .strict();

module.exports = {
  employeeContactSchema,
  employeeEducationSchema,
  employeeEmergencySchema,
  employeeEmploymentSchema,
  employeePersonalSchema,
  employeeSensitiveSchema,
  employeeSocialSchema,
  validateBody,
};
