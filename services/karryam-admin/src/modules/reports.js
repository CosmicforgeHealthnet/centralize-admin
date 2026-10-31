"use strict";

// First-wave operational reports (Section 11). Each report states its source,
// grain, definition, units, observation time, scope and coverage. Values are
// either source-released figures (Bridge) or counts over Karryam Admin's own
// minimized projections; nothing is estimated, and counts from different
// services are never added together (no cross-service double counting).

const { contracts } = require("../packages");
const R = require("../bridge/contracts/registry");
const { protocolMapping } = require("../bridge/errors");
const { bridgeStaffContext, StaffContextError } = require("../bridge/capabilities");
const { qualityOf } = require("./quality");

const P = contracts.ProtocolError;
const SCOPE = new RegExp(contracts.PATTERNS.scopeValue);
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;

const blocked = (code, detail) => ({ code, detail });

// kind BRIDGE: live source release; kind LOCAL: Karryam Admin projections or
// pipeline state; kind BLOCKED: no source contract exists.
const REPORTS = Object.freeze([
  { id: "operational_activity", title: "Operational activity by market, organization and zone", kind: "BRIDGE", capability: "analytics.scoped.mission-outcomes.read", authorities: ["TAXI", "DISPATCH", "HAULING"], grain: "WINDOW", units: ["count"], definition: "Analytics-released mission outcome cells per authority for the requested scope and window; one row per authority, never summed across authorities" },
  { id: "taxi_status", title: "Taxi source-confirmed counts and status distribution", kind: "BRIDGE", capability: "analytics.scoped.mission-outcomes.read", authorities: ["TAXI"], grain: "WINDOW", units: ["count"], definition: "Analytics-released TAXI mission outcome cells (committed, assigned, completed, failed, cancelled, recovery, guarantee breaches)" },
  { id: "dispatch_status", title: "Dispatch source-confirmed counts and status distribution", kind: "BRIDGE", capability: "analytics.scoped.mission-outcomes.read", authorities: ["DISPATCH"], grain: "WINDOW", units: ["count"], definition: "Analytics-released DISPATCH mission outcome cells" },
  { id: "hauling_status", title: "Hauling source-confirmed counts and status distribution", kind: "BRIDGE", capability: "analytics.scoped.mission-outcomes.read", authorities: ["HAULING"], grain: "WINDOW", units: ["count"], definition: "Analytics-released HAULING mission outcome cells" },
  { id: "fleet_status", title: "Corporate Fleet source-confirmed counts and status distribution", kind: "BLOCKED", grain: "WINDOW", units: ["count"], definition: "No source-released Fleet aggregate exists", blocker: blocked("NO_SOURCE_AGGREGATE", "The Bridge analytics contract measures TAXI, DISPATCH and HAULING only; Fleet counts would have to be invented from resource pages, which is not allowed") },
  { id: "vendor_readiness", title: "Vendor readiness and fulfilment", kind: "BRIDGE", capability: "analytics.scoped.readiness-components.read", authorities: ["VENDOR"], grain: "WINDOW", units: ["count"], definition: "Analytics-released VENDOR readiness components; figures are withheld unless the source reports COMPLETE cohort coverage", requireComplete: true },
  { id: "support_queue", title: "Support and SOS queue status and response timing", kind: "LOCAL", source: { source_service: "support-dispute-service", entity_type: "support_case" }, fields: ["status", "priority"], grain: "SNAPSHOT", units: ["count"], definition: "Current support-case projections by status and priority; response timing is not released by the source (sla_state POLICY_UNAVAILABLE)" },
  { id: "wallet_by_currency", title: "Wallet reporting by currency", kind: "BRIDGE", capability: "hq.finance.report", grain: "PERIOD", units: ["minor_currency", "count"], definition: "Wallet-owned finance report figures per measure and currency in minor units; currencies are never combined and nothing is relabelled as revenue" },
  { id: "payment_reconciliation", title: "Payment and reconciliation status", kind: "BRIDGE", capability: "hq.finance.report", grain: "PERIOD", units: ["minor_currency", "count"], definition: "Completeness, source watermark, aggregation version and per-measure definitions of the wallet-owned finance report" },
  { id: "verification_pipeline", title: "Verification case pipeline", kind: "LOCAL", source: { source_service: "verification-compliance-service", entity_type: "vendor_verification_case" }, fields: ["status", "dimension", "automation_recommendation"], grain: "SNAPSHOT", units: ["count"], definition: "Current vendor verification case projections by status, dimension and automated recommendation (recommendations are not decisions)" },
  { id: "marketing_evidence", title: "Marketing consent and campaign execution evidence", kind: "LOCAL", source: { source_service: "notification-service", entity_type: "campaign_revision" }, grain: "SNAPSHOT", units: ["count"], definition: "Latest projected revision per campaign; delivered only with provider receipts; LOGGED_ONLY never counted as delivered; consent aggregates are not released by the source" },
  { id: "connector_health", title: "Source, Bridge and Karryam Admin connector health", kind: "LOCAL", grain: "SNAPSHOT", units: ["count"], definition: "Bridge connector configuration, request outcome counters since start, client certificate expiry and last successful feed per partition" },
  { id: "sync_lag", title: "Synchronization lag and gap counts", kind: "LOCAL", grain: "SNAPSHOT", units: ["count"], definition: "Per partition: Bridge head, committed cursor, acknowledged sequence, lag, open entity-version gaps and hold state" },
  { id: "quarantine_reconciliation", title: "Quarantine and reconciliation status", kind: "LOCAL", grain: "SNAPSHOT", units: ["count"], definition: "Unresolved quarantined events by reason and the latest run of each pipeline stage" },
]);
const BY_ID = new Map(REPORTS.map((r) => [r.id, r]));

