"use strict";

// Inert fixture results for the disposable fake Bridge. Every fixture is
// validated against the pinned KarryGo schema by the fake Bridge before it
// is sent, so the tests can never pass on a response the real Bridge could
// not produce.

const { createHash, randomUUID } = require("node:crypto");
const components = require("../../src/bridge/contracts/karrygo-bridge-schemas.v1.json").components.schemas;

const etag = (s) => createHash("sha256").update(String(s)).digest("hex");
const iso = (ms) => new Date(ms).toISOString();

function constOf(schemaName, prop) {
  const p = components[schemaName].properties[prop];
  return p.const !== undefined ? p.const : p.enum ? p.enum[0] : undefined;
}

function scopeOf(q) {
  return { product: "karryam", market: q.market, zone: q.zone, organization: q.organization, tenant: q.tenant };
}

function resourceItem(ref, kind, at) {
  return {
    reference: ref, kind, status: "ACTIVE", source_version: 3, snapshot_etag: etag(ref), created_at: iso(at - 3600000), updated_at: iso(at),
    dimensions: [{ name: "segment", value: "standard", flag: null }], counters: [{ name: "open_items", value: 2 }],
    references: [{ kind: "owner", reference: "owner-" + ref }], timeline: [], timeline_truncated: false,
  };
}

// OwnerResourcesSnapshot / VendorResourcesSnapshot / SupportResourcesSnapshot.
function resourceSnapshot(schemaName, cap, q, { now = Date.now(), items = 2, nextCursor = "" } = {}) {
  const kind = cap.path.split("/").filter((s) => s && !s.startsWith("{")).slice(-1)[0];
  return {
    contract_version: constOf(schemaName, "contract_version"), owner: cap.owner, kind, scope: scopeOf(q),
    policy_id: "policy-" + cap.module, policy_version: 1, policy_checksum: etag("policy"), as_of: iso(now), coverage: constOf(schemaName, "coverage"),
    items: Array.from({ length: items }, (_, i) => resourceItem(kind + "-" + (i + 1), kind, now)), next_cursor: nextCursor,
  };
}

function taxiSnapshot(q, { now = Date.now(), nextCursor } = {}) {
  const out = {
    contract_version: "1.0", scope: { market: q.market, zone: q.zone, organization: q.organization, tenant: q.tenant }, policy_id: "policy-taxi", policy_version: 1, policy_checksum: etag("taxi"),
    as_of: iso(now), freshness: "LIVE", coverage: "PARTIAL_COVERAGE",
    items: [{ id: randomUUID(), status: "COMPLETED", mode: "STANDARD", source_context: "booking", source_version: null, updated_at: iso(now), created_at: iso(now - 60000) }],
    events: [], history_truncated: false,
  };
  if (nextCursor !== undefined) out.next_cursor = nextCursor;
  return out;
}

function release(metric, keys, q, { now = Date.now(), coverage = "COMPLETE", values } = {}) {
  return {
    policy_id: "policy-analytics", policy_version: 1, policy_checksum: etag("analytics"), scope: scopeOf(q), metric, source_version: "analytics-v7",
    as_of: iso(now), freshness: "LIVE", coverage,
    // Under partial coverage the source itself withholds every cell.
    cells: keys.map((key, i) => (coverage !== "COMPLETE" ? { key, value: null, suppression: "PARTIAL_COVERAGE" }
      : values && values[key] === null ? { key, value: null, suppression: "SMALL_CELL" } : { key, value: values && values[key] !== undefined ? values[key] : 10 + i, suppression: "NONE" })),
  };
}

const MISSION_OUTCOME_KEYS = ["committed", "assigned", "completed", "failed", "cancelled", "recovery_resolved", "recovery_failed", "guarantee_breaches"];
const READINESS_KEYS = ["ready_count", "on_time_count", "late_count", "lateness_seconds_total", "prep_seconds_total", "prep_count"];

function financeReport(q, { now = Date.now(), completeness = "COMPLETE" } = {}) {
  return {
    contract_version: "karryam.finance-report.v1", owner: "payment-wallet-service", period_start: q.start, period_end: q.end, timezone: "UTC",
    data_as_of: iso(now - 60000), source_watermark: iso(now - 120000), aggregation_version: "wallet-agg-3", unit: "MINOR_UNITS",
    definitions: [
      { measure: "wallet_topups", source_field: "wallet_ledger.credit", calculation: "sum of settled top-up credits", recognition: "NOT_REVENUE", correction: "late settlements restate the period" },
      { measure: "trip_fares_settled", source_field: "settlement.fare", calculation: "sum of settled fares", recognition: "SOURCE_FIGURE_RECOGNITION_POLICY_PENDING", correction: "refunds restate the period" },
    ],
    figures: [
      { measure: "wallet_topups", currency: "NGN", amount_minor: 125000000, count: 410, completeness },
      { measure: "wallet_topups", currency: "USD", amount_minor: 99000, count: 3, completeness },
      { measure: "trip_fares_settled", currency: "NGN", amount_minor: null, count: null, completeness: "PARTIAL_COVERAGE", unknown_reason: "settlement_batch_pending" },
    ],
    completeness,
  };
}

