const { sanitizeSecretSafe } = require("../security/secret-safe-serializer");

const SENSITIVE_RESPONSE_KEY_PATTERNS = [
  /accessToken/i,
  /refreshToken/i,
  /^authorization$/i,
  /authorizationHeader/i,
  /providerAuthorization/i,
  /credentials/i,
  /credentialJson/i,
  /encryptedCredential/i,
  /payloadJson/i,
  /encryptedPayload/i,
  /encryptedRawPayload/i,
  /webhookRawBody/i,
  /webhookPayload/i,
  /rawProviderResponse/i,
  /providerRequestHeaders/i,
  /token/i,
  /secret/i,
  /password/i,
];

const OPERATION_CONTENT_KEYS = new Set([
  "content",
  "text",
  "messageContent",
  "commentContent",
  "body",
]);

function isSensitiveResponseKey(key) {
  return SENSITIVE_RESPONSE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function sanitizeForResponseValue(value, options = {}) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForResponseValue(item, options))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveResponseKey(key)) continue;
    if (options.operationView && OPERATION_CONTENT_KEYS.has(key)) continue;

    const sanitizedValue = sanitizeForResponseValue(nested, options);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

function sanitizeForResponse(value, options = {}) {
  return sanitizeForResponseValue(sanitizeSecretSafe(value), options);
}

function sanitizeOperationRecord(record) {
  return sanitizeForResponse(record, { operationView: true });
}

function sanitizeConnectionRecord(connection) {
  return sanitizeForResponse(connection);
}

module.exports = {
  SENSITIVE_RESPONSE_KEY_PATTERNS,
  sanitizeForResponse,
  sanitizeOperationRecord,
  sanitizeConnectionRecord,
};
