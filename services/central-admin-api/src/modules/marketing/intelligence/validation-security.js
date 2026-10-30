const { z } = require("zod");
const ApiError = require("../../../shared/utils/ApiError");
const { sanitizeSecretSafe, isSecretKey } = require("../social-operations/security/secret-safe-serializer");

const MAX_UUID_LENGTH = 64;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_FIELDS = 100;
const MAX_JSON_ARRAY = 200;
const MAX_JSON_STRING = 4000;

const FORBIDDEN_JSON_KEYS = new Set([
  "__proto__", "prototype", "constructor", "accesstoken", "refreshtoken",
  "authorization", "cookie", "clientsecret", "apikey", "password", "privatekey",
]);

const PRIVATE_RESPONSE_KEY = /^(?:raw(?:json|payload|providerpayload|providerresponse|providerrecord)?|providerrawpayload|lockowner|lockownertoken|lockownerhash|credentials?|credentialciphertext|credentialenvelope|encryptedcredentials|encryptionmetadata|databaseurl|stack)$/i;

function normalizedKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function validationError(field, message) {
  return new ApiError(400, "Validation failed", [{ code: "VALIDATION_ERROR", field, message }]);
}

const uuidSchema = z.string()
  .max(MAX_UUID_LENGTH)
  .refine((value) => value === value.trim() && value.length > 0, "UUID must not be empty or contain surrounding whitespace")
  .uuid("Use a valid UUID");

function assertUuid(value, field = "id", { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return value;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw validationError(field, parsed.error.issues[0]?.message || "Use a valid UUID");
  return parsed.data;
}

const calendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "Use a valid calendar date");

const isoTimestampSchema = z.string().max(64)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/, "Use an ISO-8601 timestamp with an explicit timezone")
  .refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (!match) return false;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const parsedDay = new Date(Date.UTC(year, month - 1, day));
    return parsedDay.getUTCFullYear() === year && parsedDay.getUTCMonth() === month - 1 && parsedDay.getUTCDate() === day
      && hour <= 23 && minute <= 59 && second <= 59;
  }, "Use a valid calendar timestamp")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Use a valid ISO-8601 timestamp")
  .transform((value) => new Date(value).toISOString());

function utcDateRange(from, to, { maximumDays = 366, fieldFrom = "from", fieldTo = "to" } = {}) {
  const left = calendarDateSchema.safeParse(from);
  const right = calendarDateSchema.safeParse(to);
  if (!left.success) throw validationError(fieldFrom, left.error.issues[0]?.message || "Invalid date");
  if (!right.success) throw validationError(fieldTo, right.error.issues[0]?.message || "Invalid date");
  const startInclusive = new Date(`${left.data}T00:00:00.000Z`);
  const finalDay = new Date(`${right.data}T00:00:00.000Z`);
  if (startInclusive > finalDay) throw validationError(fieldTo, `${fieldTo} must not precede ${fieldFrom}`);
  const days = Math.floor((finalDay - startInclusive) / 86400000) + 1;
  if (days > maximumDays) throw validationError(fieldTo, `Date range cannot exceed ${maximumDays} days`);
  const endExclusive = new Date(finalDay);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { startInclusive, endExclusive, days };
}

function cleanUnicode(value) {
  return Buffer.from(String(value), "utf8").toString("utf8").normalize("NFKC");
}

function sanitizePlainText(value, maximumLength = 1000) {
  if (value === undefined || value === null) return null;
  const cleaned = cleanUnicode(value)
    .replace(/\0/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, maximumLength).join("") || null;
}

function forbiddenJsonKey(key) {
  const compact = normalizedKey(key);
  return FORBIDDEN_JSON_KEYS.has(String(key).toLowerCase()) || FORBIDDEN_JSON_KEYS.has(compact) || isSecretKey(key);
}