function projectionStatus({ now = Date.now(), head = 0, consumer = null, lag = 0, coverage = "COMPLETE" } = {}) {
  return {
    as_of: iso(now), freshness_threshold_seconds: 900, quarantined: 0, head_sequence: head, consumer_lag: consumer ? { [consumer]: lag } : {},
    sources: [
      { source_service: "notification-service", entity_type: "campaign_revision", projections: 1, last_received_at: iso(now), lag_seconds: 1, open_gaps: 0, freshness: "LIVE", coverage, last_backfill_status: coverage === "COMPLETE" ? "COMPLETE" : "NONE" },
      { source_service: "support-dispute-service", entity_type: "support_case", projections: 1, last_received_at: iso(now), lag_seconds: 1, open_gaps: 0, freshness: "LIVE", coverage, last_backfill_status: coverage === "COMPLETE" ? "COMPLETE" : "NONE" },
      { source_service: "verification-compliance-service", entity_type: "vendor_verification_case", projections: 1, last_received_at: iso(now), lag_seconds: 1, open_gaps: 0, freshness: "LIVE", coverage, last_backfill_status: coverage === "COMPLETE" ? "COMPLETE" : "NONE" },
    ],
  };
}

// Synthetic owner events in the exact Bridge export shape.
function supportEvent({ sequence, ref = "case-1", version = 1, status = "OPEN", priority = "NORMAL", scope, tombstone = false, now = Date.now(), eventId = randomUUID(), extra = {} }) {
  return {
    schema: "cosmicforge.product-admin-event.v1", event_id: eventId, sequence, event_type: "karryam.support.case.updated.v1", source_service: "support-dispute-service",
    product: "karryam", entity_type: "support_case", entity_ref: ref, entity_version: version, tombstone, occurred_at: iso(now - 1000), emitted_at: iso(now),
    market: scope.market, scope: { zone: scope.zone, organization: scope.organization, tenant: scope.tenant }, classification: "OPERATIONS_MINIMIZED", correlation_id: "corr-" + sequence,
    payload: tombstone ? {} : {
      status, priority, service_type: "TAXI", category: null, complainant_type: "CUSTOMER", context_type: null, locale: "en", sla_state: "POLICY_UNAVAILABLE",
      consent_classification: "OPERATIONS_MINIMIZED", assignee: null, escalation_level: null, mission_ref: null, order_ref: null, dispute_ref: null,
      unread_count: 1, message_count: 2, evidence_count: 0, created_at: iso(now - 3600000), updated_at: iso(now - 1000), ...extra,
    },
  };
}

function verificationEvent({ sequence, ref = "vcase-1", version = 1, status = "PENDING_REVIEW", scope, now = Date.now() }) {
  return {
    schema: "cosmicforge.product-admin-event.v1", event_id: randomUUID(), sequence, event_type: "karryam.verification.case.updated.v1", source_service: "verification-compliance-service",
    product: "karryam", entity_type: "vendor_verification_case", entity_ref: ref, entity_version: version, tombstone: false, occurred_at: iso(now - 1000), emitted_at: iso(now),
    market: scope.market, scope: { zone: scope.zone, organization: scope.organization, tenant: scope.tenant }, classification: "OPERATIONS_MINIMIZED", correlation_id: "corr-v" + sequence,
    payload: { status, dimension: "BUSINESS", subject_type: "vendor", business_ref: "biz-1", automation_recommendation: "REVIEW_REQUIRED", reason_code: null, expires_at: null, updated_at: iso(now - 1000) },
  };
}

function campaignEvent({ sequence, campaign = "camp-1", revision = 1, version = 1, scope, now = Date.now(), receipts = false, counts = {} }) {
  return {
    schema: "cosmicforge.product-admin-event.v1", event_id: randomUUID(), sequence, event_type: "karryam.marketing.campaign.updated.v1", source_service: "notification-service",
    product: "karryam", entity_type: "campaign_revision", entity_ref: campaign + ":" + revision, entity_version: version, tombstone: false, occurred_at: iso(now - 1000), emitted_at: iso(now),
    market: scope.market, scope: { zone: scope.zone, organization: scope.organization, tenant: scope.tenant }, classification: "INTERNAL", correlation_id: "corr-c" + sequence,
    payload: { campaign_id: campaign, revision, state: "SENT", rejection_code: null, audience_count: 100, eligible_count: 90, suppressed_count: 10, queued_count: 0, sent_count: 80, logged_only_count: 5, failed_count: 5,
      delivered_count: receipts ? 70 : null, delivery_confirmation: receipts ? "PROVIDER_RECEIPTS" : "UNAVAILABLE", updated_at: iso(now - 1000), ...counts },
  };
}

module.exports = { resourceSnapshot, taxiSnapshot, release, financeReport, projectionStatus, supportEvent, verificationEvent, campaignEvent, MISSION_OUTCOME_KEYS, READINESS_KEYS, etag, iso };
