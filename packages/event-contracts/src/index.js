"use strict";

// Standard Product Admin -> HQ event envelope (v1).
//
// This is NOT the Karryam Bridge source-event contract. Bridge source events
// are consumed inside Karryam Admin (a later phase) and must be translated
// into this envelope by the Product Admin; the two are never interchangeable.

// Packages are co-located in the monorepo and consumed by relative path.
const C = require("../../admin-contracts");

const ENVELOPE = "cosmicforge.product-admin.event/v1";
const SKEW_MS = 5 * 60 * 1000;
const { PATTERNS } = C;
const str = (key) => ({ type: "string", pattern: PATTERNS[key] });
const dateTime = { type: "string", format: "date-time" };

const envelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["envelope", "schema_id", "schema_version", "family", "event_id", "source_id", "product_id", "dataset_id", "partition_key", "sequence", "entity", "scope", "classification", "occurred_at", "emitted_at", "payload", "payload_digest"],
  properties: {
    envelope: { type: "string", const: ENVELOPE },
    schema_id: str("catalogId"),
    schema_version: str("semver"),
    family: str("catalogId"),
    event_id: { type: "string", format: "uuid" },
    source_id: str("serviceInstanceId"),
    product_id: str("productId"),
    dataset_id: str("catalogId"),
    partition_key: str("partitionKey"),
    sequence: { type: "integer", minimum: 1 },
    entity: {
      type: "object", additionalProperties: false, required: ["type", "id", "version"],
      properties: { type: str("catalogId"), id: str("pathParam"), version: { type: "integer", minimum: 0 } },
    },
    scope: {
      type: "object", additionalProperties: false, required: [],
      properties: { market: str("scopeValue"), organization: str("scopeValue"), zone: str("scopeValue"), tenant: str("scopeValue") },
    },
    classification: { type: "string", enum: [...C.PRIVACY_CLASSES] },
    occurred_at: dateTime,
    emitted_at: dateTime,
    payload: { type: "object" },
    payload_digest: str("digest"),
  },
};
const validateEnvelopeShape = C.compile(envelopeSchema);

function publishedEnvelopeSchema() {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://schemas.cosmicforge.internal/product-admin/event-envelope.v1.json", title: "CosmicForge Product Admin event envelope v1", ...envelopeSchema };
}

function payloadDigest(payload) {
  return C.digestOf(payload);
}

// Identity of an event for deduplication: same event_id with a different
// digest is a conflicting replay and must be quarantined, never applied.
function eventDigest(event) {
  return C.digestOf(event);
}

function createEvent(fields) {
  const event = { envelope: ENVELOPE, ...fields };
  event.payload_digest = payloadDigest(event.payload);
  return event;
}

const REASONS = Object.freeze([
  "ENVELOPE_INVALID", "PRODUCT_MISMATCH", "SOURCE_MISMATCH", "UNKNOWN_EVENT_FAMILY", "SCHEMA_ID_MISMATCH",
  "SCHEMA_VERSION_UNSUPPORTED", "SCHEMA_DRIFT", "FAMILY_NOT_CERTIFIED", "FAMILY_SUNSET", "DATASET_MISMATCH",
  "DATASET_NOT_SUBSCRIBED", "CLASSIFICATION_MISMATCH", "RESTRICTED_CLASSIFICATION", "DIGEST_MISMATCH",
  "PAYLOAD_INVALID", "SCOPE_INVALID", "SCOPE_DENIED", "TIMESTAMP_INVALID", "PARTITION_MISMATCH",
]);

function fail(reason) {
  return { ok: false, reason };
}

