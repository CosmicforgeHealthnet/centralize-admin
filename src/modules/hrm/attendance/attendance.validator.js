const { z } = require("zod");
const { validateBody } = require("../hrm.utils");

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

const optionalIsoDateTimeSchema = z
  .string()
  .trim()
  .refine(isIsoDateTime, { message: "Use a valid ISO datetime." })
  .optional()
  .nullable();

const attendanceCreateSchema = z
  .object({
    adminUserId: z.string().uuid(),
    date: dateOnlySchema,
    clockIn: optionalIsoDateTimeSchema,
    clockOut: optionalIsoDateTimeSchema,
    status: z.enum(["PRESENT", "LATE", "ABSENT"]),
  })
  .strict();

const attendanceUpdateSchema = z
  .object({
    clockIn: optionalIsoDateTimeSchema,
    clockOut: optionalIsoDateTimeSchema,
    status: z.enum(["PRESENT", "LATE", "ABSENT"]).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

module.exports = {
  attendanceCreateSchema,
  attendanceUpdateSchema,
  validateBody,
};
