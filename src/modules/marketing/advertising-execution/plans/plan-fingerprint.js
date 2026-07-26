const crypto = require("crypto");
const { executionError } = require("../execution.errors");

const NON_MATERIAL_ROOT_FIELDS = new Set([
  "name", "title", "description", "notes", "displayMetadata", "uiMetadata",
  "createdAt", "updatedAt", "createdBy", "updatedBy",
]);
const UNORDERED_ARRAY_FIELDS = new Set(["labels", "tags"]);
const FORBIDDEN_KEYS = new Set([
  "accesstoken", "refreshtoken", "authorization", "authorizationheader", "authorizationheaders",
  "cookie", "clientsecret", "apikey", "password", "privatekey", "encryptedcredentials",
  // normalizedKey strips non-alphanumerics, so a literal "__proto__" key
  // normalizes to "proto"; both forms are listed so neither ever passes.
  "credentialenvelope", "encryptedcredentialenvelope", "__proto__", "proto", "prototype", "constructor",
]);

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertSecretFree(value, path = "plan", seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "CIRCULAR_VALUE" });
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(normalizedKey(key))) {
      throw executionError("INVALID_EXECUTION_PLAN", { field: `${path}.${key}`, reasonCode: "SECRET_FIELD_FORBIDDEN" });
    }
    assertSecretFree(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function canonicalize(value, { root = false, field = "" } = {}) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "NON_FINITE_NUMBER" });
    return value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalize(item, { field }));
    if (!UNORDERED_ARRAY_FIELDS.has(field)) return normalized;
    return normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "NON_JSON_VALUE" });
  }
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    if (root && NON_MATERIAL_ROOT_FIELDS.has(key)) return [];
    if (value[key] === undefined) return [];
    return [[key, canonicalize(value[key], { field: key })]];
  }));
}

function normalizedMaterialSnapshot(plan) {
  assertSecretFree(plan);
  return canonicalize(plan, { root: true, field: "plan" });
}

function fingerprintPlan(plan, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw executionError("INVALID_EXECUTION_PLAN", { field: "version", reasonCode: "INVALID_VERSION" });
  }
  const snapshot = normalizedMaterialSnapshot(plan);
  const canonical = JSON.stringify(snapshot);
  return Object.freeze({
    algorithm: "sha256",
    version,
    fingerprint: crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
    normalizedSnapshot: snapshot,
  });
}

module.exports = {
  NON_MATERIAL_ROOT_FIELDS,
  normalizedMaterialSnapshot,
  fingerprintPlan,
};
