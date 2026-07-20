const crypto = require("crypto");

function hashStableParts(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter((part) => part !== undefined && part !== null).map(String).join("|"))
    .digest("hex");
}

function deterministicMarketingEventId(type, ...parts) {
  return `${String(type).toLowerCase()}:${hashStableParts([type, ...parts]).slice(0, 32)}`;
}

function hashAnonymousId(anonId) {
  if (!anonId) return null;
  return hashStableParts(["anon", anonId]);
}

function safeHash(value) {
  if (!value) return null;
  return hashStableParts([value]);
}

module.exports = {
  deterministicMarketingEventId,
  hashAnonymousId,
  safeHash,
};
