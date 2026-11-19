"use strict";

// First-wave operational reports (Section 11). Each report states its source,
// grain, definition, units, observation time, scope and coverage. Values are
// either source-released figures (Bridge) or counts over CF Meet Admin's own
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

// kind BRIDGE: live source release (Summary cells or aggregate Health);
// kind LOCAL: CF Meet Admin projections or pipeline state; kind BLOCKED: no
// released source contract exists.
const ABUSE_OWNERS = Object.freeze(["messaging", "calling", "communications", "meeting-service"]);
const INCIDENT_OWNERS = Object.freeze(["messaging", "calling", "notifications", "meeting-service", "developer-platform"]);
const REPORTS = Object.freeze([
  { id: "meeting_activity", title: "Meeting activity", kind: "BRIDGE", capability: "meetings.activity.summary", grain: "WINDOW", units: ["count"], definition: "Source-released meeting activity cells for the requested scope and window; small cells are suppressed by the source" },
  { id: "communications_metrics", title: "Communications profile metrics", kind: "BRIDGE", capability: "communications.metrics.summary", grain: "WINDOW", units: ["count"], definition: "Source-released communications profile and report cells for the requested scope and window" },
  { id: "partner_usage", title: "Partner usage", kind: "BRIDGE", capability: "partners.usage.summary", grain: "WINDOW", units: ["count"], definition: "Source-released partner usage cells per workspace tier for the requested scope and window" },
  { id: "finance_usage", title: "Usage by plan and currency", kind: "BRIDGE", capability: "finance.usage.summary", grain: "WINDOW", units: ["count", "minor_currency"], definition: "Source-released usage cells; money in minor units per currency, never combined across currencies" },
  { id: "estimated_charges", title: "Estimated charges", kind: "BRIDGE", capability: "finance.charges.estimate", grain: "WINDOW", units: ["minor_currency"], definition: "Source-estimated charges in minor units per currency; estimates, not invoices or recognized revenue", requireComplete: true },
  { id: "plan_spread", title: "Plan spread (Free / Pro / Business)", kind: "BRIDGE", capability: "finance.plan-spread.summary", grain: "SNAPSHOT", units: ["count"], definition: "Current plan assignments per plan as released by the source" },
  { id: "operations_health", title: "CF Meet service health", kind: "BRIDGE", capability: "operations.health.read", grain: "SNAPSHOT", units: ["count"], definition: "Aggregate owner-service health as reported by the CF Meet Admin Bridge" },
  { id: "telecom_numbers", title: "Telecom number summaries", kind: "BLOCKED", grain: "SNAPSHOT", units: ["count"], definition: "Telecom administration is not released for HQ", blocker: blocked("SOURCE_NOT_RELEASED", "Telecom summaries are DISABLED at the source; nothing is estimated in their place") },
  { id: "verification_queue", title: "Verification case queue", kind: "LOCAL", sources: [{ source_service: "developer-platform", entity_type: "verification_case" }], fields: ["kind", "state"], grain: "SNAPSHOT", units: ["count"], definition: "Current verification case projections by kind and state (automated recommendations are not decisions)" },
  { id: "safety_queue", title: "Trust and safety report queue", kind: "LOCAL", sources: ABUSE_OWNERS.map((s) => ({ source_service: s, entity_type: "abuse_report" })), fields: ["status", "severity"], grain: "SNAPSHOT", units: ["count"], definition: "Current abuse report projections by owner service, status and severity; owners are never added together" },
  { id: "partner_workspaces", title: "Partner workspace states", kind: "LOCAL", sources: [{ source_service: "developer-platform", entity_type: "partner_workspace" }], fields: ["state"], grain: "SNAPSHOT", units: ["count"], definition: "Current partner workspace projections by state" },
  { id: "incidents", title: "Open incidents by owner", kind: "LOCAL", sources: INCIDENT_OWNERS.map((s) => ({ source_service: s, entity_type: "incident" })), fields: ["status", "severity"], grain: "SNAPSHOT", units: ["count"], definition: "Current incident projections by owner service, status and severity" },
  { id: "connector_health", title: "Source, Bridge and CF Meet Admin connector health", kind: "LOCAL", grain: "SNAPSHOT", units: ["count"], definition: "Bridge connector configuration, request outcome counters since start, client certificate expiry and last successful feed per partition" },
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
    return { id: "cfmeet.report." + r.id, version: "1.0.0", kind: "READ", state, risk: r.capability && R.capability(r.capability) && ["R2", "R3", "R4"].includes(R.capability(r.capability).risk) ? "R2" : "R1", description: r.title.slice(0, 240), datasets: [], blockers, requires_recent_mfa: true, requires_independent_approval: false, request_schema: null };
  });
}

