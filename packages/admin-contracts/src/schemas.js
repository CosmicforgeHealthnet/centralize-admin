"use strict";

// Source of truth for Protocol v1 JSON schemas. `npm run schemas:write`
// publishes them under schemas/*.json; a test keeps the two in sync.

const P = require("./protocol");

const str = (pattern, maxLength) => ({ type: "string", pattern, ...(maxLength ? { maxLength } : {}) });
const id = (key) => str(P.PATTERNS[key]);
const enumOf = (values) => ({ type: "string", enum: [...values] });
const nullable = (schema) => ({ ...schema, type: [schema.type, "null"] });
const dateTime = { type: "string", format: "date-time" };
const list = (items, maxItems, extra = {}) => ({ type: "array", items, maxItems, uniqueItems: true, ...extra });
const object = (properties, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});

const scopeValues = list(id("scopeValue"), 64);
const scope = {
  type: "object",
  additionalProperties: false,
  properties: { market: scopeValues, organization: scopeValues, zone: scopeValues, tenant: scopeValues },
  required: [],
};
const blocker = object({ code: id("code"), detail: { type: "string", maxLength: 240 } });

const capability = object({
  id: id("catalogId"),
  version: id("semver"),
  kind: enumOf(P.CAPABILITY_KINDS),
  state: enumOf(P.CAPABILITY_STATES),
  risk: enumOf(P.RISK_LEVELS),
  description: { type: "string", maxLength: 240 },
  datasets: list(id("catalogId"), 32),
  blockers: list(blocker, 16),
  requires_recent_mfa: { type: "boolean" },
  requires_independent_approval: { type: "boolean" },
  request_schema: { type: ["object", "null"] },
});

const field = object({
  name: id("fieldName"),
  type: enumOf(P.FIELD_TYPES),
  classification: enumOf(P.PRIVACY_CLASSES),
  meaning: { type: "string", minLength: 1, maxLength: 240 },
  unit: nullable(id("unit")),
});

const metric = object({
  metric_id: id("catalogId"),
  version: id("semver"),
  definition: { type: "string", minLength: 1, maxLength: 500 },
  aggregation: enumOf(P.AGGREGATIONS),
  grain: enumOf(P.GRAINS),
  unit: id("unit"),
  currency: nullable(id("currency")),
});

const dataset = object({
  dataset_id: id("catalogId"),
  version: id("semver"),
  schema_id: id("catalogId"),
  schema_digest: id("digest"),
  title: { type: "string", minLength: 1, maxLength: 120 },
  privacy_class: enumOf(P.PRIVACY_CLASSES),
  scope_dimensions: list(enumOf(P.SCOPE_DIMENSIONS), 4, { minItems: 1 }),
  authorized_departments: list(id("department"), 32, { minItems: 1 }),
  semantic_grain: enumOf(P.GRAINS),
  units: list(id("unit"), 16),
  currency: nullable(id("currency")),
  freshness_target_seconds: { type: "integer", minimum: 60, maximum: 2678400 },
  lineage: object({
    source_system: { type: "string", minLength: 1, maxLength: 120 },
    source_owner: { type: "string", minLength: 1, maxLength: 120 },
    derivation: { type: "string", minLength: 1, maxLength: 500 },
  }),
  allowed_fields: list(field, 64, { minItems: 1 }),
  metrics: list(metric, 64),
  retention_days: { type: "integer", minimum: 1, maximum: 3650 },
  readiness: enumOf(P.DATASET_READINESS),
  blockers: list(blocker, 16),
});

const eventFamily = object({
  family: id("catalogId"),
  schema_id: id("catalogId"),
  schema_version: id("semver"),
  dataset_id: id("catalogId"),
  classification: enumOf(P.PRIVACY_CLASSES),
  projection: enumOf(P.PROJECTIONS),
  payload_schema: { type: "object" },
  status: enumOf(P.EVENT_FAMILY_STATUS),
  sunset_at: nullable(dateTime),
  version_policy: { type: "string", const: "MAJOR_FOR_BREAKING" },
});

