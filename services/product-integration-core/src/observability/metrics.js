"use strict";

// Product Integration Core private metrics (Prometheus text format), served
// only on its private listener (Unix socket shared with the Central Admin
// API group, 0660). Labels are bounded: route classes, reason codes, product
// IDs and dataset IDs from the registry, key IDs. Never staff IDs, tokens,
// raw paths or product data.

const { createMetricsRegistry, registerProcessMetrics, statusClass } = require("../../../../packages/service-clients");
const { T } = require("../db");

const PREFIX = "pic_";
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15];

function epoch(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** "/products/([a-z]...)/metrics/(...)" -> "/products/:p/metrics/:p" (bounded route class). */
function routeClass(pattern, base) {
  return pattern.source.replace(/\\\//g, "/").replace(/^\^/, "").replace(/\$$/, "").replace(base, "").replace(/\([^()]*\)/g, ":p") || "/";
}

function createPicMetrics({ pool = null, enabled = false, syncEnabled = false, environment = null, trustStore = null, hqDelegationKeys = {}, now = Date.now, startedAt = Date.now(), listMigrations = null, buildSha = null } = {}) {
  const r = createMetricsRegistry({ prefix: PREFIX, maxSeries: 300 });
  registerProcessMetrics(r, { service: "product-integration-core", version: /^[0-9a-f]{7,64}$/.test(String(buildSha || "")) ? String(buildSha).slice(0, 12) : "unknown", startedAt });

  r.gauge("enabled", "1 when the service is enabled by configuration").set({}, enabled ? 1 : 0);
  r.gauge("sync_enabled", "1 when scheduled synchronization is enabled").set({}, syncEnabled ? 1 : 0);
  const requests = r.counter("requests_total", "Internal API requests", ["route", "status_class", "code"]);
  const duration = r.histogram("request_duration_seconds", "Request handling time", ["route"], DURATION_BUCKETS);
  const delegationFailures = r.counter("delegation_failures_total", "Rejected HQ delegations (missing, invalid, expired, replayed)", ["reason"]);
  const replays = r.counter("replay_rejections_total", "Replayed HQ delegation IDs refused");
  const denials = r.counter("authorization_denials_total", "Requests refused by staff grant, scope, MFA or policy evaluation", ["reason"]);
  const crossTenant = r.counter("cross_scope_denials_total", "Requests refused because the requested scope is outside the grant or product scope", ["reason"]);
  const errors = r.counter("error_responses_total", "Error responses by sanitized reason", ["route", "code", "reason"]);
  const syncOutcomes = r.counter("sync_partition_results_total", "Partition synchronization results from scheduled and operator runs", ["status"]);
  const trustCurrent = r.gauge("trust_store_current", "1 while the loaded signer trust store matches its source files (0: changed, restart required)");
  const keyExpiry = r.gauge("key_expiry_timestamp_seconds", "Expiry of enrolled signer and HQ delegation keys (unix seconds)", ["kind", "product", "kid"]);
  const keyRevoked = r.gauge("key_revoked", "1 for a listed but revoked key", ["kind", "kid"]);

  const dbUp = r.gauge("database_up", "1 when the HQ database answered at scrape time");
  const products = r.gauge("product_admin_state", "Registry state per Product Admin (value 1 for the current state)", ["product", "dimension", "state"]);
  const manifestExpiry = r.gauge("product_manifest_expires_in_seconds", "Seconds until the accepted signed manifest expires", ["product"]);
  const observationAge = r.gauge("subscription_source_observation_age_seconds", "Seconds since the newest source observation per subscription", ["product", "dataset"]);
  const subStatus = r.gauge("subscription_state", "Subscription status, coverage and gap state (value 1 for the current state)", ["product", "dataset", "dimension", "state"]);
  const unacked = r.gauge("cursor_unacked_events", "Events committed by HQ but not yet acknowledged to the Product Admin", ["product", "dataset"]);
  const seqLag = r.gauge("cursor_sequence_lag_events", "Product Admin head minus HQ committed sequence", ["product", "dataset"]);
  const gapsOpen = r.gauge("cursor_gaps_open", "Partitions with an open sequence gap", ["product", "dataset"]);
  const quarantineOpen = r.gauge("quarantine_open", "Unresolved quarantined events", ["product"]);
  const ackFailures = r.gauge("sync_ack_failures_24h", "ACK failures in the last 24 hours", ["product"]);
  const leaseFailures = r.gauge("sync_lease_failures_24h", "Lease conflicts in the last 24 hours", ["product"]);
  const runs1h = r.gauge("sync_runs_1h", "Sync runs in the last hour by status", ["status"]);
  const migApplied = r.gauge("schema_migrations_applied", "Migrations recorded in the hq_integration ledger");
  const migExpected = r.gauge("schema_migrations_expected", "Migrations shipped in this image");
  const migMismatch = r.gauge("schema_migrations_checksum_mismatch", "Ledger rows whose checksum differs from the shipped file");

  for (const [kid, k] of Object.entries(hqDelegationKeys || {})) {
    const t = epoch(k.notAfter);
    if (t !== null) keyExpiry.set({ kind: "hq_delegation_key", product: "hq", kid }, t);
    keyRevoked.set({ kind: "hq_delegation_key", kid }, k.revoked ? 1 : 0);
  }
  for (const [kid, s] of Object.entries(trustStore || {})) {
    if (!s || typeof s !== "object") continue;
    const t = epoch(s.notAfter || s.not_after);
    if (t !== null) keyExpiry.set({ kind: "manifest_signer", product: s.productId || s.product_id || "unknown", kid }, t);
    keyRevoked.set({ kind: "manifest_signer", kid }, s.revoked ? 1 : 0);
  }

  function observeRequest(o) {
    const route = o.route || "unmatched";
    requests.inc({ route, status_class: statusClass(o.status), code: o.code || "OK" });
    duration.observe({ route }, Math.max(0, Number(o.duration_ms) || 0) / 1000);
    if (!o.code) return;
    errors.inc({ route, code: o.code, reason: o.reason });
    if (o.kind === "delegation") {
      delegationFailures.inc({ reason: o.detail || o.reason });
      if (o.reason === "DELEGATION_REPLAYED") replays.inc();
    }
    if (o.kind === "authorization") {
      denials.inc({ reason: o.reason });
      if (/SCOPE|TENANT|MARKET|ORGANIZATION|ZONE/.test(String(o.reason))) crossTenant.inc({ reason: o.reason });
    }
  }

  function observeSync(results) {
    for (const product of results || []) {
      for (const p of (product && product.results) || []) syncOutcomes.inc({ status: p.status });
    }
  }

  r.addCollector("trust_store", async () => {
    // Only a trust store bound to its source files can report; otherwise no series.
    if (trustStore && typeof trustStore.isCurrent === "function") trustCurrent.set({}, trustStore.isCurrent() ? 1 : 0);
  });

  let shipped = null;
  if (pool) {
    r.addCollector("database", async () => {
      try { await pool.query("SELECT 1"); dbUp.set({}, 1); } catch { dbUp.set({}, 0); throw new Error("database_unavailable"); }
    });
    r.addCollector("integrations", async () => {
      const { rows: admins } = await pool.query(
        `SELECT p.id, p.product_id, p.lifecycle_status, p.health_status, p.sync_status, p.drift_status,
                extract(epoch FROM (p.manifest_expires_at - now()))::bigint AS manifest_in
         FROM ${T}hq_product_admins p WHERE ($1::text IS NULL OR p.environment = $1) ORDER BY p.product_id LIMIT 50`, [environment]);
      for (const g of [products, manifestExpiry, observationAge, subStatus, unacked, seqLag, gapsOpen, quarantineOpen, ackFailures, leaseFailures]) g.reset();
      if (!admins.length) return;
      const ids = admins.map((a) => a.id);
      const byId = new Map(admins.map((a) => [a.id, a.product_id]));
      for (const a of admins) {
        const product = a.product_id;
        products.set({ product, dimension: "lifecycle", state: a.lifecycle_status }, 1);
        products.set({ product, dimension: "health", state: a.health_status }, 1);
        products.set({ product, dimension: "sync", state: a.sync_status }, 1);
        products.set({ product, dimension: "drift", state: a.drift_status }, 1);
        if (a.manifest_in !== null) manifestExpiry.set({ product }, Number(a.manifest_in));
      }
      const { rows: subs } = await pool.query(
        `SELECT s.product_admin_id, d.dataset_id, s.status, s.coverage, s.gap_status,
                extract(epoch FROM (now() - s.last_source_observation_at))::bigint AS observation_age
         FROM ${T}hq_product_admin_subscriptions s JOIN ${T}hq_product_admin_datasets d ON d.id = s.dataset_row_id WHERE s.product_admin_id = ANY($1)`, [ids]);
      for (const s of subs) {
        const labels = { product: byId.get(s.product_admin_id), dataset: s.dataset_id };
        if (s.observation_age !== null) observationAge.set(labels, Math.max(0, Number(s.observation_age)));
        subStatus.set({ ...labels, dimension: "status", state: s.status }, 1);
        subStatus.set({ ...labels, dimension: "coverage", state: s.coverage || "UNKNOWN" }, 1);
        subStatus.set({ ...labels, dimension: "gap", state: s.gap_status || "NONE" }, 1);
      }
      const { rows: cursors } = await pool.query(
        `SELECT s.product_admin_id, d.dataset_id, sum(c.last_sequence - c.acked_sequence)::bigint AS unacked,
                sum(CASE WHEN c.head_sequence IS NULL THEN 0 ELSE GREATEST(c.head_sequence - c.last_sequence, 0) END)::bigint AS lag,
                count(*) FILTER (WHERE c.gap_from IS NOT NULL)::int AS gaps
         FROM ${T}hq_product_admin_sync_cursors c JOIN ${T}hq_product_admin_subscriptions s ON s.id = c.subscription_id JOIN ${T}hq_product_admin_datasets d ON d.id = s.dataset_row_id
         WHERE s.product_admin_id = ANY($1) GROUP BY 1, 2`, [ids]);
      for (const c of cursors) {
        const labels = { product: byId.get(c.product_admin_id), dataset: c.dataset_id };
        unacked.set(labels, Number(c.unacked));
        seqLag.set(labels, Number(c.lag));
        gapsOpen.set(labels, c.gaps);
      }
      const { rows: q } = await pool.query(`SELECT product_admin_id, count(*)::int AS n FROM ${T}hq_product_admin_quarantine WHERE resolved_at IS NULL AND product_admin_id = ANY($1) GROUP BY 1`, [ids]);
      for (const a of admins) quarantineOpen.set({ product: a.product_id }, 0);
      for (const x of q) quarantineOpen.set({ product: byId.get(x.product_admin_id) }, x.n);
      const { rows: runs } = await pool.query(
        `SELECT product_admin_id, count(*) FILTER (WHERE ack_status = 'ACK_FAILED')::int AS failed_acks, count(*) FILTER (WHERE status = 'LEASE_LOST')::int AS lease_failures
         FROM ${T}hq_product_admin_sync_runs WHERE product_admin_id = ANY($1) AND started_at > now() - interval '24 hours' GROUP BY 1`, [ids]);
      for (const x of runs) {
        ackFailures.set({ product: byId.get(x.product_admin_id) }, x.failed_acks);
        leaseFailures.set({ product: byId.get(x.product_admin_id) }, x.lease_failures);
      }
      const { rows: recent } = await pool.query(`SELECT status, count(*)::int AS n FROM ${T}hq_product_admin_sync_runs WHERE started_at > now() - interval '1 hour' GROUP BY 1`);
      runs1h.reset();
      for (const x of recent) runs1h.set({ status: x.status }, x.n);
    });
    r.addCollector("migrations", async () => {
      if (!shipped) shipped = (listMigrations || require("../db/migrate").listMigrations)();
      migExpected.set({}, shipped.length);
      const { rows } = await pool.query(`SELECT version, checksum FROM ${T}hq_product_admin_schema_migrations`);
      migApplied.set({}, rows.length);
      const byVersion = new Map(shipped.map((m) => [m.version, m.checksum]));
      migMismatch.set({}, rows.filter((x) => byVersion.has(x.version) && byVersion.get(x.version) !== x.checksum).length);
    });
  }

  return Object.freeze({ registry: r, observeRequest, observeSync, render: () => r.render(), names: () => r.names() });
}

/** Every metric name the Product Integration Core can export (alert-rule test). */
function picMetricNames() {
  return createPicMetrics({ pool: { query: async () => ({ rows: [] }) } }).names();
}

module.exports = { createPicMetrics, picMetricNames, routeClass, PREFIX };
