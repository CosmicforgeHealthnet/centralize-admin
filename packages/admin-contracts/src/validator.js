"use strict";

// A strict, dependency-free validator for the JSON Schema subset used by the
// Product Admin Protocol. Unsupported keywords throw at compile time so a
// schema can never silently validate less than it appears to.

const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "enum", "const",
  "pattern", "minLength", "maxLength", "minimum", "maximum", "items", "minItems",
  "maxItems", "uniqueItems", "properties", "required", "additionalProperties", "format",
  "examples", "default", "deprecated",
]);

const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isSafeInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};

const FORMATS = {
  "date-time": (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v) && !Number.isNaN(Date.parse(v)),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v),
};

const MAX_ERRORS = 25;
const MAX_DEPTH = 48;

function checkSchema(schema, path = "#") {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object") throw new Error("invalid_schema:" + path);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error("unsupported_schema_keyword:" + key + "@" + path);
  }
  if (schema.format && !FORMATS[schema.format]) throw new Error("unsupported_format:" + schema.format);
  for (const [key, sub] of Object.entries(schema.properties || {})) checkSchema(sub, path + "/properties/" + key);
  for (const [key, sub] of Object.entries(schema.$defs || {})) checkSchema(sub, path + "/$defs/" + key);
  if (schema.items) checkSchema(schema.items, path + "/items");
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    checkSchema(schema.additionalProperties, path + "/additionalProperties");
  }
}

function typeMatches(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((name) => {
    if (!TYPES[name]) throw new Error("unsupported_type:" + name);
    return TYPES[name](value);
  });
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function walk(schema, value, path, errors, root, depth) {
  if (errors.length >= MAX_ERRORS) return;
  if (depth > MAX_DEPTH) { errors.push({ path, keyword: "depth" }); return; }
  if (schema === true) return;
  if (schema === false) { errors.push({ path, keyword: "false" }); return; }
  if (schema.$ref) {
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(schema.$ref);
    const target = match && root.$defs && root.$defs[match[1]];
    if (!target) throw new Error("unresolved_ref:" + schema.$ref);
    walk(target, value, path, errors, root, depth + 1);
    return;
  }
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push({ path, keyword: "type" });
    return;
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) errors.push({ path, keyword: "const" });
  if (schema.enum && !schema.enum.some((option) => sameJson(option, value))) errors.push({ path, keyword: "enum" });
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, keyword: "minLength" });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, keyword: "maxLength" });
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push({ path, keyword: "pattern" });
    if (schema.format && !FORMATS[schema.format](value)) errors.push({ path, keyword: "format" });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, keyword: "minimum" });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, keyword: "maximum" });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, keyword: "minItems" });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, keyword: "maxItems" });
    if (schema.uniqueItems) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push({ path, keyword: "uniqueItems" });
    }
    if (schema.items) value.forEach((item, index) => walk(schema.items, item, path + "[" + index + "]", errors, root, depth + 1));
  }
  if (TYPES.object(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push({ path: path + "." + key, keyword: "required" });
    }
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        walk(properties[key], value[key], path + "." + key, errors, root, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: path + "." + key, keyword: "additionalProperties" });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        walk(schema.additionalProperties, value[key], path + "." + key, errors, root, depth + 1);
      }
    }
  }
}

function compile(schema) {
  checkSchema(schema);
  const fn = (value) => {
    const errors = [];
    walk(schema, value, "$", errors, schema, 0);
    return { valid: errors.length === 0, errors };
  };
  fn.schema = schema;
  return fn;
}

function validate(schema, value) {
  return compile(schema)(value);
}

module.exports = { compile, validate, checkSchema, FORMATS };
