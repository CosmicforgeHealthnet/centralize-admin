"use strict";

// Stage A event verification. The Bridge feed envelope
// (cosmicforge.product-admin-event.v1, KarryGo shared/go/adminevents) is NOT
// the Product Admin -> HQ envelope: it is verified here against the pinned
// adapters and never forwarded raw. Only minimized, allowlisted fields of
// the three exported event types survive.

const { createHash } = require("node:crypto");
const { contracts } = require("../packages");
const pinned = require("../bridge/contracts/karrygo-event-adapters.v1.json");

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SKEW_MS = 5 * 60 * 1000;
const ADAPTERS = new Map(pinned.adapters.map((a) => [a.export_type, a]));

const REASONS = Object.freeze([
  "EVENT_TOO_LARGE", "EVENT_SHAPE_INVALID", "PRODUCT_MISMATCH", "SCHEMA_UNSUPPORTED", "EVENT_TYPE_UNKNOWN", "SOURCE_MISMATCH",
  "ENTITY_TYPE_MISMATCH", "CLASSIFICATION_NOT_EXPORTABLE", "CLASSIFICATION_MISMATCH", "PAYLOAD_FIELD_UNKNOWN", "PAYLOAD_FIELD_INVALID",
  "PAYLOAD_FIELD_MISSING", "TOMBSTONE_WITH_PAYLOAD", "SCOPE_MISMATCH", "TIMESTAMP_INVALID", "SEQUENCE_INVALID",
]);

function eventDigest(event) {
  return contracts.digestOf(event);
}

// Digest of bytes that may not even parse (quarantine evidence only).
function rawDigest(value) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return "sha256:" + createHash("sha256").update(String(text)).digest("hex");
}

function checkField(field, value) {
  if (value === null || value === undefined) return !field.required;
  switch (field.kind) {
    case "OPAQUE": case "OPAQUE_NULLABLE": return typeof value === "string" && OPAQUE.test(value);
    case "COUNT": return Number.isSafeInteger(value) && value >= 0;
    case "BOOL": return typeof value === "boolean";
    case "ENUM": return typeof value === "string" && field.enum.includes(value);
    case "TIME": case "TIME_NULLABLE": return typeof value === "string" && TIME.test(value) && !Number.isNaN(Date.parse(value));
    default: return false;
  }
}

// A source dimension that is "" means the owner does not record it; it
// matches the partition (Bridge hqevents.Scope semantics). Any other value
// must equal the partition's value exactly.
function scopeMatches(event, partition) {
  const dims = { market: event.market, zone: event.scope && event.scope.zone, organization: event.scope && event.scope.organization, tenant: event.scope && event.scope.tenant };
  return Object.entries(dims).every(([dim, value]) => typeof value === "string" && (value === "" || value === partition[dim]));
}

/**
 * Verifies one Bridge feed event for a partition. Returns
 *   { ok: true, adapter, payload, digest }  or  { ok: false, reason, digest }.
 */
function verifyEvent(event, partition, { now = Date.now() } = {}) {
  const digest = rawDigest(event);
  const fail = (reason) => ({ ok: false, reason, digest });
  if (Buffer.byteLength(JSON.stringify(event) || "") > pinned.max_event_bytes) return fail("EVENT_TOO_LARGE");
  if (!event || typeof event !== "object" || Array.isArray(event)) return fail("EVENT_SHAPE_INVALID");
  if (event.product !== "karryam") return fail("PRODUCT_MISMATCH");
  if (event.schema !== pinned.export_schema) return fail("SCHEMA_UNSUPPORTED");
  if (!UUID.test(String(event.event_id)) || !OPAQUE.test(String(event.entity_ref)) || !OPAQUE.test(String(event.correlation_id || "x")) || typeof event.tombstone !== "boolean") return fail("EVENT_SHAPE_INVALID");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isSafeInteger(event.entity_version) || event.entity_version < 1) return fail("SEQUENCE_INVALID");
  const adapter = ADAPTERS.get(event.event_type);
  if (!adapter) return fail("EVENT_TYPE_UNKNOWN");
  if (event.source_service !== adapter.source_service) return fail("SOURCE_MISMATCH");
  if (event.entity_type !== adapter.entity_type) return fail("ENTITY_TYPE_MISMATCH");
  if (!pinned.exportable_classifications.includes(event.classification)) return fail("CLASSIFICATION_NOT_EXPORTABLE");
  if (event.classification !== adapter.classification) return fail("CLASSIFICATION_MISMATCH");
  if (!scopeMatches(event, partition)) return fail("SCOPE_MISMATCH");
  const occurred = Date.parse(event.occurred_at);
  const emitted = Date.parse(event.emitted_at);
  if (!TIME.test(String(event.occurred_at)) || !TIME.test(String(event.emitted_at)) || occurred > emitted + SKEW_MS || emitted > now + SKEW_MS) return fail("TIMESTAMP_INVALID");
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("EVENT_SHAPE_INVALID");
  const out = {};
  if (event.tombstone) {
    if (Object.keys(payload).length) return fail("TOMBSTONE_WITH_PAYLOAD");
  } else {
    for (const key of Object.keys(payload)) if (!adapter.fields[key]) return fail("PAYLOAD_FIELD_UNKNOWN");
    for (const [name, field] of Object.entries(adapter.fields)) {
      const value = payload[name];
      if ((value === undefined || value === null) && field.required) return fail("PAYLOAD_FIELD_MISSING");
      if (!checkField(field, value)) return fail("PAYLOAD_FIELD_INVALID");
      out[name] = value === undefined ? null : value;
    }
  }
  return { ok: true, adapter, payload: out, digest: eventDigest(event) };
}

module.exports = { verifyEvent, eventDigest, rawDigest, scopeMatches, ADAPTERS, REASONS, PINNED_ADAPTERS: pinned };
