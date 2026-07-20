const { isPrivateResponseKey, sanitizePlainText } = require("./validation-security");

function serializeIntelligenceResponse(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizePlainText(value, 10000) || "";
  if (["number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDecimalPlaces === "function" && typeof value?.toFixed === "function" && Array.isArray(value?.d)) return value.toString();
  if (Array.isArray(value)) return value.map((item) => serializeIntelligenceResponse(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Marketing Intelligence response contains a circular value");
    seen.add(value);
    const result = Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isPrivateResponseKey(key))
      .map(([key, item]) => [key, serializeIntelligenceResponse(item, seen)]));
    seen.delete(value);
    return result;
  }
  return String(value);
}

module.exports = { serializeIntelligenceResponse };
