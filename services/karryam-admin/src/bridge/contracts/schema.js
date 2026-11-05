"use strict";

// Strict, dependency-free JSON Schema validator for the pinned Karryam
// Backoffice Bridge schemas (OpenAPI 3.1 / draft 2020-12 subset). Every
// keyword the pinned schemas use is implemented; any other keyword fails at
// compile time, so a schema can never silently validate less than it says.

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly"]);
const KEYWORDS = new Set([
  "$ref", "type", "enum", "const", "pattern", "minLength", "maxLength", "format", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "items", "minItems", "maxItems", "uniqueItems", "contains",
  "minContains", "maxContains", "properties", "required", "additionalProperties", "maxProperties",
  "minProperties", "propertyNames", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
]);
const FORMATS = {
  "date-time": (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")),
  binary: () => true,
};
const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isSafeInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};
const MAX_DEPTH = 64;
const MAX_ERRORS = 20;
const REF = /^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/;

function checkSchema(schema, components, at = "#", seen = new Set()) {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("invalid_schema@" + at);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error("unsupported_schema_keyword:" + key + "@" + at);
  }
  if (schema.format && !FORMATS[schema.format]) throw new Error("unsupported_format:" + schema.format + "@" + at);
  if (schema.type) for (const t of [].concat(schema.type)) if (!TYPES[t]) throw new Error("unsupported_type:" + t + "@" + at);
  if (schema.pattern) new RegExp(schema.pattern, "u");
  if (schema.$ref) {
    const m = REF.exec(schema.$ref);
    if (!m || !components[m[1]]) throw new Error("unresolved_ref:" + schema.$ref);
    if (!seen.has(m[1])) { seen.add(m[1]); checkSchema(components[m[1]], components, schema.$ref, seen); }
  }
  for (const [k, sub] of Object.entries(schema.properties || {})) checkSchema(sub, components, at + "/properties/" + k, seen);
  for (const key of ["items", "contains", "not", "if", "then", "else", "propertyNames"]) if (schema[key] !== undefined) checkSchema(schema[key], components, at + "/" + key, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") checkSchema(schema.additionalProperties, components, at + "/additionalProperties", seen);
  for (const key of ["allOf", "anyOf", "oneOf"]) (schema[key] || []).forEach((sub, i) => checkSchema(sub, components, at + "/" + key + "/" + i, seen));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function walk(schema, value, path, errors, components, depth) {
  if (errors.length >= MAX_ERRORS) return;
  if (depth > MAX_DEPTH) { errors.push({ path, keyword: "depth" }); return; }
  if (schema === true) return;
  if (schema === false) { errors.push({ path, keyword: "false" }); return; }
  if (schema.$ref) walk(components[REF.exec(schema.$ref)[1]], value, path, errors, components, depth + 1);
  if (schema.type !== undefined && ![].concat(schema.type).some((t) => TYPES[t](value))) { errors.push({ path, keyword: "type" }); return; }
  if (schema.const !== undefined && !same(schema.const, value)) errors.push({ path, keyword: "const" });
  if (schema.enum && !schema.enum.some((o) => same(o, value))) errors.push({ path, keyword: "enum" });
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push({ path, keyword: "minLength" });
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push({ path, keyword: "maxLength" });
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push({ path, keyword: "pattern" });
    if (schema.format && !FORMATS[schema.format](value)) errors.push({ path, keyword: "format" });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, keyword: "minimum" });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, keyword: "maximum" });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ path, keyword: "exclusiveMinimum" });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push({ path, keyword: "exclusiveMaximum" });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, keyword: "minItems" });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, keyword: "maxItems" });
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push({ path, keyword: "uniqueItems" });
    if (schema.items !== undefined) value.forEach((item, i) => walk(schema.items, item, path + "[" + i + "]", errors, components, depth + 1));
    if (schema.contains !== undefined) {
      const matches = value.filter((item) => { const e = []; walk(schema.contains, item, path, e, components, depth + 1); return e.length === 0; }).length;
      const min = schema.minContains !== undefined ? schema.minContains : 1;
      if (matches < min) errors.push({ path, keyword: "contains" });
      if (schema.maxContains !== undefined && matches > schema.maxContains) errors.push({ path, keyword: "maxContains" });
    }
  }
  if (TYPES.object(value)) {
    const keys = Object.keys(value);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push({ path, keyword: "maxProperties" });
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push({ path, keyword: "minProperties" });
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push({ path: path + "." + key, keyword: "required" });
    const properties = schema.properties || {};
    for (const key of keys) {
      if (schema.propertyNames !== undefined) walk(schema.propertyNames, key, path + "{" + key + "}", errors, components, depth + 1);
      if (Object.prototype.hasOwnProperty.call(properties, key)) walk(properties[key], value[key], path + "." + key, errors, components, depth + 1);
      else if (schema.additionalProperties === false) errors.push({ path: path + "." + key, keyword: "additionalProperties" });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(schema.additionalProperties, value[key], path + "." + key, errors, components, depth + 1);
    }
  }
  const passes = (sub) => { const e = []; walk(sub, value, path, e, components, depth + 1); return e.length === 0; };
  for (const sub of schema.allOf || []) walk(sub, value, path, errors, components, depth + 1);
  if (schema.anyOf && !schema.anyOf.some(passes)) errors.push({ path, keyword: "anyOf" });
  if (schema.oneOf && schema.oneOf.filter(passes).length !== 1) errors.push({ path, keyword: "oneOf" });
  if (schema.not !== undefined && passes(schema.not)) errors.push({ path, keyword: "not" });
  if (schema.if !== undefined) {
    if (passes(schema.if)) { if (schema.then !== undefined) walk(schema.then, value, path, errors, components, depth + 1); }
    else if (schema.else !== undefined) walk(schema.else, value, path, errors, components, depth + 1);
  }
}

// Compiles against a pinned component set. Throws on unsupported keywords.
function compileBridgeSchema(schema, components) {
  checkSchema(schema, components);
  const fn = (value) => {
    const errors = [];
    walk(schema, value, "$", errors, components, 0);
    return { valid: errors.length === 0, errors };
  };
  return fn;
}

module.exports = { compileBridgeSchema, checkSchema, FORMATS };