const manifestBody = object({
  schema: { type: "string", const: P.MANIFEST_SCHEMA },
  product_id: id("productId"),
  service_instance_id: id("serviceInstanceId"),
  environment: enumOf(P.ENVIRONMENTS),
  display_name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[\\p{L}\\p{N}][\\p{L}\\p{N} .&'-]*$" },
  protocol: object({ major: { type: "integer", minimum: 1, maximum: 99 }, minor: { type: "integer", minimum: 0, maximum: 999 } }),
  build_sha: id("buildSha"),
  manifest_revision: { type: "integer", minimum: 1, maximum: 2147483647 },
  issued_at: dateTime,
  expires_at: dateTime,
  workload_identity: id("workloadIdentity"),
  signing_key_id: id("keyId"),
  capabilities: { type: "array", items: capability, maxItems: 256 },
  datasets: { type: "array", items: dataset, maxItems: 128 },
  event_families: { type: "array", items: eventFamily, maxItems: 128 },
});

const signedManifest = object({
  manifest: manifestBody,
  signature: object({
    alg: { type: "string", const: "EdDSA" },
    kid: id("keyId"),
    signed_revision: { type: "integer", minimum: 1 },
    signed_digest: id("digest"),
    value: { type: "string", pattern: "^[A-Za-z0-9_-]{86}$" },
  }),
});

const responseEnvelope = object({
  contract_version: { type: "string", const: P.CONTRACT_VERSION },
  product_id: id("productId"),
  correlation_id: id("correlationId"),
  as_of: nullable(dateTime),
  freshness: enumOf(P.FRESHNESS),
  coverage: enumOf(P.COVERAGE),
  result: {},
  error: {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      code: enumOf(Object.keys(P.ERROR_CODES)),
      reason: id("code"),
      retryable: { type: "boolean" },
      operation_id: { type: "string", format: "uuid" },
    },
    required: ["code", "reason"],
  },
});

// Domain-neutral metric observation: the only projection HQ applies.
const metricObservationPayload = object({
  metric_id: id("catalogId"),
  definition_version: id("semver"),
  window_start: dateTime,
  window_end: dateTime,
  value: { type: ["number", "null"] },
  value_state: enumOf(P.VALUE_STATES),
  unit: id("unit"),
  currency: nullable(id("currency")),
  coverage: enumOf(P.COVERAGE),
  observed_at: nullable(dateTime),
});

const ackRequest = object({
  dataset_id: id("catalogId"),
  partition_key: id("partitionKey"),
  sequence: { type: "integer", minimum: 1 },
});

const operationCommand = object({
  command_id: { type: "string", format: "uuid" },
  idempotency_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$" },
  capability_id: id("catalogId"),
  target: object({ type: id("catalogId"), id: id("pathParam"), expected_version: { type: ["integer", "null"], minimum: 0 } }),
  params: { type: "object" },
  reason_code: id("code"),
  case_reference: nullable(id("pathParam")),
  scope,
});

const SCHEMAS = Object.freeze({
  "scope.v1": scope,
  "capability.v1": capability,
  "dataset.v1": dataset,
  "event-family.v1": eventFamily,
  "manifest.v1": manifestBody,
  "signed-manifest.v1": signedManifest,
  "response-envelope.v1": responseEnvelope,
  "metric-observation.v1": metricObservationPayload,
  "events-ack.v1": ackRequest,
  "operation-command.v1": operationCommand,
});

function publishedSchema(name) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error("unknown_schema");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.cosmicforge.internal/product-admin/" + name + ".json",
    title: "CosmicForge Product Admin Protocol " + name,
    ...schema,
  };
}

module.exports = { SCHEMAS, publishedSchema, scope, capability, dataset, eventFamily, manifestBody, signedManifest, responseEnvelope, metricObservationPayload, ackRequest, operationCommand };