function reportCapabilities(config) {
  return REPORTS.map((r) => {
    let state = "READ_ONLY";
    let blockers = [];
    if (r.kind === "BLOCKED") { state = "BLOCKED_DEPENDENCY"; blockers = [r.blocker]; }
    else if (r.kind === "BRIDGE" && !config.bridge.enabled) { state = "BLOCKED_DEPENDENCY"; blockers = [blocked("BRIDGE_TRUST_NOT_ENROLLED", "Bridge mTLS identity, HMAC key and staff signing key are not enrolled for this environment")]; }
    else if (r.kind === "LOCAL" && !config.feed.enabled && r.id !== "connector_health") { state = "BLOCKED_DEPENDENCY"; blockers = [blocked("BRIDGE_FEED_NOT_ENABLED", "The Stage A Bridge event consumer is not enabled for this environment")]; }
    return { id: "karryam.report." + r.id, version: "1.0.0", kind: "READ", state, risk: r.capability === "hq.finance.report" ? "R2" : "R1", description: r.title.slice(0, 240), datasets: [], blockers, requires_recent_mfa: true, requires_independent_approval: false, request_schema: null };
  });
}

function parseReportQuery(searchParams, report, now) {
  const allowed = new Set(["market", "organization", "zone", "tenant", "purpose"]);
  if (report.kind === "BRIDGE") { allowed.add("start"); allowed.add("end"); }
  if (report.capability && report.capability.startsWith("analytics.")) allowed.add("product_code");
  if (report.capability === "hq.finance.report") allowed.add("timezone");
  const q = {};
  for (const [key, raw] of searchParams) {
    if (!allowed.has(key)) throw new P("INVALID_REQUEST", "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
    if (Object.prototype.hasOwnProperty.call(q, key)) throw new P("INVALID_REQUEST", "DUPLICATE_PARAMETER");
    q[key] = raw;
  }
  for (const dim of ["market", "organization"]) if (!q[dim] || !SCOPE.test(q[dim])) throw new P("INVALID_REQUEST", "SCOPE_" + dim.toUpperCase() + "_REQUIRED");
  for (const dim of ["zone", "tenant"]) if (q[dim] !== undefined && !SCOPE.test(q[dim])) throw new P("INVALID_REQUEST", "SCOPE_INVALID");
  if (!q.purpose || !PURPOSE.test(q.purpose)) throw new P("INVALID_REQUEST", "PURPOSE_REQUIRED");
  if (report.kind === "BRIDGE") {
    if (!q.zone || !q.tenant) throw new P("INVALID_REQUEST", "SCOPE_ZONE_AND_TENANT_REQUIRED");
    for (const k of ["start", "end"]) if (q[k] !== undefined && !DATE_TIME.test(q[k])) throw new P("INVALID_REQUEST", "TIME_WINDOW_INVALID");
    const end = q.end ? Date.parse(q.end) : now;
    const start = q.start ? Date.parse(q.start) : end - 24 * 3600 * 1000;
    if (!(end > start) || end - start > R.MAX_WINDOW_MS || end > now + 60000) throw new P("INVALID_REQUEST", "TIME_WINDOW_INVALID");
    q.start = new Date(start).toISOString();
    q.end = new Date(end).toISOString();
  }
  if (allowed.has("product_code") && (!q.product_code || !SCOPE.test(q.product_code))) throw new P("INVALID_REQUEST", "PRODUCT_CODE_REQUIRED");
  if (allowed.has("timezone")) { if (!q.timezone) q.timezone = "UTC"; if (!TIMEZONE.test(q.timezone)) throw new P("INVALID_REQUEST", "TIMEZONE_INVALID"); }
  return q;
}

// A local report covers only partitions whose full scope is explicitly
// delegated (no implicit "all zones") and matches the requested filters.
function partitionsInScope(partitions, delegation, q) {
  const s = delegation.scope || {};
  const has = (dim, v) => Array.isArray(s[dim]) && s[dim].includes(v);
  return partitions.filter((p) => p.market === q.market && p.organization === q.organization && (!q.zone || p.zone === q.zone) && (!q.tenant || p.tenant === q.tenant) &&
    has("market", p.market) && has("organization", p.organization) && has("zone", p.zone) && has("tenant", p.tenant));
}

function createReports({ config, bridgeClient, store, audit, bridgeMetrics = {}, now = Date.now }) {
  const productId = config.productId;

  function envelope(ctx, report, q, { asOf = null, freshness = "UNKNOWN", coverage = "UNKNOWN", quality = "UNKNOWN", rows = [], blockers = [], source, scope, extra = {} }) {
    return {
      body: contracts.okEnvelope({
        productId, correlationId: ctx.correlationId, asOf, freshness, coverage,
        result: {
          report_id: report.id, title: report.title, definition: report.definition, grain: report.grain, units: report.units,
          source, scope, filters: { purpose: q.purpose, start: q.start || null, end: q.end || null }, observed_at: asOf, quality, rows, blockers, ...extra,
        },
      }, now()),
    };
  }

  async function bridgeReport(ctx, report, q) {
    if (!config.bridge.enabled || !bridgeClient) throw new P("UNAVAILABLE", "BRIDGE_TRUST_NOT_ENROLLED");
    if (q.market !== config.bridge.market || q.organization !== config.bridge.organization) throw new P("FORBIDDEN", "SCOPE_NOT_ENROLLED");
    let staff;
    try { staff = bridgeStaffContext(ctx.delegation, config.bridge, Math.floor(now() / 1000), { zone: q.zone, tenant: q.tenant }); }
    catch (err) { throw new P("FORBIDDEN", err instanceof StaffContextError ? err.reason : "STAFF_CONTEXT_INVALID"); }
    const scope = { market: q.market, organization: q.organization, zone: q.zone, tenant: q.tenant };
    const base = { market: q.market, organization: q.organization, purpose: q.purpose, zone: q.zone, tenant: q.tenant, start: q.start, end: q.end };
    const cap = R.capability(report.capability);
    const source = { kind: "BRIDGE", owner: cap.owner, bridge_capability_id: cap.id, contract_version: R.summary().contract_version };
    const call = async (query, body) => {
      try { return await bridgeClient.call(cap.id, { staff, query, body }); }
      catch (err) { const m = protocolMapping(err); throw new P(m.code, m.reason, { retryable: m.retryable }); }
    };
    if (report.capability === "hq.finance.report") {
      const res = await call({ ...base, limit: 1 }, { timezone: q.timezone });
      const fr = res.result;
      const complete = fr.completeness === "COMPLETE";
      const quality = qualityOf(res.freshness, complete ? "COMPLETE" : "PARTIAL_COVERAGE");
      const rows = report.id === "wallet_by_currency"
        ? fr.figures.map((f) => ({ measure: f.measure, currency: f.currency, unit: "MINOR_UNITS", amount_minor: f.amount_minor, count: f.count, completeness: f.completeness, unknown_reason: f.unknown_reason || null, recognition: (fr.definitions.find((d) => d.measure === f.measure) || {}).recognition || "NOT_REVENUE" }))
        : fr.definitions.map((d) => ({ measure: d.measure, recognition: d.recognition, calculation: d.calculation, source_field: d.source_field, correction: d.correction, currencies: [...new Set(fr.figures.filter((f) => f.measure === d.measure).map((f) => f.currency))], completeness: (fr.figures.find((f) => f.measure === d.measure) || {}).completeness || "PARTIAL_COVERAGE" }));
      return envelope(ctx, report, q, { asOf: fr.data_as_of, freshness: quality.freshness, coverage: quality.coverage, quality: quality.label, rows, source, scope,
        extra: { period: { start: fr.period_start, end: fr.period_end, timezone: fr.timezone }, source_watermark: fr.source_watermark, aggregation_version: fr.aggregation_version, unit: fr.unit, completeness: fr.completeness, error_reason: fr.error_reason || null } });
    }
    // Analytics releases: one source call per authority, one row each.
    const rows = [];
    let asOf = null;
    let allComplete = true;
    let anyStale = false;
    for (const authority of report.authorities) {
      const res = await call({ ...base, authority, product_code: q.product_code });
      const rel = res.result;
      const complete = rel.coverage === "COMPLETE";
      allComplete = allComplete && complete;
      anyStale = anyStale || rel.freshness === "STALE";
      asOf = !asOf || Date.parse(rel.as_of) < Date.parse(asOf) ? rel.as_of : asOf;
      const cells = (rel.cells || rel.components || []).map((c) => ({ key: c.key || c.name, value: report.requireComplete && !complete ? null : (c.value === undefined ? null : c.value), suppression: report.requireComplete && !complete ? "PARTIAL_COVERAGE" : (c.suppression || "NONE") }));
      rows.push({ authority, coverage: rel.coverage, freshness: rel.freshness, source_version: rel.source_version || null, policy_id: rel.policy_id, policy_version: rel.policy_version, observed_at: rel.as_of, cells, raw_metric: rel.metric || null });
    }
    const quality = qualityOf(anyStale ? "STALE" : "LIVE", allComplete ? "COMPLETE" : "PARTIAL_COVERAGE");
    return envelope(ctx, report, q, { asOf, freshness: quality.freshness, coverage: quality.coverage, quality: quality.label, rows, source, scope });
  }

  async function localReport(ctx, report, q) {
    if (!store && report.id !== "connector_health") throw new P("UNAVAILABLE", "PIPELINE_STORE_UNAVAILABLE");
    const summary = store ? await store.pipelineSummary() : { partitions: [], quarantine: [], runs: [], coverage: [] };
    const parts = partitionsInScope(summary.partitions, ctx.delegation, q);
    const scope = { market: q.market, organization: q.organization, zone: q.zone || null, tenant: q.tenant || null, partitions: parts.map((p) => p.partition_key) };
    const source = { kind: "LOCAL", owner: "karryam-admin", derived_from: report.source ? report.source.source_service + "/" + report.source.entity_type + " via Bridge feed" : "karryam-admin pipeline state" };
    if (report.id === "connector_health") {
      const rows = [{ bridge: config.bridge.enabled ? "CONFIGURED_NOT_CERTIFIED" : "DISABLED", client_certificate_not_after: config.bridge.enabled ? config.bridge.clientIdentity.notAfter : null, feed: config.feed.enabled ? "ENABLED" : "DISABLED", counters: { ...bridgeMetrics } }];
      for (const p of parts) rows.push({ partition_key: p.partition_key, last_success_at: p.last_success_at, last_ack_at: p.last_ack_at, last_error_code: p.last_error_code });
      return envelope(ctx, report, q, { asOf: new Date(now()).toISOString(), freshness: "FRESH", coverage: "COMPLETE", quality: "LIVE", rows, source, scope });
    }
    if (!parts.length) {
      return envelope(ctx, report, q, { rows: [], blockers: [blocked("NO_AUTHORIZED_PARTITION", "No Bridge feed partition matches the delegated scope")], source, scope });
    }
    if (report.id === "sync_lag" || report.id === "quarantine_reconciliation") {
      const asOf = new Date(now()).toISOString();
      const rows = report.id === "sync_lag"
        ? parts.map((p) => ({ partition_key: p.partition_key, head_sequence: p.head_sequence === null ? null : Number(p.head_sequence), committed_sequence: Number(p.last_sequence), acked_sequence: Number(p.acked_sequence), lag_events: p.head_sequence === null ? null : Math.max(0, Number(p.head_sequence) - Number(p.last_sequence)), unacked_events: Number(p.last_sequence) - Number(p.acked_sequence), open_entity_gaps: p.open_gaps, hold: p.hold_sequence === null ? null : { sequence: Number(p.hold_sequence), reason: p.hold_reason } }))
        : [...summary.quarantine.filter((x) => scope.partitions.includes(x.partition_key)).map((x) => ({ type: "QUARANTINE", partition_key: x.partition_key, reason: x.reason, count: x.n, last_detected_at: x.last_detected_at })),
          ...summary.runs.filter((r) => !r.partition_key || scope.partitions.includes(r.partition_key)).map((r) => ({ type: "RUN", stage: r.stage, partition_key: r.partition_key, status: r.status, started_at: r.started_at, finished_at: r.finished_at, error_code: r.error_code, counts: r.counts }))];
      return envelope(ctx, report, q, { asOf, freshness: "FRESH", coverage: "COMPLETE", quality: "LIVE", rows, source, scope });
    }
    // Projection-backed reports: coverage decides whether counts are shown.
    const coverage = [];
    for (const p of parts) coverage.push(await store.coverageFor(p.partition_key, report.source));
    const complete = coverage.every(Boolean);
    const lastSuccess = parts.map((p) => p.last_success_at).filter(Boolean).sort((a, b) => a - b)[0] || null;
    const asOf = lastSuccess ? new Date(lastSuccess).toISOString() : null;
    const stale = lastSuccess && now() - new Date(lastSuccess).getTime() > 3600 * 1000;
    let rows;
    const blockers = [];
    if (report.id === "marketing_evidence") {
      const latest = await store.campaignLatest(scope.partitions);
      rows = latest.map((r) => ({ partition_key: r.partition_key, campaign_id: r.payload.campaign_id, revision: r.payload.revision, state: r.payload.state, sent: r.payload.sent_count, logged_only: r.payload.logged_only_count, failed: r.payload.failed_count, suppressed: r.payload.suppressed_count, delivered: r.payload.delivery_confirmation === "PROVIDER_RECEIPTS" ? r.payload.delivered_count : null, delivery_confirmation: r.payload.delivery_confirmation }));
      blockers.push(blocked("CONSENT_AGGREGATE_NOT_RELEASED", "The source does not release marketing consent aggregates; consent is rechecked by the source at send time"));
    } else {
      const groups = await store.projectionGroups(scope.partitions, report.source.source_service, report.source.entity_type, report.fields);
      rows = groups.map((g) => { const row = { partition_key: g.partition_key }; for (const f of report.fields) row[f] = g[f]; row.count = complete ? g.n : null; return row; });
      if (report.id === "support_queue") blockers.push(blocked("SLA_POLICY_UNAVAILABLE", "Response timing is not released: the source reports sla_state POLICY_UNAVAILABLE"));
    }
    if (!complete) blockers.push(blocked("PARTIAL_COVERAGE", "Counts are withheld until coverage is complete (consumed from the start, no holds, gaps or quarantine, and COMPLETE source coverage)"));
    const quality = !asOf ? "UNKNOWN" : !complete ? "PARTIAL_COVERAGE" : stale ? "STALE" : "LIVE";
    return envelope(ctx, report, q, { asOf, freshness: asOf ? (stale ? "STALE" : "FRESH") : "UNKNOWN", coverage: asOf ? (complete ? "COMPLETE" : "PARTIAL") : "UNKNOWN", quality, rows, blockers, source, scope });
  }

  async function get(ctx) {
    if (!ctx.delegation || ctx.delegation.action !== "report.read") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
    const id = String(ctx.params.reportId || "").replace(/^karryam\.report\./, "");
    const report = BY_ID.get(id);
    if (!report) throw new P("NOT_FOUND", "UNKNOWN_REPORT");
    const q = parseReportQuery(ctx.query, report, now());
    const d = ctx.delegation.scope || {};
    if (!(d.market || []).includes(q.market) || !(d.organization || []).includes(q.organization)) throw new P("FORBIDDEN", "SCOPE_NOT_GRANTED");
    if (q.zone && !(d.zone || []).includes(q.zone)) throw new P("FORBIDDEN", "ZONE_NOT_GRANTED");
    if (q.tenant && !(d.tenant || []).includes(q.tenant)) throw new P("FORBIDDEN", "TENANT_NOT_GRANTED");
    if (report.kind === "BLOCKED") throw new P("UNAVAILABLE", report.blocker.code, { retryable: false });
    if (report.kind === "LOCAL" && !config.feed.enabled && report.id !== "connector_health") throw new P("UNAVAILABLE", "BRIDGE_FEED_NOT_ENABLED", { retryable: false });
    const out = report.kind === "BRIDGE" ? await bridgeReport(ctx, report, q) : await localReport(ctx, report, q);
    try {
      await audit.record({ correlation_id: ctx.correlationId, request_id: ctx.requestId, endpoint: "reportGet", method: "GET", service_id: ctx.service && ctx.service.serviceId, staff_ref: ctx.delegation.sub, action: "report.read", outcome: "REPORT_AUTHORIZED", metadata: { report: report.id, kind: report.kind } });
    } catch { throw new P("UNAVAILABLE", "AUDIT_UNAVAILABLE", { retryable: true }); }
    return out;
  }

  return { get };
}

module.exports = { REPORTS, reportCapabilities, createReports, partitionsInScope, parseReportQuery };
