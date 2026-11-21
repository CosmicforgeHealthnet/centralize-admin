"use strict";

// High-risk (R3/R4) command certifications (Section 11.3). Written only by
// the operator with the migration identity (scripts/high-risk-certification.js);
// the runtime role can only read them. A certification is in force for one
// capability under one pinned Bridge contract revision, between valid_from
// and expires_at, until revoked. It never enables anything by itself: the
// operator allowlist, runtime Bridge availability, recent MFA, an
// independent approval of the exact intent and the Bridge's own
// authorization are all still required.

function rowTo(row) {
  return {
    certification_id: row.id, capability_id: row.capability_id, risk: row.risk, contract_revision: row.contract_revision,
    source_policy_revision: row.source_policy_revision, evidence_ref: row.evidence_ref,
    valid_from: new Date(row.valid_from).toISOString(), expires_at: new Date(row.expires_at).toISOString(),
  };
}

function pgCertifications(pool, { now = Date.now } = {}) {
  return {
    /** The certification in force now, or null. */
    async active(capabilityId, contractRevision) {
      const { rows } = await pool.query(
        `SELECT * FROM karryam_admin.high_risk_certifications WHERE capability_id = $1 AND contract_revision = $2 AND revoked_at IS NULL
           AND valid_from <= to_timestamp($3::double precision / 1000) AND expires_at > to_timestamp($3::double precision / 1000)`,
        [capabilityId, contractRevision, now()]);
      return rows[0] ? rowTo(rows[0]) : null;
    },
    /** Capability ids with a certification in force (used for exposure at startup). */
    async activeIds(contractRevision) {
      const { rows } = await pool.query(
        `SELECT capability_id FROM karryam_admin.high_risk_certifications WHERE contract_revision = $1 AND revoked_at IS NULL
           AND valid_from <= to_timestamp($2::double precision / 1000) AND expires_at > to_timestamp($2::double precision / 1000)`,
        [contractRevision, now()]);
      return rows.map((r) => r.capability_id);
    },
  };
}

// Test double with the same semantics.
function memoryCertifications(entries = [], { now = Date.now } = {}) {
  const rows = entries.map((e) => ({ revoked_at: null, ...e }));
  const live = (r, capabilityId, rev) => r.capability_id === capabilityId && r.contract_revision === rev && !r.revoked_at && Date.parse(r.valid_from) <= now() && Date.parse(r.expires_at) > now();
  return {
    rows,
    async active(capabilityId, rev) { const r = rows.find((x) => live(x, capabilityId, rev)); return r ? rowTo(r) : null; },
    async activeIds(rev) { return rows.filter((r) => live(r, r.capability_id, rev)).map((r) => r.capability_id); },
  };
}

module.exports = { pgCertifications, memoryCertifications };
