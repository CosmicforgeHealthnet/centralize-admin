"use strict";

// Publishes the machine-readable Protocol v1 contract: JSON schemas and an
// OpenAPI 3.1 document. Run after changing src/schemas.js or src/protocol.js;
// tests fail when the published files drift from the source.

const fs = require("node:fs");
const path = require("node:path");
const C = require("../src");

const root = path.join(__dirname, "..");
const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n");

for (const name of Object.keys(C.schemas.SCHEMAS)) write("schemas/" + name + ".json", C.schemas.publishedSchema(name));

const ref = (name) => ({ $ref: "#/components/schemas/" + name.replace(/[.-]/g, "_") });
const envelope = { description: "Standard response envelope", content: { "application/json": { schema: ref("response-envelope.v1") } } };
const errors = Object.fromEntries(["400", "401", "403", "404", "409", "503"].map((code) => [code, envelope]));
const security = [{ ServiceHmac: [] }];
const pathParam = (name) => ({ name, in: "path", required: true, schema: { type: "string", pattern: C.PATTERNS.pathParam } });
const query = (name, schema, required = false) => ({ name, in: "query", required, schema });

const operations = {
  manifest: { summary: "Signed product manifest", security },
  healthLive: { summary: "Process liveness only; never implies upstream readiness", security: [] },
  healthReady: { summary: "Configuration readiness; upstream certification reported separately", security: [] },
  capabilities: { summary: "Capability catalog with readiness and blockers", security },
  datasets: { summary: "Approved dataset catalog", security },
  datasetSnapshots: { summary: "Authoritative bounded dataset snapshot", security, parameters: [pathParam("datasetId"), query("partition_key", { type: "string", pattern: C.PATTERNS.partitionKey }), query("limit", { type: "integer", minimum: 1, maximum: 100 }), query("cursor", { type: "string", maxLength: 512 })] },
  events: { summary: "Bounded page of standard events for one partition", security, parameters: [query("dataset_id", { type: "string", pattern: C.PATTERNS.catalogId }, true), query("partition_key", { type: "string", pattern: C.PATTERNS.partitionKey }, true), query("after_sequence", { type: "integer", minimum: 0 }, true), query("limit", { type: "integer", minimum: 1, maximum: 100 })] },
  eventsAck: { summary: "Acknowledge events committed by HQ (sent only after commit)", security, requestBody: { required: true, content: { "application/json": { schema: ref("events-ack.v1") } } } },
  syncStatus: { summary: "Event source and partition head positions", security },
  operationGet: { summary: "Operation status (requesting staff only)", security: [{ ServiceHmac: [], StaffDelegation: [] }], parameters: [pathParam("operationId")] },
  operationSubmit: { summary: "Typed command submission; disabled unless certified", security: [{ ServiceHmac: [], StaffDelegation: [] }], requestBody: { required: true, content: { "application/json": { schema: ref("operation-command.v1") } } } },
  auditGet: { summary: "Sanitized audit trail for an operation (requesting staff only)", security: [{ ServiceHmac: [], StaffDelegation: [] }], parameters: [pathParam("operationId")] },
  resourceList: { summary: "(1.1) Bounded, scoped page of one collection of a READ capability; opaque continuation", security: [{ ServiceHmac: [], StaffDelegation: [] }], parameters: [pathParam("capabilityId"), pathParam("collectionId"), ...C.RESOURCE_QUERY.map((k) => query(k, C.READ_QUERY_SCHEMAS[k], k === "purpose"))] },
  resourceGet: { summary: "(1.1) One scoped resource of a READ capability collection", security: [{ ServiceHmac: [], StaffDelegation: [] }], parameters: [pathParam("capabilityId"), pathParam("collectionId"), pathParam("resourceId"), ...C.RESOURCE_QUERY.filter((k) => !["limit", "continuation"].includes(k)).map((k) => query(k, C.READ_QUERY_SCHEMAS[k], k === "purpose"))] },
  reportGet: { summary: "(1.1) One product report with source, grain, units, scope, coverage and lineage", security: [{ ServiceHmac: [], StaffDelegation: [] }], parameters: [pathParam("reportId"), ...C.REPORT_QUERY.map((k) => query(k, C.READ_QUERY_SCHEMAS[k], k === "purpose"))] },
};

const paths = {};
for (const [id, endpoint] of Object.entries(C.ENDPOINTS)) {
  const op = operations[id];
  paths[C.BASE_PATH + endpoint.path] = {
    ...(paths[C.BASE_PATH + endpoint.path] || {}),
    [endpoint.method.toLowerCase()]: { operationId: id, summary: op.summary, security: op.security, ...(op.parameters ? { parameters: op.parameters } : {}), ...(op.requestBody ? { requestBody: op.requestBody } : {}), responses: { 200: envelope, ...errors } },
  };
}

const components = { schemas: {}, securitySchemes: {
  ServiceHmac: { type: "apiKey", in: "header", name: "X-CF-Signature", description: "cf-svc-v1 HMAC-SHA256 over version, service id, key id, method, request URI, timestamp, nonce and body SHA-256 (see @cosmicforge/service-clients). Sent over private transport (Unix socket or TLS 1.3 mTLS)." },
  StaffDelegation: { type: "apiKey", in: "header", name: "X-CF-Delegation", description: "Short-lived HS256 delegated staff context bound to the exact request (see @cosmicforge/identity-and-permissions)." },
} };
for (const name of Object.keys(C.schemas.SCHEMAS)) components.schemas[name.replace(/[.-]/g, "_")] = C.schemas.SCHEMAS[name];

write("openapi/product-admin-protocol-v1.openapi.json", {
  openapi: "3.1.0",
  info: { title: "CosmicForge Universal Product Admin Protocol", version: C.PROTOCOL_VERSION.major + "." + C.PROTOCOL_VERSION.minor + ".0", description: "Product Admin to Headquarters private protocol. Not an alias for any product bridge. Private transport only; never exposed through public ingress." },
  paths,
  components,
});
console.log("published " + Object.keys(C.schemas.SCHEMAS).length + " schemas and the OpenAPI document");
