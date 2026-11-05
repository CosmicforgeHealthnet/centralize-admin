"use strict";

// Pinned Karryam Backoffice Bridge capability registry. The only way the
// connector can build a Bridge request: the capability ID selects the exact
// method, path template, query shape, request body schema and result schema
// reviewed from KarryGo. Staff input never supplies a host, path or
// parameter name, only validated values for the parameters the source
// contract defines.

const pinned = require("./karrygo-capabilities.v1.json");
const components = require("./karrygo-bridge-schemas.v1.json").components.schemas;
const { compileBridgeSchema } = require("./schema");

const BRIDGE_BASE = pinned.bridge_base_path;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
// Path segments are stricter than the source pattern: "/" would change the
// route, and the Bridge rejects encoded bytes in paths.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CURSOR = /^[A-Za-z0-9._~:@/+=-]{1,4096}$/;
const ANALYTICS_AUTHORITIES = Object.freeze(["TAXI", "DISPATCH", "HAULING", "VENDOR"]);
const MAX_WINDOW_MS = 31 * 24 * 3600 * 1000;
const SHAPE_PARAMS = Object.freeze({
  BASE: ["market", "organization", "purpose"],
  SCOPED: ["market", "organization", "purpose", "zone", "tenant"],
  SCOPED_WINDOW: ["market", "organization", "purpose", "zone", "tenant", "start", "end", "limit", "cursor"],
  ANALYTICS: ["market", "organization", "purpose", "zone", "tenant", "start", "end", "authority", "product_code"],
});
// The scoped mission-success rate is released only to a caller that also
// holds the underlying counts permission (Bridge scoped_analytics.go).
const EXTRA_PERMISSIONS = Object.freeze({
  "analytics.scoped.mission-success-rate.read": ["analytics.scoped.mission-success.read"],
});

class ContractError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "ContractError";
    this.reason = reason;
    this.detail = detail;
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const CAPABILITIES = deepFreeze(pinned.capabilities.map((c) => ({ ...c })));
const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));
const resultValidators = new Map();
const bodyValidators = new Map();

function capability(id) {
  return BY_ID.get(id) || null;
}

function requireCapability(id) {
  const cap = capability(id);
  if (!cap) throw new ContractError("UNKNOWN_BRIDGE_CAPABILITY");
  return cap;
}

function capabilitiesFor(module) {
  return CAPABILITIES.filter((c) => c.module === module);
}

function permissionsFor(cap) {
  return [cap.permission, ...(EXTRA_PERMISSIONS[cap.id] || [])];
}

function needsZoneTenant(cap) {
  return cap.query_shape !== "BASE";
}

function validateQueryValue(name, value, now) {
  if (["market", "organization", "purpose", "zone", "tenant", "product_code"].includes(name)) return typeof value === "string" && OPAQUE.test(value);
  if (name === "start" || name === "end") return typeof value === "string" && DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
  if (name === "limit") return Number.isInteger(value) && value >= 1 && value <= 100;
  if (name === "cursor") return typeof value === "string" && CURSOR.test(value);
  if (name === "authority") return ANALYTICS_AUTHORITIES.includes(value);
  return false;
}

