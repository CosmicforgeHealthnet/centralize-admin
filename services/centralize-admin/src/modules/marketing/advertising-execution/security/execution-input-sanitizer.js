const { executionError } = require("../execution.errors");

const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_KEYS = /access.?token|refresh.?token|authorization|developer.?token|client.?secret|app.?secret|private.?key|encrypted.?credential|credential.?envelope|signed.?url|upload.?token|cookie|session.?secret|password/i;
const PROVIDER_NATIVE_KEYS = /^(raw|rawpayload|rawrequest|rawresponse|providerpayload|providerrequest|providerresponse|nativepayload|mutationpayload|requestbody|responsebody)$/i;

function inspectExecutionInput(value, { path = "request", maxDepth = 7, maxArray = 200, maxKeys = 100, maxString = 4000 } = {}, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > maxString) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "STRING_TOO_LONG" });
    if (/<\s*script\b|javascript\s*:|\b(?:eval|Function)\s*\(/i.test(value)) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "EXECUTABLE_CONTENT_FORBIDDEN" });
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "INVALID_OR_CIRCULAR_VALUE" });
  if (depth >= maxDepth) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "JSON_DEPTH_EXCEEDED" });
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > maxArray) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "ARRAY_TOO_LARGE" });
    value.forEach((item, index) => inspectExecutionInput(item, { path: `${path}[${index}]`, maxDepth, maxArray, maxKeys, maxString }, seen, depth + 1));
  } else {
    const entries = Object.entries(value);
    if (entries.length > maxKeys) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "OBJECT_TOO_LARGE" });
    for (const [key, child] of entries) {
      if (PROTOTYPE_KEYS.has(key)) throw executionError("INVALID_EXECUTION_PLAN", { field: `${path}.${key}`, reasonCode: "PROTOTYPE_KEY_FORBIDDEN" });
      if (SECRET_KEYS.test(key)) throw executionError("INVALID_EXECUTION_PLAN", { field: `${path}.${key}`, reasonCode: "CREDENTIAL_FIELD_FORBIDDEN" });
      if (PROVIDER_NATIVE_KEYS.test(key)) throw executionError("RAW_PROVIDER_PAYLOAD_FORBIDDEN", { field: `${path}.${key}` });
      inspectExecutionInput(child, { path: `${path}.${key}`, maxDepth, maxArray, maxKeys, maxString }, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function assertAllowedKeys(value, allowed, path = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "OBJECT_REQUIRED" });
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw executionError("INVALID_EXECUTION_PLAN", { field: `${path}.${unknown[0]}`, reasonCode: "UNKNOWN_FIELD" });
  return value;
}

module.exports = { PROTOTYPE_KEYS, SECRET_KEYS, inspectExecutionInput, assertAllowedKeys };