// Purposes a report caller may declare (passed to the Bridge for BRIDGE reports).
const REPORT_PURPOSES = Object.freeze(["support-review", "verification-review", "abuse-review", "billing-review", "pricing-change", "ops-incident", "release-request", "privacy-request", "metrics-read"]);

function bridgeWindowed(report) {
  const cap = report.capability ? R.capability(report.capability) : null;
  return Boolean(cap && R.SHAPE_PARAMS[cap.query_shape].includes("start"));
}

function parseReportQuery(searchParams, report, now) {
  const allowed = new Set(["market", "organization", "zone", "tenant", "purpose"]);
  if (report.kind === "BRIDGE" && bridgeWindowed(report)) { allowed.add("start"); allowed.add("end"); }
  const q = {};
  for (const [key, raw] of searchParams) {
    if (!allowed.has(key)) throw new P("INVALID_REQUEST", "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
    if (Object.prototype.hasOwnProperty.call(q, key)) throw new P("INVALID_REQUEST", "DUPLICATE_PARAMETER");
    q[key] = raw;
  }
  for (const dim of ["market", "organization"]) if (!q[dim] || !SCOPE.test(q[dim])) throw new P("INVALID_REQUEST", "SCOPE_" + dim.toUpperCase() + "_REQUIRED");
  for (const dim of ["zone", "tenant"]) if (q[dim] !== undefined && !SCOPE.test(q[dim])) throw new P("INVALID_REQUEST", "SCOPE_INVALID");
  if (!q.purpose || !PURPOSE.test(q.purpose)) throw new P("INVALID_REQUEST", "PURPOSE_REQUIRED");
  if (!REPORT_PURPOSES.includes(q.purpose)) throw new P("INVALID_REQUEST", "PURPOSE_NOT_ALLOWED");
  if (report.kind === "BRIDGE") {
    if (!q.zone || !q.tenant) throw new P("INVALID_REQUEST", "SCOPE_ZONE_AND_TENANT_REQUIRED");
    if (bridgeWindowed(report)) {
      for (const k of ["start", "end"]) if (q[k] !== undefined && !DATE_TIME.test(q[k])) throw new P("INVALID_REQUEST", "TIME_WINDOW_INVALID");
      const end = q.end ? Date.parse(q.end) : now;
      const start = q.start ? Date.parse(q.start) : end - 24 * 3600 * 1000;
      if (!(end > start) || end - start > R.MAX_WINDOW_MS || end > now + 60000) throw new P("INVALID_REQUEST", "TIME_WINDOW_INVALID");
      q.start = new Date(start).toISOString();
      q.end = new Date(end).toISOString();
    }
  }
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
    const cap = R.capability(report.capability);
    const query = { market: q.market, organization: q.organization, zone: q.zone, tenant: q.tenant, purpose: q.purpose };
    if (R.SHAPE_PARAMS[cap.query_shape].includes("limit")) query.limit = 1;
    if (R.SHAPE_PARAMS[cap.query_shape].includes("start")) { query.start = q.start; query.end = q.end; }
    const source = { kind: "BRIDGE", owner: cap.owner, bridge_capability_id: cap.id, contract_version: R.summary().contract_version };
    let res;
    try { res = await bridgeClient.call(cap.id, { staff, query }); }
    catch (err) { const m = protocolMapping(err); throw new P(m.code, m.reason, { retryable: m.retryable }); }
    const r = res.result;
    if (report.id === "operations_health") {
      const quality = qualityOf(res.freshness, r.status === "UNKNOWN" ? "PARTIAL_COVERAGE" : "COMPLETE");
      const rows = r.services.map((x) => ({ service: x.service, status: x.status, checked_at: x.checked_at }));
      return envelope(ctx, report, q, { asOf: r.as_of, freshness: quality.freshness, coverage: quality.coverage, quality: quality.label, rows, source, scope, extra: { overall_status: r.status } });
    }
    // Summary cells: one row per cell, never summed across currencies.
    const complete = r.coverage === "COMPLETE";
    const withhold = report.requireComplete && !complete;
    const quality = qualityOf(res.freshness, complete ? "COMPLETE" : "PARTIAL_COVERAGE");
    const rows = r.cells.map((c) => ({ key: c.key, unit: c.unit, currency: c.currency, value: withhold ? null : c.value, suppression: withhold ? "PARTIAL_COVERAGE" : c.suppression }));
    const blockers = withhold ? [blocked("PARTIAL_COVERAGE", "Figures are withheld until the source reports COMPLETE coverage")] : [];
    return envelope(ctx, report, q, { asOf: r.as_of, freshness: quality.freshness, coverage: quality.coverage, quality: quality.label, rows, blockers, source, scope, extra: { window: r.window } });
  }

  async function localReport(ctx, report, q) {
    if (!store && report.id !== "connector_health") throw new P("UNAVAILABLE", "PIPELINE_STORE_UNAVAILABLE");
    const summary = store ? await store.pipelineSummary() : { partitions: [], quarantine: [], runs: [], coverage: [] };
    const parts = partitionsInScope(summary.partitions, ctx.delegation, q);
    const scope = { market: q.market, organization: q.organization, zone: q.zone || null, tenant: q.tenant || null, partitions: parts.map((p) => p.partition_key) };
    const source = { kind: "LOCAL", owner: "cfmeet-admin", derived_from: report.sources ? report.sources.map((x) => x.source_service + "/" + x.entity_type).join(", ") + " via Bridge feed" : "cfmeet-admin pipeline state" };
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
    // Each owner service is its own source; counts are never added across owners.
    const coverage = [];
    for (const p of parts) for (const src of report.sources) coverage.push(await store.coverageFor(p.partition_key, src));
    const complete = coverage.every(Boolean);
    const lastSuccess = parts.map((p) => p.last_success_at).filter(Boolean).sort((a, b) => a - b)[0] || null;
    const asOf = lastSuccess ? new Date(lastSuccess).toISOString() : null;
    const stale = lastSuccess && now() - new Date(lastSuccess).getTime() > 3600 * 1000;
    const rows = [];
    const blockers = [];
    for (const src of report.sources) {
      const groups = await store.projectionGroups(scope.partitions, src.source_service, src.entity_type, report.fields);
      for (const g of groups) {
        const row = { partition_key: g.partition_key, source_service: src.source_service };
        for (const f of report.fields) row[f] = g[f];
        row.count = complete ? g.n : null;
        rows.push(row);
      }
    }
    if (!complete) blockers.push(blocked("PARTIAL_COVERAGE", "Counts are withheld until coverage is complete (consumed from the start, no holds, gaps or quarantine, and COMPLETE source coverage)"));
    const quality = !asOf ? "UNKNOWN" : !complete ? "PARTIAL_COVERAGE" : stale ? "STALE" : "LIVE";
    return envelope(ctx, report, q, { asOf, freshness: asOf ? (stale ? "STALE" : "FRESH") : "UNKNOWN", coverage: asOf ? (complete ? "COMPLETE" : "PARTIAL") : "UNKNOWN", quality, rows, blockers, source, scope });
  }

  async function get(ctx) {
    if (!ctx.delegation || ctx.delegation.action !== "report.read") throw new P("FORBIDDEN", "DELEGATION_ACTION_MISMATCH");
    const id = String(ctx.params.reportId || "").replace(/^cfmeet\.report\./, "");
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