function inspectJson(value, options = {}) {
  const limits = {
    maxBytes: options.maxBytes || MAX_JSON_BYTES,
    maxDepth: options.maxDepth ?? MAX_JSON_DEPTH,
    maxFields: options.maxFields || MAX_JSON_FIELDS,
    maxArray: options.maxArray || MAX_JSON_ARRAY,
    maxString: options.maxString || MAX_JSON_STRING,
  };
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_error) { throw validationError(options.field || "json", "Value must be serializable JSON"); }
  if (Buffer.byteLength(serialized ?? "null", "utf8") > limits.maxBytes) throw validationError(options.field || "json", `JSON cannot exceed ${limits.maxBytes} bytes`);
  function visit(current, path, depth) {
    if (depth > limits.maxDepth) throw validationError(path, `JSON nesting cannot exceed ${limits.maxDepth} levels`);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw validationError(path, "JSON numbers must be finite");
      return;
    }
    if (typeof current === "string") {
      if (Array.from(current).length > limits.maxString) throw validationError(path, `JSON strings cannot exceed ${limits.maxString} characters`);
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > limits.maxArray) throw validationError(path, `JSON arrays cannot exceed ${limits.maxArray} entries`);
      current.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!current || typeof current !== "object" || Buffer.isBuffer(current) || Object.getPrototypeOf(current) !== Object.prototype) {
      throw validationError(path, "Only plain JSON values are allowed");
    }
    const entries = Object.entries(current);
    if (entries.length > limits.maxFields) throw validationError(path, `JSON objects cannot exceed ${limits.maxFields} fields`);
    for (const [key, child] of entries) {
      if (forbiddenJsonKey(key)) throw validationError(`${path}.${key}`, "Secret-bearing or prototype-pollution fields are not allowed");
      visit(child, `${path}.${key}`, depth + 1);
    }
  }
  visit(value, options.field || "json", 0);
  return value;
}

function sanitizeBoundedJson(value, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  const maxFields = options.maxFields || MAX_JSON_FIELDS;
  const maxArray = options.maxArray || MAX_JSON_ARRAY;
  const maxString = options.maxString || MAX_JSON_STRING;
  const maxBytes = options.maxBytes || MAX_JSON_BYTES;
  function visit(current, depth = 0) {
    if (depth > maxDepth) return "[TRUNCATED_DEPTH]";
    if (current === null || current === undefined || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : null;
    if (typeof current === "bigint") return current.toString();
    if (current instanceof Date) return current.toISOString();
    if (typeof current === "string") return sanitizePlainText(current, maxString);
    if (Buffer.isBuffer(current) || current instanceof Uint8Array) return undefined;
    if (Array.isArray(current)) return current.slice(0, maxArray).map((item) => visit(item, depth + 1)).filter((item) => item !== undefined);
    if (typeof current !== "object") return sanitizePlainText(String(current), maxString);
    const safe = sanitizeSecretSafe(current);
    const result = {};
    for (const [key, child] of Object.entries(safe || {}).slice(0, maxFields)) {
      if (forbiddenJsonKey(key) || PRIVATE_RESPONSE_KEY.test(normalizedKey(key))) continue;
      const item = visit(child, depth + 1);
      if (item !== undefined) result[key] = item;
    }
    return result;
  }
  const sanitized = visit(value);
  const bytes = Buffer.byteLength(JSON.stringify(sanitized ?? null), "utf8");
  if (bytes <= maxBytes) return sanitized;
  return { truncated: true, reasonCode: "JSON_SIZE_LIMIT", originalBytes: bytes };
}

function isPrivateResponseKey(key) {
  return forbiddenJsonKey(key) || PRIVATE_RESPONSE_KEY.test(normalizedKey(key));
}

module.exports = {
  MAX_UUID_LENGTH, MAX_JSON_BYTES, MAX_JSON_DEPTH, MAX_JSON_FIELDS, MAX_JSON_ARRAY, MAX_JSON_STRING,
  uuidSchema, calendarDateSchema, isoTimestampSchema, assertUuid, utcDateRange,
  sanitizePlainText, inspectJson, sanitizeBoundedJson, forbiddenJsonKey, isPrivateResponseKey,
};