// Builds a validator from the event-family catalog of the product's ACTIVE,
// HQ-certified contract. Product-neutral: no product names appear here.
function createEventRegistry({ productId, sourceId, families, datasets }) {
  const byFamily = new Map(families.map((family) => [family.family, { ...family, validatePayload: C.compile(family.payload_schema) }]));
  const datasetById = new Map((datasets || []).map((d) => [d.dataset_id, d]));

  function validate(event, { allowedScope = {}, datasetId, partitionKey, now = Date.now() } = {}) {
    if (!validateEnvelopeShape(event).valid) return fail("ENVELOPE_INVALID");
    if (event.product_id !== productId) return fail("PRODUCT_MISMATCH");
    if (event.source_id !== sourceId) return fail("SOURCE_MISMATCH");
    const family = byFamily.get(event.family);
    if (!family) return fail("UNKNOWN_EVENT_FAMILY");
    if (event.schema_id !== family.schema_id) return fail("SCHEMA_ID_MISMATCH");
    const known = C.parseSemver(family.schema_version);
    const got = C.parseSemver(event.schema_version);
    if (got.major !== known.major) return fail("SCHEMA_VERSION_UNSUPPORTED");
    if (C.cmpSemver(event.schema_version, family.schema_version) > 0) return fail("SCHEMA_DRIFT");
    if (family.status === "NOT_CERTIFIED") return fail("FAMILY_NOT_CERTIFIED");
    if (family.status === "DEPRECATED" && family.sunset_at && Date.parse(family.sunset_at) <= now) return fail("FAMILY_SUNSET");
    if (event.dataset_id !== family.dataset_id) return fail("DATASET_MISMATCH");
    if (datasetId && event.dataset_id !== datasetId) return fail("DATASET_NOT_SUBSCRIBED");
    if (partitionKey && event.partition_key !== partitionKey) return fail("PARTITION_MISMATCH");
    if (event.classification === "RESTRICTED_PII") return fail("RESTRICTED_CLASSIFICATION");
    if (event.classification !== family.classification) return fail("CLASSIFICATION_MISMATCH");
    if (event.payload_digest !== payloadDigest(event.payload)) return fail("DIGEST_MISMATCH");
    if (!family.validatePayload(event.payload).valid) return fail("PAYLOAD_INVALID");
    if (family.projection === "METRIC_OBSERVATION" && C.metricObservationErrors(event.payload).length) return fail("PAYLOAD_INVALID");

    const dataset = datasetById.get(event.dataset_id);
    if (dataset) {
      for (const dim of Object.keys(event.scope)) if (!dataset.scope_dimensions.includes(dim)) return fail("SCOPE_INVALID");
      for (const dim of ["market", "organization"]) {
        if (dataset.scope_dimensions.includes(dim) && !event.scope[dim]) return fail("SCOPE_INVALID");
      }
    }
    for (const dim of C.SCOPE_DIMENSIONS) {
      const allowed = allowedScope[dim];
      if (allowed === undefined) continue;
      if (event.scope[dim] === undefined) return fail("SCOPE_DENIED");
      if (!allowed.includes(event.scope[dim])) return fail("SCOPE_DENIED");
    }
    const occurred = Date.parse(event.occurred_at);
    const emitted = Date.parse(event.emitted_at);
    if (occurred > emitted + SKEW_MS || emitted > now + SKEW_MS) return fail("TIMESTAMP_INVALID");
    return { ok: true, family, eventDigest: eventDigest(event) };
  }

  return { validate, families: byFamily };
}

// Contiguous-cursor rule: only `NEXT` may be applied and advance the cursor.
function sequenceDecision(lastSequence, sequence) {
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0 || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid_sequence");
  if (sequence <= lastSequence) return "ALREADY_SEEN";
  if (sequence === lastSequence + 1) return "NEXT";
  return "GAP";
}

// Never replace a newer authoritative entity version with an older one.
function entityVersionDecision(currentVersion, incomingVersion) {
  if (currentVersion === null || currentVersion === undefined) return "APPLY";
  if (incomingVersion > currentVersion) return "APPLY";
  if (incomingVersion === currentVersion) return "SAME";
  return "STALE";
}

module.exports = {
  ENVELOPE, REASONS, envelopeSchema, publishedEnvelopeSchema, payloadDigest, eventDigest, createEvent,
  createEventRegistry, sequenceDecision, entityVersionDecision, PACKAGE_VERSION: "1.0.0",
};
