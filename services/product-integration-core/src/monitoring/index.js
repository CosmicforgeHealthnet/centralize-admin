"use strict";

// Sanitized operational view of one Product Admin integration. Never claims
// upstream readiness from local process liveness: every field comes from
// recorded checks, cursors and sync runs.

const { T } = require("../db");

async function integrationStatus(db, productAdminId, { now = Date.now() } = {}) {
  const { rows: [p] } = await db.query(
    `SELECT id, product_id, environment, lifecycle_status, revision, health_status, health_checked_at, sync_status, drift_status, drift_detected_at,
            manifest_revision, manifest_expires_at, current_contract_id, identity_verified_at, activated_at, suspended_at, suspension_reason, revoked_at, revocation_reason
     FROM ${T}hq_product_admins WHERE id = $1`, [productAdminId]);
  if (!p) return null;
  const [contract, datasets, subs, cursors, runs, quarantine, alerts] = await Promise.all([
    db.query(`SELECT revision, status, protocol_major, protocol_minor, build_sha, activated_at FROM ${T}hq_product_admin_contracts WHERE id = $1`, [p.current_contract_id]),
    db.query(`SELECT dataset_id, version, approval_status, privacy_class FROM ${T}hq_product_admin_datasets WHERE product_admin_id = $1 ORDER BY dataset_id, version`, [productAdminId]),
    db.query(`SELECT s.id, d.dataset_id, s.schema_revision, s.consumer_department, s.enabled, s.status, s.policy_block_reason, s.coverage, s.gap_status, s.quarantined_count, s.freshness_target_seconds, s.last_success_at, s.last_source_observation_at, s.last_reconciliation_at
              FROM ${T}hq_product_admin_subscriptions s JOIN ${T}hq_product_admin_datasets d ON d.id = s.dataset_row_id WHERE s.product_admin_id = $1`, [productAdminId]),
    db.query(`SELECT c.subscription_id, c.partition_key, c.last_sequence, c.acked_sequence, c.head_sequence, c.gap_from, c.gap_to, c.gap_detected_at, c.last_success_at, (c.lease_owner IS NOT NULL AND c.lease_expires_at > now()) AS leased
              FROM ${T}hq_product_admin_sync_cursors c JOIN ${T}hq_product_admin_subscriptions s ON s.id = c.subscription_id WHERE s.product_admin_id = $1 ORDER BY c.partition_key`, [productAdminId]),
    db.query(`SELECT count(*) FILTER (WHERE ack_status = 'ACK_FAILED')::int AS failed_acks, count(*) FILTER (WHERE status = 'LEASE_LOST')::int AS lease_failures,
                     count(*) FILTER (WHERE status = 'FAILED')::int AS failed_runs, max(finished_at) FILTER (WHERE status = 'SUCCEEDED') AS last_successful_run
              FROM ${T}hq_product_admin_sync_runs WHERE product_admin_id = $1 AND started_at > now() - interval '24 hours'`, [productAdminId]),
    db.query(`SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open, count(*)::int AS total FROM ${T}hq_product_admin_quarantine WHERE product_admin_id = $1`, [productAdminId]),
    db.query(`SELECT reason_code, count(*)::int AS n, max(occurred_at) AS last_at FROM ${T}hq_product_admin_security_audit WHERE product_admin_id = $1 AND action = 'integration.alert' AND occurred_at > now() - interval '24 hours' GROUP BY reason_code ORDER BY reason_code`, [productAdminId]),
  ]);
  const expires = p.manifest_expires_at ? p.manifest_expires_at.getTime() : null;
  return {
    product_id: p.product_id,
    environment: p.environment,
    registry: { status: p.lifecycle_status, revision: p.revision, revoked: p.lifecycle_status === "REVOKED", suspended: p.lifecycle_status === "SUSPENDED", revocation_reason: p.revocation_reason, suspension_reason: p.suspension_reason },
    identity: { verified_at: p.identity_verified_at, manifest_revision: p.manifest_revision, manifest_expires_at: p.manifest_expires_at, manifest_expired: expires !== null && expires <= now, manifest_expires_in_seconds: expires === null ? null : Math.floor((expires - now) / 1000) },
    connection: { health_status: p.health_status, checked_at: p.health_checked_at },
    contract: contract.rows[0] || null,
    drift: { status: p.drift_status, detected_at: p.drift_detected_at },
    datasets: datasets.rows,
    subscriptions: subs.rows.map((s) => ({
      ...s,
      lag_seconds: s.last_source_observation_at ? Math.max(0, Math.floor((now - s.last_source_observation_at.getTime()) / 1000)) : null,
      policy_unavailable: s.status === "POLICY_BLOCKED",
    })),
    cursors: cursors.rows.map((c) => ({ ...c, sequence_lag: c.head_sequence === null ? null : Math.max(0, Number(c.head_sequence) - Number(c.last_sequence)), unacked: Number(c.last_sequence) - Number(c.acked_sequence) })),
    sync: { status: p.sync_status, ...runs.rows[0] },
    quarantine: quarantine.rows[0],
    alerts_24h: alerts.rows,
  };
}

module.exports = { integrationStatus };
