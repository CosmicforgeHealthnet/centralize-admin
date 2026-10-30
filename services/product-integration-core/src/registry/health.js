"use strict";

// Connection, identity and contract-drift checks for registered products.
// Drift is detected and reported; it never activates or changes anything a
// reviewer has approved.

const C = require("../../../../packages/admin-contracts");
const { T } = require("../db");
const { recordAudit } = require("../audit");
const { clientFor } = require("./endpoints");

function createHealthChecker({ pool, endpoints, trustStore, now = Date.now, clientOptions = {} }) {
  async function check(row) {
    let health = "REACHABLE";
    let drift = "NONE";
    let reason = null;
    let refreshed = null;
    try {
      const client = clientFor(endpoints, row, clientOptions);
      const ready = await client.getHealthReady().catch(() => null);
      if (!ready || ready.status !== 200) health = "DEGRADED";
      const res = await client.getManifest();
      if (res.status !== 200) {
        drift = "MANIFEST_INVALID";
        reason = "MANIFEST_UNAVAILABLE";
      } else {
        let verified;
        try {
          verified = C.verifyManifest(res.json.result, { trustStore, now: now(), expected: { productId: row.product_id, serviceInstanceId: row.service_instance_id, environment: row.environment, workloadIdentity: row.workload_identity, signerKid: row.approved_signer_kid, minimumRevision: row.manifest_revision || undefined } });
        } catch (err) {
          drift = ["MANIFEST_EXPIRED"].includes(err.reason) ? "MANIFEST_EXPIRED" : ["SIGNER_NOT_APPROVED", "SIGNER_UNKNOWN", "SIGNER_REVOKED", "SIGNER_EXPIRED", "SIGNER_SCOPE_MISMATCH", "PRODUCT_MISMATCH", "INSTANCE_MISMATCH", "ENVIRONMENT_MISMATCH", "WORKLOAD_IDENTITY_MISMATCH"].includes(err.reason) ? "IDENTITY_MISMATCH" : "MANIFEST_INVALID";
          reason = err.reason;
        }
        if (verified && row.current_contract_id) {
          const { rows: [active] } = await pool.query(`SELECT catalog, catalog_digest FROM ${T}hq_product_admin_contracts WHERE id = $1`, [row.current_contract_id]);
          if (active && active.catalog_digest !== verified.catalogDigest) {
            const comparison = C.compareCatalogs(active.catalog, { product_id: verified.manifest.product_id, protocol: verified.manifest.protocol, capabilities: verified.manifest.capabilities, datasets: verified.manifest.datasets, event_families: verified.manifest.event_families });
            drift = comparison.decision === "BREAKING" ? "BREAKING_DETECTED" : "ADDITIVE_PENDING_REVIEW";
            reason = comparison.decision;
          }
        }
        // Same approved signer and identity with an unchanged catalog: keep the
        // stored manifest expiry current so a healthy product keeps
        // synchronizing, while an expired or unverifiable one stops.
        if (verified && drift === "NONE") refreshed = verified;
      }
    } catch (err) {
      health = "UNREACHABLE";
      reason = err.reason || err.code || "PRODUCT_ADMIN_UNREACHABLE";
    }
    await pool.query(
      `UPDATE ${T}hq_product_admins SET health_status = $2, health_checked_at = now(),
         drift_status = CASE WHEN $3::text = 'NONE' AND $2 = 'UNREACHABLE' THEN drift_status ELSE $3::text END,
         drift_detected_at = CASE WHEN $3::text <> 'NONE' AND drift_status IS DISTINCT FROM $3::text THEN now() ELSE drift_detected_at END
       WHERE id = $1 AND lifecycle_status NOT IN ('REVOKED','REJECTED')`, [row.id, health, drift]);
    if (refreshed) {
      await pool.query(
        `UPDATE ${T}hq_product_admins SET manifest_digest = $2, manifest_revision = $3, manifest_expires_at = $4
         WHERE id = $1 AND lifecycle_status NOT IN ('REVOKED','REJECTED') AND (manifest_revision IS NULL OR manifest_revision <= $3)`,
        [row.id, refreshed.manifestDigest, refreshed.manifest.manifest_revision, refreshed.expiresAt]);
    }
    if (drift !== "NONE" || health !== "REACHABLE") {
      await recordAudit(pool, { actorType: "SYSTEM", actorId: "pic-health", productId: row.product_id, productAdminId: row.id, action: "integration.alert", outcome: "ERROR", reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(String(reason)) ? reason : drift, metadata: { health_status: health, drift_status: drift } }).catch(() => {});
    }
    return { health_status: health, drift_status: drift, reason };
  }

  async function checkAll() {
    const { rows } = await pool.query(`SELECT * FROM ${T}hq_product_admins WHERE lifecycle_status = 'ENABLED'`);
    const out = [];
    for (const row of rows) out.push({ product_id: row.product_id, ...(await check(row)) });
    return out;
  }

  return { check, checkAll };
}

module.exports = { createHealthChecker };
