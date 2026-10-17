const crypto = require("crypto");

function resolveHashKey({ key } = {}) {
  if (key) return Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key));
  const configured = process.env.SOCIAL_CONTENT_HASH_KEY;
  if (configured) return Buffer.from(configured, "base64").length >= 32
    ? Buffer.from(configured, "base64")
    : Buffer.from(configured);

  if (process.env.NODE_ENV === "production") {
    throw new Error("SOCIAL_CONTENT_HASH_KEY is required in production");
  }

  return Buffer.from("social-content-hash-development-test-key-only");
}

function canonicalContent(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFC");
}

function hmacContent(value, { key } = {}) {
  return crypto
    .createHmac("sha256", resolveHashKey({ key }))
    .update(canonicalContent(value), "utf8")
    .digest("hex");
}

module.exports = {
  canonicalContent,
  hmacContent,
};
