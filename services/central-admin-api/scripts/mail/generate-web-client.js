#!/usr/bin/env node
"use strict";

// Generates apps/central-admin-web/src/lib/generated/mail-api.ts from the
// Mail OpenAPI document (src/modules/mail/openapi/mail.openapi.js): schema
// types, request/response types per operation, the operation table and a
// typed path builder/client. Deterministic output (no timestamps).
//
//   node scripts/mail/generate-web-client.js          write the file
//   node scripts/mail/generate-web-client.js --check  exit 1 if it is stale

const fs = require("fs");
const path = require("path");
const { buildOpenApiDocument } = require("../../src/modules/mail/openapi/mail.openapi");

const OUTPUT = path.resolve(__dirname, "..", "..", "..", "..", "apps", "central-admin-web", "src", "lib", "generated", "mail-api.ts");

function literal(value) {
  return JSON.stringify(value);
}

function identifier(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

// JSON-schema subset -> TypeScript type expression.
function toType(schema, indent = "") {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (schema.allOf) return schema.allOf.map((part) => toType(part, indent)).join(" & ");
  if (schema.oneOf || schema.anyOf) return (schema.oneOf || schema.anyOf).map((part) => toType(part, indent)).join(" | ");
  if (schema.enum) return schema.enum.map(literal).join(" | ");
  if (schema.const !== undefined) return literal(schema.const);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : schema.properties ? ["object"] : [];
  if (!types.length) return "unknown";
  return types
    .map((type) => {
      switch (type) {
        case "string":
          return schema.format === "binary" ? "Blob" : "string";
        case "integer":
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array":
          return `Array<${toType(schema.items, indent)}>`;
        case "object": {
          const props = schema.properties || {};
          const keys = Object.keys(props);
          // `required` without properties (used in allOf to tighten a $ref):
          // the keys become mandatory; their types come from the other member.
          if (!keys.length && schema.required?.length) return `{ ${schema.required.map((key) => `${identifier(key)}: unknown;`).join(" ")} }`;
          if (!keys.length) return "Record<string, unknown>";
          const required = new Set(schema.required || []);
          const inner = keys.map((key) => `${indent}  ${identifier(key)}${required.has(key) ? "" : "?"}: ${toType(props[key], `${indent}  `)};`).join("\n");
          return `{\n${inner}\n${indent}}`;
        }
        default:
          return "unknown";
      }
    })
    .join(" | ");
}

// The success payload of an envelope schema is its `data` property.
function dataType(schema) {
  if (schema?.type === "string" && schema.format === "binary") return "Blob";
  const data = schema?.properties?.data;
  return data ? toType(data) : "unknown";
}

function generate() {
  const doc = buildOpenApiDocument();
  const out = [];
  out.push("// GENERATED FILE - DO NOT EDIT.");
  out.push("// Source: services/central-admin-api/src/modules/mail/openapi/mail.openapi.js");
  out.push("// Regenerate: cd services/central-admin-api && npm run mail:client:generate");
  out.push("// CI fails when this file is stale (npm run mail:client:check).");
  out.push("/* eslint-disable */");
  out.push("");
  out.push(`export const MAIL_API_VERSION = ${literal(doc.info.version)};`);
  out.push(`export const MAIL_API_BASE = ${literal(doc.servers[0].url)};`);
  out.push("");
  out.push("// ── Schemas ─────────────────────────────────────────────────────────────");
  for (const [name, schema] of Object.entries(doc.components.schemas)) {
    const type = toType(schema);
    if (type.startsWith("{\n")) out.push(`export interface ${name} ${type}`);
    else out.push(`export type ${name} = ${type};`);
    out.push("");
  }
  const operations = [];
  for (const [route, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const status = Object.keys(operation.responses).find((code) => code !== "default");
      operations.push({ id: operation.operationId, method: method.toUpperCase(), path: route, status: Number(status), summary: operation.summary, response: dataType(operation.responses[status].content["application/json"].schema), body: operation.requestBody ? toType(operation.requestBody.content["application/json"].schema, "  ") : null });
    }
  }
  operations.sort((a, b) => a.id.localeCompare(b.id));
  out.push("// ── Operations ──────────────────────────────────────────────────────────");
  out.push("export const MAIL_OPERATIONS = {");
  for (const op of operations) out.push(`  ${op.id}: { method: ${literal(op.method)}, path: ${literal(op.path)}, status: ${op.status} },`);
  out.push("} as const;");
  out.push("");
  out.push("export type MailOperationId = keyof typeof MAIL_OPERATIONS;");
  out.push("");
  out.push("/** Success payload (`data` of the success envelope) per operation. */");
  out.push("export interface MailResponses {");
  for (const op of operations) out.push(`  /** ${op.summary.replace(/\*\//g, "* /")} */\n  ${op.id}: ${op.response.replace(/\n/g, "\n  ")};`);
  out.push("}");
  out.push("");
  out.push("/** Typed JSON request bodies (operations without an entry take an untyped body or none). */");
  out.push("export interface MailRequestBodies {");
  for (const op of operations.filter((entry) => entry.body)) out.push(`  ${op.id}: ${op.body};`);
  out.push("}");
  out.push("");
  out.push(`type ParamNames<P extends string> = P extends \`\${string}{\${infer Name}}\${infer Rest}\` ? Name | ParamNames<Rest> : never;
export type MailPathParams<O extends MailOperationId> = Record<ParamNames<(typeof MAIL_OPERATIONS)[O]["path"]>, string>;
export type MailBody<O extends MailOperationId> = O extends keyof MailRequestBodies ? MailRequestBodies[O] : Record<string, unknown> | undefined;

/** Builds the path (relative to MAIL_API_BASE) of an operation; every parameter is URL-encoded. */
export function mailPath<O extends MailOperationId>(operation: O, params: MailPathParams<O>): string {
  const values = params as Record<string, string>;
  return MAIL_OPERATIONS[operation].path.replace(/\\{(\\w+)\\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === "") throw new Error(\`Missing path parameter \${name} for \${operation}\`);
    return encodeURIComponent(String(value));
  });
}

export interface MailRequestOptions {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  responseType?: "json" | "blob";
}

/** Minimal transport: resolves to the response \`data\` of the success envelope. */
export type MailTransport = (method: string, url: string, body: unknown, options: MailRequestOptions) => Promise<unknown>;

export function createMailClient(transport: MailTransport) {
  return {
    call<O extends MailOperationId>(operation: O, params: MailPathParams<O>, body?: MailBody<O>, options: MailRequestOptions = {}): Promise<MailResponses[O]> {
      const spec = MAIL_OPERATIONS[operation];
      return transport(spec.method, \`\${MAIL_API_BASE}\${mailPath(operation, params)}\`, body, options) as Promise<MailResponses[O]>;
    },
  };
}`);
  out.push("");
  return out.join("\n");
}

function main() {
  const content = generate();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
    if (current !== content) {
      console.error("mail-client status=stale file=apps/central-admin-web/src/lib/generated/mail-api.ts (run: npm run mail:client:generate)");
      process.exit(1);
    }
    console.log("mail-client status=ok");
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, content);
  console.log(`mail-client status=written operations=${(content.match(/^ {2}\w+: \{ method:/gm) || []).length}`);
}

if (require.main === module) main();

module.exports = { generate, toType, OUTPUT };
