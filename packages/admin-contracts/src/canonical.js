"use strict";

const { createHash } = require("node:crypto");

// Canonical JSON: object keys sorted by code point, no whitespace, no
// undefined values. Every digest and signature in the protocol covers this
// form so that two implementations always agree on the signed bytes.
function canonicalize(value, depth = 0) {
  if (depth > 64) throw new TypeError("canonical_depth_exceeded");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical_non_finite_number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((item) => canonicalize(item, depth + 1)).join(",") + "]";
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalize(value[key], depth + 1)).join(",") + "}";
    }
    default:
      throw new TypeError("canonical_unsupported_type");
  }
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

// Digests are always labelled with their algorithm.
function digestOf(value) {
  return "sha256:" + sha256Hex(canonicalize(value));
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

module.exports = { canonicalize, sha256Hex, digestOf, DIGEST_PATTERN, deepFreeze };
