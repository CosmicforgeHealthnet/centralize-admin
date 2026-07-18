const ApiError = require("../../../../shared/utils/ApiError");

const FORBIDDEN_PATTERNS = Object.freeze([
  /token/i,
  /accesstoken/i,
  /refreshtoken/i,
  /authorization/i,
  /credential/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^message$/i,
  /messagetext/i,
  /^comment$/i,
  /commenttext/i,
  /^content$/i,
  /rawbody/i,
  /rawpayload/i,
  /encryptedrawpayload/i,
  /attachmentcontent/i,
  /privatekey/i,
  /apikey/i,
]);

function normalizedKey(key) {
  return String(key || "").replace(/[_\-\s]/g, "");
}

function keyForbidden(key) {
  const compact = normalizedKey(key);
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(key) || pattern.test(compact));
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function validateActionPayload(payload, options = {}) {
  const maxDepth = options.maxDepth || 8;
  const maxBytes = options.maxBytes || 8192;
  if (jsonSize(payload) > maxBytes) {
    throw new ApiError(400, "Social action payload is not allowed", [
      { reasonCode: "SOCIAL_ACTION_PAYLOAD_TOO_LARGE" },
    ]);
  }

  function visit(value, path, depth) {
    if (depth > maxDepth) {
      throw new ApiError(400, "Social action payload is not allowed", [
        { reasonCode: "SOCIAL_ACTION_PAYLOAD_TOO_DEEP", path },
      ]);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      throw new ApiError(400, "Social action payload is not allowed", [
        { reasonCode: "SOCIAL_ACTION_PAYLOAD_BUFFER_REJECTED", path },
      ]);
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    }
    if (!value || typeof value !== "object") return value;

    const sanitized = {};
    for (const [key, nested] of Object.entries(value)) {
      if (keyForbidden(key)) {
        throw new ApiError(400, "Social action payload is not allowed", [
          { reasonCode: "SOCIAL_ACTION_PAYLOAD_FORBIDDEN_FIELD", field: key },
        ]);
      }
      sanitized[key] = visit(nested, path ? `${path}.${key}` : key, depth + 1);
    }
    return sanitized;
  }

  return visit(payload || {}, "", 0);
}

module.exports = {
  FORBIDDEN_PATTERNS,
  keyForbidden,
  validateActionPayload,
};
