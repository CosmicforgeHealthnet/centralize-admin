"use strict";

// Inert fixture results for the disposable fake CF Meet Admin Bridge. Every
// fixture is validated against the pinned schema by the fake Bridge before
// it is sent, so the tests can never pass on a response the real Bridge
// could not produce.

const { createHash, randomUUID } = require("node:crypto");
const R = require("../../src/bridge/contracts/registry");

const etag = (s) => createHash("sha256").update(String(s)).digest("hex");
const iso = (ms) => new Date(ms).toISOString();

function scopeOf(q) {
  return { product: "cfmeet", market: q.market, organization: q.organization, zone: q.zone, tenant: q.tenant };
}

function lastSegment(cap) {
  return cap.path.split("/").filter((s) => s && !s.startsWith("{")).slice(-1)[0];
}

function resourceItem(ref, kind, at) {
  return { id: ref, kind, status: "ACTIVE", version: 3, created_at: iso(at - 3600000), updated_at: iso(at), segment: "standard", open_items: 2 };
}

// ResourcePage (list collections).
function resourcePage(cap, q, { now = Date.now(), items = 2, nextCursor = null, coverage = "CONTEXT_SCOPED_PARTIAL" } = {}) {
  const kind = lastSegment(cap);
  return {
    contract_version: "cfmeet.admin-resources.v1", scope: scopeOf(q), as_of: iso(now), coverage,
    items: Array.from({ length: items }, (_, i) => resourceItem(kind + "-" + (i + 1), kind, now)), next_cursor: nextCursor,
  };
}

// ResourceDetail (one resource plus its history).
function resourceDetail(cap, q, id, { now = Date.now() } = {}) {
  return {
    contract_version: "cfmeet.admin-resources.v1", scope: scopeOf(q), as_of: iso(now), coverage: "COMPLETE",
    item: resourceItem(id, lastSegment(cap), now),
    history: [{ at: iso(now - 60000), action: "UPDATED", actor_ref: "owner-system", from_status: "PENDING", to_status: "ACTIVE", reason_code: null }],
  };
}

function verificationCase({ id = randomUUID(), kind = "PARTNER_GO_LIVE", state = "OPEN", now = Date.now() } = {}) {
  return {
    case_id: id, product: "cfmeet", kind, subject_ref: "workspace-1", state, version: 2, assignee_ref: null, submitted_at: iso(now - 7200000), updated_at: iso(now - 60000),
    evidence: [{ kind: "domain_ownership", ref: "evidence-1", sha256: etag("evidence-1") }],
  };
}

function verificationCasePage(q, { now = Date.now(), nextCursor = null } = {}) {
  return { contract_version: "cfmeet.admin-resources.v1", scope: scopeOf(q), as_of: iso(now), coverage: "COMPLETE", items: [verificationCase({ now }), verificationCase({ now, kind: "APP_REVIEW", state: "CLAIMED" })], next_cursor: nextCursor };
}

function verificationCaseDetail(q, id, { now = Date.now() } = {}) {
  return { contract_version: "cfmeet.admin-resources.v1", scope: scopeOf(q), as_of: iso(now), coverage: "COMPLETE", item: verificationCase({ id, now }),
    history: [{ at: iso(now - 60000), action: "SUBMITTED", actor_ref: "partner-1", from_status: null, to_status: "OPEN", reason_code: null }] };
}

// Summary cells. Under partial coverage the source withholds every cell.
function summary(q, keys, { now = Date.now(), coverage = "COMPLETE", values, unit = "count", currency = null, windowed = true } = {}) {
  return {
    contract_version: "cfmeet.admin-summary.v1", scope: scopeOf(q), as_of: iso(now), coverage,
    window: windowed && q.start ? { start: q.start, end: q.end } : null,
    cells: keys.map((key, i) => {
      const cellUnit = typeof unit === "function" ? unit(key) : unit;
      const cellCurrency = typeof currency === "function" ? currency(key) : currency;
      if (coverage !== "COMPLETE") return { key, value: null, unit: cellUnit, currency: cellCurrency, suppression: "PARTIAL_COVERAGE" };
      if (values && values[key] === null) return { key, value: null, unit: cellUnit, currency: cellCurrency, suppression: "SMALL_CELL" };
      return { key, value: values && values[key] !== undefined ? values[key] : 10 + i, unit: cellUnit, currency: cellCurrency, suppression: "NONE" };
    }),
  };
}

const MEETING_KEYS = ["meetings_started", "meetings_live_peak", "participants", "recordings_created"];
const FINANCE_KEYS = ["usage_minutes_free", "usage_minutes_pro", "usage_minutes_business", "charges_ngn", "charges_usd"];

function health({ now = Date.now(), status = "OK" } = {}) {
  return { as_of: iso(now), status, services: ["meeting-service", "messaging", "calling", "notifications"].map((service) => ({ service, status: status === "UNKNOWN" ? "UNKNOWN" : "OK", checked_at: iso(now - 5000) })) };
}

function capabilityStates({ policyRevision = 3, openapiSha256 = R.summary().source_artifacts.openapi_sha256, states = {} } = {}) {
  return {
    contract_version: R.summary().contract_version, openapi_sha256: openapiSha256, policy_revision: policyRevision,
    capabilities: R.CAPABILITIES.map((c) => ({ id: c.id, state: states[c.id] || (c.matrix_state === "BLOCKED_DEPENDENCY" ? "BLOCKED_DEPENDENCY" : c.matrix_state), blocker: null })),
  };
}

