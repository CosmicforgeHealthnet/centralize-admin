const { inspectJson, sanitizePlainText } = require("../intelligence/validation-security");
const crypto = require("crypto");
const { executionError } = require("./execution.errors");

const FIELD_LIMITS = Object.freeze({
  desiredState: 64 * 1024,
  intent: 32 * 1024,
  beforeState: 32 * 1024,
  approvalScope: 16 * 1024,
  summary: 16 * 1024,
  normalizedResult: 32 * 1024,
  normalizedState: 32 * 1024,
  differences: 32 * 1024,
  policyValue: 16 * 1024,
  publicationMetadata: 32 * 1024,
  normalizedError: 16 * 1024,
});

const RAW_KEYS = new Set([
  "raw", "rawpayload", "rawrequest", "rawresponse", "requestbody", "responsebody",
  "providerpayload", "providerrequest", "providerresponse", "nativepayload", "mutationpayload",
  "googleadspayload", "metapayload", "tiktokpayload", "linkedinpayload", "xpayload",
]);

const FORBIDDEN_EXECUTION_KEYS = new Set([
  "credentialenvelope", "encryptedcredentialenvelope", "encryptedcredentials",
  "credentialciphertext", "encryptionmetadata", "databaseurl",
]);

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sanitizeExecutionJson(value, field = "json") {
  const maxBytes = FIELD_LIMITS[field] || 32 * 1024;
  try {
    inspectJson(value, { field, maxBytes, maxDepth: 6, maxFields: 100, maxArray: 200, maxString: 4000 });
  } catch (error) {
    if (error?.code === "VALIDATION_ERROR") {
      throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "UNSAFE_OR_OVERSIZED_JSON", issues: error.errors });
    }
    throw error;
  }

  function visit(current, path, depth) {
    if (current === null || typeof current === "boolean" || typeof current === "number") return current;
    if (typeof current === "string") {
      if (/<\s*script\b|javascript\s*:/i.test(current)) {
        throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "EXECUTABLE_CONTENT_FORBIDDEN" });
      }
      return sanitizePlainText(current, 4000) || "";
    }
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    const result = {};
    for (const [key, child] of Object.entries(current)) {
      const compactKey = normalizedKey(key);
      if (FORBIDDEN_EXECUTION_KEYS.has(compactKey)) {
        throw executionError("INVALID_EXECUTION_PLAN", { field: `${path}.${key}`, reasonCode: "SECRET_FIELD_FORBIDDEN" });
      }
      if (RAW_KEYS.has(compactKey) || compactKey.startsWith("raw")) {
        throw executionError("RAW_PROVIDER_PAYLOAD_FORBIDDEN", { field: `${path}.${key}` });
      }
      result[key] = visit(child, `${path}.${key}`, depth + 1);
    }
    return result;
  }

  return visit(value, field, 0);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashExecutionJson(value, field = "normalizedState") {
  const sanitized = sanitizeExecutionJson(value, field);
  return {
    sanitized,
    hash: crypto.createHash("sha256").update(canonicalJson(sanitized), "utf8").digest("hex"),
  };
}

module.exports = { FIELD_LIMITS, RAW_KEYS, FORBIDDEN_EXECUTION_KEYS, sanitizeExecutionJson, canonicalJson, hashExecutionJson };
