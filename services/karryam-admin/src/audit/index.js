"use strict";

// Product-level integration audit. Append-only in the database (enforced by
// triggers and by the runtime role having INSERT/SELECT only). Records hold
// sanitized metadata: no bodies, tokens, keys, NIN/OTP/bank data or GPS.

const OUTCOME = /^[A-Z][A-Z0-9_]{1,47}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const COLUMNS = ["correlation_id", "request_id", "endpoint", "method", "service_id", "staff_ref", "action", "operation_id", "outcome", "reason_code"];

function sanitize(record) {
  const out = {};
  for (const key of COLUMNS) {
    const value = record[key];
    if (value === undefined || value === null) { out[key] = null; continue; }
    out[key] = SAFE_TEXT.test(String(value)) ? String(value) : "[invalid]";
  }
  if (!OUTCOME.test(String(out.outcome))) throw new Error("audit_outcome_invalid");
  const metadata = {};
  for (const [key, value] of Object.entries(record.metadata || {})) {
    if (/^[a-z][a-z0-9_]{0,47}$/.test(key) && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && SAFE_TEXT.test(value)))) metadata[key] = value;
  }
  out.metadata = metadata;
  return out;
}

function pgAudit(pool) {
  return {
    async record(record) {
      const r = sanitize(record);
      await pool.query(
        "INSERT INTO karryam_admin.integration_audit(correlation_id, request_id, endpoint, method, service_id, staff_ref, action, operation_id, outcome, reason_code, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [r.correlation_id, r.request_id, r.endpoint, r.method, r.service_id, r.staff_ref, r.action, r.operation_id, r.outcome, r.reason_code, JSON.stringify(r.metadata)],
      );
    },
    async listForOperation(operationId) {
      const result = await pool.query(
        "SELECT occurred_at, correlation_id, endpoint, method, service_id, staff_ref, action, outcome, reason_code FROM karryam_admin.integration_audit WHERE operation_id = $1 ORDER BY id ASC LIMIT 100",
        [operationId],
      );
      return result.rows.map((row) => ({ ...row, occurred_at: new Date(row.occurred_at).toISOString() }));
    },
  };
}

function memoryAudit({ fail = false } = {}) {
  const rows = [];
  return {
    rows,
    async record(record) {
      if (fail) throw new Error("audit_unavailable");
      rows.push({ ...sanitize(record), occurred_at: new Date().toISOString() });
    },
    async listForOperation(operationId) {
      return rows.filter((r) => r.operation_id === operationId).map(({ occurred_at, correlation_id, endpoint, method, service_id, staff_ref, action, outcome, reason_code }) => ({ occurred_at, correlation_id, endpoint, method, service_id, staff_ref, action, outcome, reason_code }));
    },
  };
}

module.exports = { pgAudit, memoryAudit, sanitize };