// Bridge dataset series (Track A §11 shape).
function datasetSeries(datasetId, q, { coverage = "COMPLETE", metrics, days, nextCursor = null } = {}) {
  const start = Date.parse(q.start);
  const end = Date.parse(q.end);
  const dates = [];
  for (let t = Math.floor(start / 86400000) * 86400000; t < end; t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
  const rows = (days || dates).map((date, i) => ({ date, metrics: typeof metrics === "function" ? metrics(date, i) : { ...(metrics || {}) } }));
  return { dataset_id: datasetId, coverage, window: { start: q.start, end: q.end }, series: rows, next_cursor: nextCursor };
}

function projectionStatus({ now = Date.now(), head = 0, consumer = null, lag = 0, coverage = "COMPLETE" } = {}) {
  const src = (source_service, entity_type) => ({ source_service, entity_type, projections: 1, last_received_at: iso(now), lag_seconds: 1, open_gaps: 0, freshness: "LIVE", coverage, last_backfill_status: coverage === "COMPLETE" ? "COMPLETE" : "NONE" });
  return {
    as_of: iso(now), freshness_threshold_seconds: 900, quarantined: 0, head_sequence: head, consumer_lag: consumer ? { [consumer]: lag } : {},
    // One source per pinned adapter (owner service + entity type).
    sources: [...new Map(require("../../src/bridge/contracts/cfmeet-event-adapters.v1.json").adapters.map((a) => [a.source_service + "|" + a.entity_type, src(a.source_service, a.entity_type)])).values()],
  };
}

function commandResult(operationId, { status = "CONFIRMED", version = 4, now = Date.now() } = {}) {
  return { operation_id: operationId, status, source_version: version, reason_code: null, receipt: { recorded_version: version, recorded_at: iso(now) } };
}

function operationStatus(idempotencyKey, capabilityId, { status = "SUCCEEDED", sourceStatus = null, version = 4, now = Date.now() } = {}) {
  const settled = status === "SUCCEEDED" || status === "FAILED";
  return { idempotency_key: idempotencyKey, capability_id: capabilityId, status, source_status: sourceStatus, source_version: settled ? version : null, settled_at: settled ? iso(now) : null };
}

function operationRecord(operationId, { status = "CONFIRMED", version = 4, now = Date.now() } = {}) {
  return { operation_id: operationId, status, source_version: version, reason_code: null, updated_at: iso(now) };
}

// Synthetic owner events in the exact Bridge export shape.
function ownerEvent({ sequence, type, source, entityType, ref, version = 1, scope, tombstone = false, payload, classification = "OPERATIONS_MINIMIZED", now = Date.now(), eventId = randomUUID() }) {
  return {
    schema: "cosmicforge.product-admin-event.v1", event_id: eventId, sequence, event_type: type, source_service: source,
    product: "cfmeet", entity_type: entityType, entity_ref: ref, entity_version: version, tombstone, occurred_at: iso(now - 1000), emitted_at: iso(now),
    market: scope.market, scope: { zone: scope.zone, organization: scope.organization, tenant: scope.tenant }, classification, correlation_id: "corr-" + sequence,
    payload: tombstone ? {} : payload,
  };
}

function abuseEvent({ sequence, source = "messaging", ref = "report-1", version = 1, status = "OPEN", severity = "MEDIUM", scope, tombstone = false, now = Date.now(), eventId, extra = {} }) {
  return ownerEvent({ sequence, type: "abuse.report.changed.v1", source, entityType: "abuse_report", ref, version, scope, tombstone, now, eventId, classification: "SAFETY_EVIDENCE",
    payload: { status, severity, assignee: null, created_at: iso(now - 3600000), ...extra } });
}

function verificationEvent({ sequence, ref = "vcase-1", version = 1, state = "OPEN", kind = "PARTNER_GO_LIVE", scope, now = Date.now() }) {
  return ownerEvent({ sequence, type: "verification.case.changed.v1", source: "developer-platform", entityType: "verification_case", ref, version, scope, now,
    payload: { kind, state, assignee: null, submitted_at: iso(now - 7200000) } });
}

function partnerEvent({ sequence, ref = "ws-1", version = 1, state = "ACTIVE", scope, now = Date.now() }) {
  return ownerEvent({ sequence, type: "partner.workspace.changed.v1", source: "developer-platform", entityType: "partner_workspace", ref, version, scope, now,
    payload: { state, live: state === "ACTIVE", support_tier: "standard", updated_at: iso(now - 1000) } });
}

function incidentEvent({ sequence, source = "meeting-service", ref = "inc-1", version = 1, status = "OPEN", severity = "SEV3", scope, now = Date.now() }) {
  return ownerEvent({ sequence, type: "incident.changed.v1", source, entityType: "incident", ref, version, scope, now,
    payload: { status, severity, opened_at: iso(now - 600000), resolved_at: null } });
}

module.exports = {
  resourcePage, resourceDetail, verificationCase, verificationCasePage, verificationCaseDetail, summary, health, capabilityStates, datasetSeries,
  projectionStatus, commandResult, operationRecord, operationStatus, ownerEvent, abuseEvent, verificationEvent, partnerEvent, incidentEvent,
  MEETING_KEYS, FINANCE_KEYS, etag, iso,
};
