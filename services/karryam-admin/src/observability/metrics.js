"use strict";

// Karryam Admin private observability: Prometheus metrics, operator sync
// status and readiness detail. Served only on the service's own private
// listener (Unix socket 0660 or TLS 1.3 mTLS); never through HQ or Nginx.
//
// Labels are bounded operational identifiers only: endpoint IDs, reason and
// category codes, dataset IDs, partition keys (enrolled scopes) and key IDs.
// Never staff IDs, tokens, raw paths, request bodies or source data.

const { clients } = require("../packages");

const PREFIX = "karryam_admin_";
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function epoch(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * config: loaded configuration (enabled or disabled)
 * pool:   runtime database pool (optional; scrape-time DB gauges need it)
 */
function createKarryamMetrics({ config, pool = null, now = Date.now, startedAt = Date.now(), listMigrations = null } = {}) {
  const r = clients.createMetricsRegistry({ prefix: PREFIX, maxSeries: 200 });
  clients.registerProcessMetrics(r, { service: "karryam-admin", version: config && config.buildSha ? config.buildSha.slice(0, 12) : "unknown", startedAt });

  const enabled = r.gauge("enabled", "1 when the service is enabled by configuration");
  const bridgeEnabled = r.gauge("bridge_enabled", "1 when Bridge trust is configured (not a certification)");
  const feedEnabled = r.gauge("bridge_feed_enabled", "1 when the Stage A feed is configured");
  const enabledCommands = r.gauge("enabled_commands", "Explicitly allowlisted source commands");
  const certExpiry = r.gauge("certificate_expiry_timestamp_seconds", "Expiry of configured certificates and keys (unix seconds)", ["kind", "kid"]);
  const manifestTtl = r.gauge("manifest_ttl_seconds", "Configured signed-manifest lifetime");

  const requests = r.counter("requests_total", "Private listener requests", ["endpoint", "status_class", "code"]);
  const duration = r.histogram("request_duration_seconds", "Request handling time", ["endpoint"], DURATION_BUCKETS);
  const authFailures = r.counter("service_auth_failures_total", "Rejected cf-svc-v1 service authentications (invalid identity, signature, key)", ["reason"]);
  const delegationFailures = r.counter("delegation_failures_total", "Rejected product staff delegations (expired, invalid, wrong audience)", ["reason"]);
  const replays = r.counter("replay_rejections_total", "Replayed nonces or delegation IDs refused", ["kind"]);
  const denials = r.counter("authorization_denials_total", "Requests refused for authorization, scope or policy", ["endpoint", "reason"]);
  const auditFailures = r.counter("audit_persistence_failures_total", "Requests failed closed because the audit record could not be persisted");
  const errors = r.counter("error_responses_total", "Error responses by sanitized reason", ["endpoint", "code", "reason"]);
  const bridgeOutcomes = r.counter("bridge_requests_total", "Bridge calls by outcome category (SUCCESS, RATE_LIMITED, BRIDGE_UNAVAILABLE, TRANSPORT_SECURITY, UNKNOWN_OUTCOME, ...)", ["outcome"]);
  const lastBridge = r.gauge("bridge_last_outcome_timestamp_seconds", "Time of the last Bridge outcome per category", ["outcome"]);
  const commandDispatch = r.counter("command_dispatch_total", "Dispatched source commands by settled status", ["status"]);
  const commandRequests = r.counter("command_requests_total", "Command submissions by result", ["result", "reason"]);
  const readbacks = r.counter("command_readback_total", "Authoritative readbacks of unsettled commands by state", ["state"]);

  // Scrape-time database gauges.
  const dbUp = r.gauge("database_up", "1 when the Karryam Admin database answered at scrape time");
  const feedUnacked = r.gauge("bridge_unacked_events", "Committed Bridge events not yet acknowledged to the Bridge", ["partition"]);
  const feedLag = r.gauge("bridge_feed_lag_events", "Bridge head minus committed sequence (scope-filtered global sequence)", ["partition"]);
  const feedHold = r.gauge("bridge_integrity_hold", "1 when a partition is held at an unverified event", ["partition"]);
  const feedSuccessAge = r.gauge("bridge_feed_last_success_age_seconds", "Seconds since the partition last synchronized successfully", ["partition"]);
  const observationAge = r.gauge("source_observation_age_seconds", "Seconds since the newest source event in the inbox occurred", ["partition"]);
  const leaseActive = r.gauge("worker_lease_active", "1 when a worker holds an unexpired partition lease", ["partition"]);
  const gaps = r.gauge("entity_version_gaps_open", "Unrepaired entity-version gaps (real integrity gaps, not filtered sequence holes)", ["partition"]);
  const quarantine = r.gauge("quarantine_open", "Unresolved quarantined events", ["partition"]);
  const outboxUnacked = r.gauge("hq_outbox_unacked_events", "Derived HQ outbox events not yet acknowledged by HQ", ["dataset"]);
  const coverage = r.gauge("source_coverage_entities", "Source entity types by recorded coverage", ["coverage"]);
  const runFailures = r.gauge("sync_runs_failed_1h", "Sync runs FAILED/LEASE_LOST/HELD/BLOCKED in the last hour", ["stage", "status"]);
  const opsOpen = r.gauge("operations_unsettled", "Operations not yet settled", ["status"]);
  const opsUnknownAge = r.gauge("operations_unknown_outcome_oldest_age_seconds", "Age of the oldest UNKNOWN_OUTCOME operation");
  const approvalsExpired = r.gauge("approvals_expired_unused", "Approvals that expired before use in the last 24 hours");
  const migApplied = r.gauge("schema_migrations_applied", "Migrations recorded in the ledger");
  const migExpected = r.gauge("schema_migrations_expected", "Migrations shipped in this image");
  const migMismatch = r.gauge("schema_migrations_checksum_mismatch", "Ledger rows whose checksum differs from the shipped file");

  enabled.set({}, config && config.enabled ? 1 : 0);
  if (config && config.enabled) {
    bridgeEnabled.set({}, config.bridge.enabled ? 1 : 0);
    feedEnabled.set({}, config.feed && config.feed.enabled ? 1 : 0);
    enabledCommands.set({}, config.enabledCommands.length);
    manifestTtl.set({}, config.manifestTtlSeconds);
    if (config.bridge.enabled && config.bridge.clientIdentity) {
      const t = epoch(config.bridge.clientIdentity.notAfter);
      if (t !== null) certExpiry.set({ kind: "bridge_client_certificate", kid: "client" }, t);
    }
    for (const [kid, k] of Object.entries(config.serviceKeys || {})) { const t = epoch(k.notAfter); if (t !== null) certExpiry.set({ kind: "hq_service_key", kid }, t); }
    for (const [kid, k] of Object.entries(config.delegationKeys || {})) { const t = epoch(k.notAfter); if (t !== null) certExpiry.set({ kind: "delegation_key", kid }, t); }
  }

  let lastBridgeOutcome = null;

  function observeRequest(o) {
    const endpoint = o.endpoint || "unmatched";
    requests.inc({ endpoint, status_class: clients.statusClass(o.status), code: o.code || "OK" });
    duration.observe({ endpoint }, Math.max(0, Number(o.duration_ms) || 0) / 1000);
    if (o.auth_failure) {
      authFailures.inc({ reason: o.auth_failure });
      if (/REPLAY/.test(o.auth_failure)) replays.inc({ kind: "service_nonce" });
    }
    if (o.delegation_failure) {
      delegationFailures.inc({ reason: o.delegation_failure });
      if (/REPLAY/.test(o.delegation_failure)) replays.inc({ kind: "delegation" });
    }
    if (o.reason === "AUDIT_UNAVAILABLE") auditFailures.inc();
    if (o.code) errors.inc({ endpoint, code: o.code, reason: o.reason });
    if (o.code === "FORBIDDEN" || o.code === "BLOCKED_POLICY" || o.code === "DISABLED") denials.inc({ endpoint, reason: o.reason });
    if (endpoint === "operationSubmit") commandRequests.inc({ result: o.code ? "REFUSED" : "ACCEPTED", reason: o.code ? o.reason : "none" });
  }

  function observeBridge({ outcome }) {
    bridgeOutcomes.inc({ outcome });
    lastBridge.set({ outcome }, Math.floor(now() / 1000));
    lastBridgeOutcome = { outcome, at: new Date(now()).toISOString() };
  }

  function signal(kind, value) {
    if (kind === "dispatch") commandDispatch.inc({ status: value });
    else if (kind === "readback") readbacks.inc({ state: value });
  }

  let shipped = null;
  if (pool) {
    r.addCollector("database", async () => {
      try { await pool.query("SELECT 1"); dbUp.set({}, 1); } catch { dbUp.set({}, 0); throw new Error("database_unavailable"); }
    });
    r.addCollector("pipeline", async () => {
      const { rows } = await pool.query(
        `SELECT p.partition_key, p.last_sequence, p.acked_sequence, p.head_sequence, p.hold_sequence,
                extract(epoch FROM (now() - p.last_success_at))::bigint AS success_age,
                (p.lease_owner IS NOT NULL AND p.lease_expires_at > now()) AS leased,
                (SELECT extract(epoch FROM (now() - i.occurred_at))::bigint FROM karryam_admin.bridge_event_inbox i WHERE i.partition_key = p.partition_key ORDER BY i.sequence DESC LIMIT 1) AS observation_age,
                (SELECT count(*) FROM karryam_admin.entity_version_gaps g WHERE g.partition_key = p.partition_key AND g.repaired_at IS NULL)::int AS open_gaps,
                (SELECT count(*) FROM karryam_admin.event_quarantine q WHERE q.partition_key = p.partition_key AND q.resolved_at IS NULL)::int AS open_quarantine
         FROM karryam_admin.bridge_feed_partitions p ORDER BY p.partition_key LIMIT 64`);
      for (const g of [feedUnacked, feedLag, feedHold, feedSuccessAge, observationAge, leaseActive, gaps, quarantine]) g.reset();
      for (const p of rows) {
        const partition = p.partition_key;
        feedUnacked.set({ partition }, Number(p.last_sequence) - Number(p.acked_sequence));
        if (p.head_sequence !== null) feedLag.set({ partition }, Math.max(0, Number(p.head_sequence) - Number(p.last_sequence)));
        feedHold.set({ partition }, p.hold_sequence === null ? 0 : 1);
        if (p.success_age !== null) feedSuccessAge.set({ partition }, Number(p.success_age));
        if (p.observation_age !== null) observationAge.set({ partition }, Math.max(0, Number(p.observation_age)));
        leaseActive.set({ partition }, p.leased ? 1 : 0);
        gaps.set({ partition }, p.open_gaps);
        quarantine.set({ partition }, p.open_quarantine);
      }
      const { rows: outbox } = await pool.query(
        `SELECT h.dataset_id, sum(h.head_sequence - COALESCE((SELECT min(a.acked_sequence) FROM karryam_admin.hq_outbox_acks a WHERE a.dataset_id = h.dataset_id AND a.partition_key = h.partition_key), 0))::bigint AS unacked
         FROM karryam_admin.hq_outbox_heads h GROUP BY h.dataset_id ORDER BY h.dataset_id`);
      outboxUnacked.reset();
      for (const o of outbox) outboxUnacked.set({ dataset: o.dataset_id }, Number(o.unacked));
      const { rows: cov } = await pool.query(`SELECT bridge_coverage, count(*)::int AS n FROM karryam_admin.source_coverage GROUP BY 1`);
      coverage.reset();
      for (const c of cov) coverage.set({ coverage: c.bridge_coverage }, c.n);
      const { rows: runs } = await pool.query(
        `SELECT stage, status, count(*)::int AS n FROM karryam_admin.sync_runs WHERE started_at > now() - interval '1 hour' AND status IN ('FAILED','LEASE_LOST','HELD','BLOCKED') GROUP BY 1, 2`);
      runFailures.reset();
      for (const x of runs) runFailures.set({ stage: x.stage, status: x.status }, x.n);
    });
    r.addCollector("operations", async () => {
      const { rows } = await pool.query(
        `SELECT status, count(*)::int AS n, extract(epoch FROM (now() - min(updated_at)))::bigint AS oldest FROM karryam_admin.operation_requests WHERE status IN ('RECORDED','DISPATCHING','UNKNOWN_OUTCOME') GROUP BY 1`);
      opsOpen.reset();
      opsUnknownAge.set({}, 0);
      for (const s of rows) {
        opsOpen.set({ status: s.status }, s.n);
        if (s.status === "UNKNOWN_OUTCOME") opsUnknownAge.set({}, Number(s.oldest));
      }
      const { rows: [a] } = await pool.query(
        `SELECT count(*)::int AS n FROM karryam_admin.approval_references WHERE status IN ('PROPOSED','APPROVED') AND expires_at <= now() AND expires_at > now() - interval '24 hours'`);
      approvalsExpired.set({}, a.n);
    });
    r.addCollector("migrations", async () => {
      if (!shipped) shipped = (listMigrations || require("../../scripts/migrate").listMigrations)();
      migExpected.set({}, shipped.length);
      const { rows } = await pool.query(`SELECT version, checksum FROM karryam_admin.schema_migrations`);
      migApplied.set({}, rows.length);
      const byVersion = new Map(shipped.map((m) => [m.version, m.checksum]));
      migMismatch.set({}, rows.filter((x) => byVersion.has(x.version) && byVersion.get(x.version) !== x.checksum).length);
    });
  }

  return Object.freeze({
    registry: r,
    observeRequest,
    observeBridge,
    signal,
    lastBridgeOutcome: () => lastBridgeOutcome,
    render: () => r.render(),
    names: () => r.names(),
  });
}

/** Every metric name Karryam Admin can export (alert-rule test). */
function karryamMetricNames() {
  const fake = { query: async () => ({ rows: [] }) };
  return createKarryamMetrics({ config: { enabled: false }, pool: fake }).names();
}

module.exports = { createKarryamMetrics, karryamMetricNames, PREFIX };
