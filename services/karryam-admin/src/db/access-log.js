"use strict";

// Sensitive data access record: who read which class of data, for which
// purpose and scope, and how many items. Append-only (DB triggers). A write
// failure fails the read closed: no record, no data.

const CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function clean(entry) {
  const scope = {};
  for (const dim of ["market", "organization", "zone", "tenant"]) if (typeof entry.scope?.[dim] === "string" && SAFE.test(entry.scope[dim])) scope[dim] = entry.scope[dim];
  if (!SAFE.test(String(entry.staffRef)) || !SAFE.test(String(entry.capabilityId)) || !CODE.test(String(entry.outcome))) throw new Error("access_log_entry_invalid");
  return {
    correlationId: SAFE.test(String(entry.correlationId || "")) ? entry.correlationId : null,
    staffRef: entry.staffRef,
    capabilityId: entry.capabilityId,
    privacyClass: SAFE.test(String(entry.privacyClass)) ? entry.privacyClass : "UNCLASSIFIED",
    purpose: SAFE.test(String(entry.purpose || "")) ? entry.purpose : null,
    scope,
    outcome: entry.outcome,
    itemCount: Number.isInteger(entry.itemCount) && entry.itemCount >= 0 ? entry.itemCount : null,
  };
}

function pgAccessLog(pool) {
  return {
    async record(entry) {
      const e = clean(entry);
      await pool.query(
        "INSERT INTO karryam_admin.sensitive_access_log(correlation_id, staff_ref, capability_id, privacy_class, purpose_code, scope, outcome, item_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [e.correlationId, e.staffRef, e.capabilityId, e.privacyClass, e.purpose, JSON.stringify(e.scope), e.outcome, e.itemCount],
      );
    },
  };
}

function memoryAccessLog({ fail = false } = {}) {
  const rows = [];
  return { rows, async record(entry) { if (fail) throw new Error("access_log_unavailable"); rows.push(clean(entry)); } };
}

module.exports = { pgAccessLog, memoryAccessLog };
