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
      // A trust store whose source files changed since load is stale: never
      // verify (or refresh) anything with it until the process restarts.
      if (trustStore && typeof trustStore.isCurrent === "function" && !trustStore.isCurrent()) throw Object.assign(new Error("TRUST_STORE_CHANGED"), { trustChanged: true });
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
      if (err.trustChanged) {
        drift = "IDENTITY_MISMATCH";
        reason = "TRUST_STORE_CHANGED";
      } else {
        health = "UNREACHABLE";
        reason = err.reason || err.code || "PRODUCT_ADMIN_UNREACHABLE";
      }
    }
    // The decision above was made against the contract and approved signer
    // read at the start of the check. If either changed meanwhile (a contract
    // activation, a revision proposal, a re-review), this result is stale and
    // is not written: the next check decides against the new state.
    const { rowCount } = await pool.query(
      `UPDATE ${T}hq_product_admins SET health_status = $2, health_checked_at = now(),
         drift_status = CASE WHEN $3::text = 'NONE' AND $2 = 'UNREACHABLE' THEN drift_status ELSE $3::text END,
         drift_detected_at = CASE WHEN $3::text <> 'NONE' AND drift_status IS DISTINCT FROM $3::text THEN now() ELSE drift_detected_at END,
         manifest_digest = CASE WHEN $6::boolean AND (manifest_revision IS NULL OR manifest_revision <= $8) THEN $7 ELSE manifest_digest END,
         manifest_expires_at = CASE WHEN $6::boolean AND (manifest_revision IS NULL OR manifest_revision <= $8) THEN $9::timestamptz ELSE manifest_expires_at END,
         manifest_revision = CASE WHEN $6::boolean AND (manifest_revision IS NULL OR manifest_revision <= $8) THEN $8 ELSE manifest_revision END
       WHERE id = $1 AND lifecycle_status NOT IN ('REVOKED','REJECTED')
         AND current_contract_id IS NOT DISTINCT FROM $4::uuid AND approved_signer_kid IS NOT DISTINCT FROM $5::text`,
      [row.id, health, drift, row.current_contract_id || null, row.approved_signer_kid || null, Boolean(refreshed),
        refreshed ? refreshed.manifestDigest : null, refreshed ? refreshed.manifest.manifest_revision : null, refreshed ? refreshed.expiresAt : null]);
    if (rowCount === 0) {
      const { rows: [current] } = await pool.query(`SELECT lifecycle_status FROM ${T}hq_product_admins WHERE id = $1`, [row.id]);
      if (current && !["REVOKED", "REJECTED"].includes(current.lifecycle_status)) return { health_status: health, drift_status: drift, reason: "STALE_CHECK_DISCARDED", stale: true };
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
