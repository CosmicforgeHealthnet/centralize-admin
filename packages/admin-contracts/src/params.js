"use strict";

// Strict request parameter validation: unknown keys, duplicated keys,
// oversize values and out-of-range integers are all rejected.

const P = require("./protocol");
const { ProtocolError } = require("./envelope");

const TYPES = {
  int: (raw, spec) => {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < (spec.min ?? 0) || value > (spec.max ?? Number.MAX_SAFE_INTEGER)) return undefined;
    return value;
  },
  id: (raw) => (new RegExp(P.PATTERNS.catalogId).test(raw) ? raw : undefined),
  partition: (raw) => (new RegExp(P.PATTERNS.partitionKey).test(raw) ? raw : undefined),
  scope: (raw) => (new RegExp(P.PATTERNS.scopeValue).test(raw) ? raw : undefined),
  cursor: (raw, spec) => (/^[A-Za-z0-9_-]+$/.test(raw) && raw.length <= (spec.max || 512) ? raw : undefined),
  datetime: (raw) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : undefined),
  enum: (raw, spec) => (spec.values.includes(raw) ? raw : undefined),
};

// spec: { name: { type, required, default, min, max, values } }
function parseQuery(searchParams, spec) {
  const out = {};
  const seen = new Set();
  for (const [key, raw] of searchParams) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) throw new ProtocolError("INVALID_REQUEST", "UNKNOWN_PARAMETER");
    if (seen.has(key)) throw new ProtocolError("INVALID_REQUEST", "DUPLICATE_PARAMETER");
    seen.add(key);
    if (raw.length > 512) throw new ProtocolError("INVALID_REQUEST", "PARAMETER_TOO_LONG");
    const value = TYPES[spec[key].type](raw, spec[key]);
    if (value === undefined) throw new ProtocolError("INVALID_REQUEST", "INVALID_PARAMETER");
    out[key] = value;
  }
  for (const [key, rule] of Object.entries(spec)) {
    if (out[key] === undefined) {
      if (rule.required) throw new ProtocolError("INVALID_REQUEST", "MISSING_PARAMETER");
      if (rule.default !== undefined) out[key] = rule.default;
    }
  }
  return out;
}

const PAGINATION = Object.freeze({
  limit: { type: "int", min: 1, max: 100, default: 50 },
  cursor: { type: "cursor", max: 512 },
});

module.exports = { parseQuery, PAGINATION };
