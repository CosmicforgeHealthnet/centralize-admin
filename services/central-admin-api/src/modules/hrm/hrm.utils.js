const { Readable } = require("stream");
const ApiError = require("../../shared/utils/ApiError");
const cloudinary = require("../../shared/config/cloudinary");

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const DEPARTMENTS = [
  "FINANCE",
  "DEVELOPMENT",
  "CUSTOMER_CARE",
  "MARKETING",
  "SOCIAL_MEDIA",
  "EXECUTIVE",
  "MANAGEMENT",
];

const TIERS = ["SUPER", "EXECUTIVE", "ADMIN", "EMPLOYEE"];
const SENSITIVE_TIERS = ["SUPER", "EXECUTIVE"];

function parsePositiveInteger(value, fieldName, defaultValue, max = 100) {
  if (value === undefined || value === null || value === "") return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(400, `Invalid ${fieldName}. Use a positive integer.`);
  }

  return max ? Math.min(parsed, max) : parsed;
}

function paginate(query = {}, defaultLimit = 10, maxLimit = 100) {
  const page = parsePositiveInteger(query.page, "page", 1, 100000);
  const limit = parsePositiveInteger(query.limit, "limit", defaultLimit, maxLimit);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function buildMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

function formatEnumLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function assertUuid(value, fieldName = "id") {
  if (!value || !UUID_REGEX.test(String(value))) {
    throw new ApiError(400, `Invalid ${fieldName}.`);
  }
  return String(value);
}

function normalizeEnum(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!allowedValues.includes(normalized)) {
    throw new ApiError(400, `Invalid ${fieldName}.`);
  }
  return normalized;
}

function normalizeDepartment(value) {
  return normalizeEnum(value, DEPARTMENTS, "department");
}

function normalizeTier(value) {
  return normalizeEnum(value, TIERS, "tier");
}

function isSensitiveTier(adminUser) {
  return SENSITIVE_TIERS.includes(adminUser?.tier);
}

function assertSensitiveTier(adminUser) {
  if (!isSensitiveTier(adminUser)) {
    throw new ApiError(403, "You do not have permission to access sensitive HRM data");
  }
}

function assertSelfOrTier(adminUser, employeeId, minimumTier = "ADMIN") {
  const hierarchy = ["EMPLOYEE", "ADMIN", "EXECUTIVE", "SUPER"];
  const current = hierarchy.indexOf(adminUser?.tier);
  const required = hierarchy.indexOf(minimumTier);
  if (adminUser?.id === employeeId || current >= required) return;

  throw new ApiError(403, "You do not have permission to access this employee");
}

function pickDefined(source, allowedKeys) {
  const picked = {};
  for (const key of allowedKeys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function parseDate(value, fieldName = "date") {
  if (value === undefined || value === null || value === "") return undefined;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `Invalid ${fieldName} format.`);
  }

  return date;
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseDateOnly(value, fieldName = "date") {
  if (value === undefined || value === null || value === "") return undefined;

  const text = String(value).trim();
  if (!DATE_ONLY_REGEX.test(text)) {
    throw new ApiError(400, `Invalid ${fieldName}. Use YYYY-MM-DD format.`);
  }

  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ApiError(400, `Invalid ${fieldName}. Use YYYY-MM-DD format.`);
  }

  return date;
}

function dateOnlyRange(value, fieldName = "date", fallback = new Date()) {
  const start = parseDateOnly(value, fieldName) || startOfUtcDay(fallback);
  return {
    start,
    end: addUtcDays(start, 1),
  };
}

function formatDateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function formatSlashDate(value) {
  if (!value) return null;
  const date = new Date(value);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function formatTime(value, { compact = true } = {}) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const text = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date);

  return compact ? text.replace(/\s/g, "") : text;
}

function averageMinutesFromDates(values) {
  const minutes = values
    .filter(Boolean)
    .map((value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return date.getUTCHours() * 60 + date.getUTCMinutes();
    })
    .filter((value) => value !== null);

  if (!minutes.length) return null;
  return Math.round(minutes.reduce((sum, value) => sum + value, 0) / minutes.length);
}

function formatMinutesAsTime(minutes, { compact = false } = {}) {
  if (minutes === null || minutes === undefined) return null;
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const date = new Date(Date.UTC(2000, 0, 1, 0, normalized, 0));
  return formatTime(date, { compact });
}

function percentageChange(current, previous) {
  if (!previous) return "0%";
  const value = Math.round(((current - previous) / previous) * 100);
  return `${value > 0 ? "+" : ""}${value}%`;
}

function decimalInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new ApiError(400, "Invalid decimal value.");
  }

  return String(numberValue);
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues || result.error.errors || [];
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const issues = result.error.issues || result.error.errors || [];
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    return next();
  };
}
function validateMultipartBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues || result.error.errors || [];
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    req.body = result.data;
    next();
  };
}

function multerSingle(upload, fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (error) => {
      if (!error) return next();

      if (error.code === "LIMIT_FILE_SIZE") {
        return next(new ApiError(400, "Uploaded file exceeds the allowed size"));
      }

      return next(error instanceof ApiError ? error : new ApiError(400, error.message));
    });
  };
}

async function uploadBufferToCloudinary(file, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(new ApiError(500, "File upload failed"));
      resolve(result);
    });

    const readable = new Readable();
    readable.push(file.buffer);
    readable.push(null);
    readable.pipe(stream);
  });
}

async function destroyCloudinaryResource(publicId, resourceType = "auto") {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function buildCsv(headers, rows) {
  const lines = [
    headers.map(({ label }) => csvEscape(label)).join(","),
    ...rows.map((row) => headers.map(({ key }) => csvEscape(row[key])).join(",")),
  ];

  return lines.join("\n");
}

function unsupportedEndpoint(moduleName, missingModels) {
  const modelText = missingModels.join(", ");
  throw new ApiError(
    501,
    `${moduleName} endpoint is not supported by the current Prisma schema. Missing model(s): ${modelText}.`,
  );
}

function safeLower(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = {
  DEPARTMENTS,
  TIERS,
  SENSITIVE_TIERS,
  addUtcDays,
  assertSelfOrTier,
  assertSensitiveTier,
  assertUuid,
  averageMinutesFromDates,
  buildCsv,
  buildMeta,
  dateOnlyRange,
  decimalInput,
  destroyCloudinaryResource,
  formatDateOnly,
  formatEnumLabel,
  formatMinutesAsTime,
  formatSlashDate,
  formatTime,
  isSensitiveTier,
  multerSingle,
  normalizeDepartment,
  normalizeEnum,
  normalizeTier,
  numberOrNull,
  paginate,
  parseDate,
  parseDateOnly,
  percentageChange,
  pickDefined,
  safeLower,
  startOfUtcDay,
  unsupportedEndpoint,
  uploadBufferToCloudinary,
  validateBody,
  validateQuery,
  validateMultipartBody,
};

