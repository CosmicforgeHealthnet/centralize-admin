const SECRET_KEY_PATTERNS = Object.freeze([
  /encryptedcredentials/i,
  /encryptedverifier/i,
  /encryptedrawpayload/i,
  /accesstoken/i,
  /^access_token$/i,
  /refreshtoken/i,
  /^refresh_token$/i,
  /^authorization$/i,
  /authorizationheader/i,
  /clientsecret/i,
  /^client_secret$/i,
  /^token$/i,
  /^tokens$/i,
  /^secret$/i,
  /^secrets$/i,
  /password/i,
  /privatekey/i,
  /apikey/i,
  /^api_key$/i,
  /webhooksecret/i,
  /codeverifier/i,
  /^code_verifier$/i,
  /credentialjson/i,
  /payloadjson/i,
]);

function normalizedKey(key) {
  return String(key || "").replace(/[_\-\s]/g, "");
}

function isSecretKey(key) {
  const compact = normalizedKey(key);
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key) || pattern.test(compact));
}

function sanitizeSecretSafe(value, options = {}) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeSecretSafe(item, options))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    const sanitizedValue = sanitizeSecretSafe(nested, options);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

module.exports = {
  SECRET_KEY_PATTERNS,
  isSecretKey,
  sanitizeSecretSafe,
};