// Builds the exact request URI. Parameters appear in source-contract order;
// every value is validated; unknown or missing required parameters fail.
function buildUri(cap, { query = {}, pathParams = {}, now = Date.now() } = {}) {
  const names = SHAPE_PARAMS[cap.query_shape];
  for (const key of Object.keys(query)) if (!names.includes(key)) throw new ContractError("QUERY_PARAMETER_NOT_IN_CONTRACT");
  const parts = [];
  for (const name of names) {
    const value = query[name];
    if (value === undefined || value === null || value === "") {
      if (cap.query_required.includes(name)) throw new ContractError("QUERY_PARAMETER_REQUIRED");
      continue;
    }
    if (!validateQueryValue(name, value, now)) throw new ContractError("QUERY_PARAMETER_INVALID");
    parts.push(name + "=" + encodeURIComponent(String(value)));
  }
  if (query.start !== undefined && query.end !== undefined) {
    const start = Date.parse(query.start);
    const end = Date.parse(query.end);
    if (!(end > start) || end - start > MAX_WINDOW_MS || end > now + 60000) throw new ContractError("TIME_WINDOW_INVALID");
  }
  if (cap.id === "analytics.scoped.readiness-components.read" ? query.authority !== "VENDOR" : (cap.query_shape === "ANALYTICS" && query.authority === "VENDOR")) {
    throw new ContractError("QUERY_PARAMETER_INVALID");
  }
  const declared = cap.path_params.map((p) => p.name);
  for (const key of Object.keys(pathParams)) if (!declared.includes(key)) throw new ContractError("PATH_PARAMETER_NOT_IN_CONTRACT");
  const path = cap.path.replace(/\{([a-z_]+)\}/g, (_, name) => {
    const spec = cap.path_params.find((p) => p.name === name);
    const value = pathParams[name];
    if (typeof value !== "string" || !SEGMENT.test(value)) throw new ContractError("PATH_PARAMETER_INVALID");
    if (spec.format === "uuid" && !UUID.test(value)) throw new ContractError("PATH_PARAMETER_INVALID");
    if (spec.pattern && !new RegExp(spec.pattern, "u").test(value)) throw new ContractError("PATH_PARAMETER_INVALID");
    if (spec.max_length && value.length > spec.max_length) throw new ContractError("PATH_PARAMETER_INVALID");
    return value;
  });
  return BRIDGE_BASE + path + (parts.length ? "?" + parts.join("&") : "");
}

function validateResult(cap, result) {
  if (!cap.result_schema) return { valid: result === null || result === undefined, errors: [] };
  let fn = resultValidators.get(cap.id);
  if (!fn) { fn = compileBridgeSchema(cap.result_schema, components); resultValidators.set(cap.id, fn); }
  return fn(result);
}

// Request bodies are checked against the pinned schema before signing, so
// arbitrary or extra fields never reach the Bridge.
function validateBody(cap, body) {
  if (!cap.request_body) return { valid: body === undefined || body === null, errors: [] };
  let fn = bodyValidators.get(cap.id);
  if (!fn) { fn = compileBridgeSchema(cap.request_body, components); bodyValidators.set(cap.id, fn); }
  return fn(body);
}

// The response envelope common to every JSON Bridge route.
const ENVELOPE_KEYS = new Set(["contract_version", "product", "correlation_id", "as_of", "freshness", "result", "error"]);
function envelopeErrors(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return ["NOT_OBJECT"];
  const errors = [];
  for (const key of Object.keys(env)) if (!ENVELOPE_KEYS.has(key)) errors.push("UNKNOWN_FIELD");
  if (env.contract_version !== "1.0") errors.push("CONTRACT_VERSION");
  if (env.product !== "karryam") errors.push("PRODUCT");
  if (typeof env.correlation_id !== "string" || !UUID.test(env.correlation_id)) errors.push("CORRELATION");
  if (typeof env.as_of !== "string" || Number.isNaN(Date.parse(env.as_of))) errors.push("AS_OF");
  if (!["LIVE", "RECENT", "STALE", "PARTIAL", "UNKNOWN", "UNAVAILABLE"].includes(env.freshness)) errors.push("FRESHNESS");
  return errors;
}

function summary() {
  return {
    contract: pinned.contract,
    contract_version: pinned.contract_version,
    source_artifacts: { ...pinned.source_artifacts },
    totals: { capabilities: pinned.totals.capabilities, by_state: { ...pinned.totals.by_state } },
  };
}

module.exports = {
  BRIDGE_BASE, CAPABILITIES, ContractError, ANALYTICS_AUTHORITIES, SHAPE_PARAMS, OPAQUE, SEGMENT, MAX_WINDOW_MS,
  capability, requireCapability, capabilitiesFor, permissionsFor, needsZoneTenant, buildUri, validateResult, validateBody, envelopeErrors, summary,
};
