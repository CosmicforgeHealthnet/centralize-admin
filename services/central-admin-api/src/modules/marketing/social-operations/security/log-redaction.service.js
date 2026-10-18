const REDACTED = "[REDACTED]";

const SECRET_OR_PRIVATE_PATTERNS = Object.freeze([
  /token/i,
  /credential/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /cookie/i,
  /verifier/i,
  /privatekey/i,
  /apikey/i,
  /encryptedcredentials/i,
  /encryptedverifier/i,
  /encryptedrawpayload/i,
  /^messagecontent$/i,
  /^commentcontent$/i,
  /^rawmessage$/i,
  /^rawcomment$/i,
  /^content$/i,
  /^attachmentsjson$/i,
  /^attachmenturl$/i,
  /^attachmenturls$/i,
  /^secureurl$/i,
  /^providerrawpayload$/i,
  /^rawbody$/i,
]);

function compactKey(key) {
  return String(key || "").replace(/[_\-\s]/g, "");
}

function shouldRedactKey(key, parentKey) {
  if (key === "message" && !parentKey) return false;
  const compact = compactKey(key);
  return SECRET_OR_PRIVATE_PATTERNS.some(
    (pattern) => pattern.test(key) || pattern.test(compact),
  );
}

function redactLogPayload(value, { parentKey = null } = {}) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => redactLogPayload(item, { parentKey }));
  }
  if (!value || typeof value !== "object") return value;

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (shouldRedactKey(key, parentKey)) {
      redacted[key] = REDACTED;
    } else {
      redacted[key] = redactLogPayload(nested, { parentKey: key });
    }
  }
  return redacted;
}

module.exports = {
  REDACTED,
  redactLogPayload,
  shouldRedactKey,
};
