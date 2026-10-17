const { z } = require("zod");
const { validateBody, validateQuery } = require("../hrm.utils");

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isDateOnly(value) {
  if (!DATE_ONLY_REGEX.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isIsoDateTime(value) {
  if (value === null || value === undefined || value === "") return true;
  return !Number.isNaN(new Date(value).getTime());
}

const dateOnlySchema = z.string().trim().refine(isDateOnly, {
  message: "Use YYYY-MM-DD format.",
});

const positiveIntegerString = z
  .string()
  .trim()
  .regex(/^\d+$/, "Use a positive integer.")
  .refine((value) => Number(value) > 0, "Use a positive integer.");

const optionalIsoDateTimeSchema = z
  .string()
  .trim()
  .refine(isIsoDateTime, { message: "Use a valid ISO datetime." })
  .optional()
  .nullable();

const attendanceStatusSchema = z.enum(["PRESENT", "LATE", "ABSENT"]);
const periodSchema = z.enum(["This Week", "Last Week", "This Month"]);
const uuidSchema = z.string().trim().regex(UUID_REGEX, "Invalid employeeId.");

const attendanceCreateSchema = z
  .object({
    adminUserId: z.string().uuid(),
    date: dateOnlySchema,
    clockIn: optionalIsoDateTimeSchema,
    clockOut: optionalIsoDateTimeSchema,
    status: attendanceStatusSchema,
  })
  .strict();

const attendanceUpdateSchema = z
  .object({
    clockIn: optionalIsoDateTimeSchema,
    clockOut: optionalIsoDateTimeSchema,
    status: attendanceStatusSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

const attendanceStatsQuerySchema = z
  .object({
    date: dateOnlySchema.optional(),
  })
  .passthrough();

const attendanceListQuerySchema = z
  .object({
    page: positiveIntegerString.optional(),
    limit: positiveIntegerString.optional(),
    department: z.string().trim().optional(),
    date: dateOnlySchema.optional(),
    status: attendanceStatusSchema.optional(),
    search: z.string().trim().optional(),
  })
  .passthrough();

const attendanceLogsQuerySchema = z
  .object({
    period: periodSchema.optional(),
  })
  .passthrough();

const attendanceDownloadQuerySchema = z
  .object({
    employeeId: uuidSchema.optional(),
    department: z.string().trim().optional(),
    date: dateOnlySchema.optional(),
  })
  .passthrough();

module.exports = {
  attendanceCreateSchema,
  attendanceDownloadQuerySchema,
  attendanceListQuerySchema,
  attendanceLogsQuerySchema,
  attendanceStatsQuerySchema,
  attendanceUpdateSchema,
  validateBody,
  validateQuery,
};