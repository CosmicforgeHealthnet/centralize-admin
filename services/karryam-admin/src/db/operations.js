"use strict";

// Durable record of operation submissions. In this phase the only status
// the database accepts is REJECTED (CHECK constraint): no domain command can
// be recorded as accepted or executed.
//
// recordRejection() returns { kind: "CREATED" | "REPLAY" | "KEY_CONFLICT" |
// "COMMAND_CONFLICT", operation }. The rejection and its audit row are
// written in one transaction.

const { sanitize } = require("../audit");

function rowToOperation(row) {
  return {
    operation_id: row.id,
    capability_id: row.capability_id,
    status: row.status,
    reason_code: row.reason_code,
    created_at: new Date(row.created_at).toISOString(),
    request_digest: row.request_digest,
    service_id: row.service_id,
    idempotency_key: row.idempotency_key,
    staff_ref: row.staff_ref,
  };
}

function pgOperations(pool) {
  async function get(id) {
    const result = await pool.query("SELECT * FROM karryam_admin.operation_requests WHERE id = $1", [id]);
    return result.rows[0] ? rowToOperation(result.rows[0]) : null;
  }
  return {
    get,
    async recordRejection(op, auditRecord) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query("SELECT * FROM karryam_admin.operation_requests WHERE service_id = $1 AND idempotency_key = $2", [op.serviceId, op.idempotencyKey]);
        if (existing.rows[0]) {
          await client.query("ROLLBACK");
          const prior = rowToOperation(existing.rows[0]);
          return { kind: prior.request_digest === op.requestDigest && prior.operation_id === op.id ? "REPLAY" : "KEY_CONFLICT", operation: prior };
        }
        const inserted = await client.query(
          "INSERT INTO karryam_admin.operation_requests(id, service_id, idempotency_key, request_digest, capability_id, staff_ref, status, reason_code) VALUES ($1,$2,$3,$4,$5,$6,'REJECTED',$7) ON CONFLICT DO NOTHING RETURNING *",
          [op.id, op.serviceId, op.idempotencyKey, op.requestDigest, op.capabilityId, op.staffRef, op.reasonCode],
        );
        if (!inserted.rows[0]) {
          await client.query("ROLLBACK");
          const prior = await get(op.id);
          return { kind: prior && prior.idempotency_key === op.idempotencyKey && prior.request_digest === op.requestDigest ? "REPLAY" : "COMMAND_CONFLICT", operation: prior };
        }
        const r = sanitize({ ...auditRecord, operation_id: op.id });
        await client.query(
          "INSERT INTO karryam_admin.integration_audit(correlation_id, request_id, endpoint, method, service_id, staff_ref, action, operation_id, outcome, reason_code, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [r.correlation_id, r.request_id, r.endpoint, r.method, r.service_id, r.staff_ref, r.action, r.operation_id, r.outcome, r.reason_code, JSON.stringify(r.metadata)],
        );
        await client.query("COMMIT");
        return { kind: "CREATED", operation: rowToOperation(inserted.rows[0]) };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

function memoryOperations(audit) {
  const byId = new Map();
  return {
    byId,
    async get(id) { return byId.has(id) ? { ...byId.get(id) } : null; },
    async recordRejection(op, auditRecord) {
      for (const prior of byId.values()) {
        if (prior.service_id === op.serviceId && prior.idempotency_key === op.idempotencyKey) {
          return { kind: prior.request_digest === op.requestDigest && prior.operation_id === op.id ? "REPLAY" : "KEY_CONFLICT", operation: { ...prior } };
        }
      }
      if (byId.has(op.id)) return { kind: "COMMAND_CONFLICT", operation: { ...byId.get(op.id) } };
      const operation = { operation_id: op.id, capability_id: op.capabilityId, status: "REJECTED", reason_code: op.reasonCode, created_at: new Date().toISOString(), request_digest: op.requestDigest, service_id: op.serviceId, idempotency_key: op.idempotencyKey, staff_ref: op.staffRef };
      await audit.record({ ...auditRecord, operation_id: op.id });
      byId.set(op.id, operation);
      return { kind: "CREATED", operation: { ...operation } };
    },
  };
}

module.exports = { pgOperations, memoryOperations };
