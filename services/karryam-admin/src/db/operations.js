"use strict";

// Durable operation records (governed action pipeline, Section 4.3-4.5).
//
//   REJECTED                       refused before dispatch (terminal)
//   RECORDED -> DISPATCHING        intent + audit persisted, then one dispatch
//   DISPATCHING -> SUCCEEDED | FAILED | UNKNOWN_OUTCOME
//   UNKNOWN_OUTCOME -> SUCCEEDED | FAILED   only from owner readback evidence
//
// The database enforces the transitions, single dispatch and immutability of
// identity, digest, scope and requester (migration 002 triggers).
//
// recordRejection() / recordIntent() return { kind: "CREATED" | "REPLAY" |
// "KEY_CONFLICT" | "COMMAND_CONFLICT", operation }.

const { sanitize } = require("../audit");

function rowToOperation(row) {
  return {
    operation_id: row.id,
    capability_id: row.capability_id,
    status: row.status,
    reason_code: row.reason_code,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date(row.created_at).toISOString(),
    request_digest: row.request_digest,
    service_id: row.service_id,
    idempotency_key: row.idempotency_key,
    staff_ref: row.staff_ref,
    risk: row.risk || null,
    bridge_capability_id: row.bridge_capability_id || null,
    intent_digest: row.intent_digest || null,
    scope: row.scope || null,
    approval_ref: row.approval_ref || null,
    dispatch_count: row.dispatch_count || 0,
    dispatched_at: row.dispatched_at ? new Date(row.dispatched_at).toISOString() : null,
    source_status: row.source_status || null,
    source_version: row.source_version === null || row.source_version === undefined ? null : Number(row.source_version),
    outcome_evidence: row.outcome_evidence || null,
    readback_count: row.readback_count || 0,
  };
}

function auditRow(client, auditRecord, operationId) {
  const r = sanitize({ ...auditRecord, operation_id: operationId });
  return client.query(
    "INSERT INTO karryam_admin.integration_audit(correlation_id, request_id, endpoint, method, service_id, staff_ref, action, operation_id, outcome, reason_code, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [r.correlation_id, r.request_id, r.endpoint, r.method, r.service_id, r.staff_ref, r.action, r.operation_id, r.outcome, r.reason_code, JSON.stringify(r.metadata)],
  );
}

function pgOperations(pool) {
  async function get(id) {
    const result = await pool.query("SELECT * FROM karryam_admin.operation_requests WHERE id = $1", [id]);
    return result.rows[0] ? rowToOperation(result.rows[0]) : null;
  }

  async function insertOnce(op, status, auditRecord) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT * FROM karryam_admin.operation_requests WHERE service_id = $1 AND idempotency_key = $2", [op.serviceId, op.idempotencyKey]);
      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        const prior = rowToOperation(existing.rows[0]);
        return { kind: prior.request_digest === op.requestDigest && prior.operation_id === op.id && prior.staff_ref === op.staffRef ? "REPLAY" : "KEY_CONFLICT", operation: prior };
      }
      const inserted = await client.query(
        `INSERT INTO karryam_admin.operation_requests(id, service_id, idempotency_key, request_digest, capability_id, staff_ref, status, reason_code, risk, bridge_capability_id, intent_digest, scope, purpose_code, request_reason_code, case_reference, expected_version, approval_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING *`,
        [op.id, op.serviceId, op.idempotencyKey, op.requestDigest, op.capabilityId, op.staffRef, status, op.reasonCode || (status === "RECORDED" ? "INTENT_RECORDED" : "REJECTED"),
          op.risk || null, op.bridgeCapabilityId || null, op.intentDigest || null, op.scope ? JSON.stringify(op.scope) : null, op.purpose || null,
          op.requestReasonCode || null, op.caseReference || null, op.expectedVersion === undefined ? null : op.expectedVersion, op.approvalRef || null],
      );
      if (!inserted.rows[0]) {
        await client.query("ROLLBACK");
        const prior = await get(op.id);
        return { kind: prior && prior.idempotency_key === op.idempotencyKey && prior.request_digest === op.requestDigest && prior.staff_ref === op.staffRef ? "REPLAY" : "COMMAND_CONFLICT", operation: prior };
      }
      await auditRow(client, auditRecord, op.id);
      await client.query("COMMIT");
      return { kind: "CREATED", operation: rowToOperation(inserted.rows[0]) };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Moves one operation along an allowed transition with an audit row in the
  // same transaction. Returns the updated operation, or null when the
  // operation is no longer in `from` (lost race: never dispatch twice).
  async function transition(id, from, to, fields, auditRecord) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sets = ["status = $3"];
      const params = [id, from, to];
      const add = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
      if (to === "DISPATCHING") { sets.push("dispatch_count = dispatch_count + 1", "dispatched_at = now()"); }
      if (fields.reasonCode) add("reason_code", fields.reasonCode);
      if (fields.sourceStatus !== undefined) add("source_status", fields.sourceStatus);
      if (fields.sourceVersion !== undefined) add("source_version", fields.sourceVersion);
      if (fields.evidence !== undefined) add("outcome_evidence", JSON.stringify(fields.evidence));
      const { rows } = await client.query(`UPDATE karryam_admin.operation_requests SET ${sets.join(", ")} WHERE id = $1 AND status = $2${to === "DISPATCHING" ? " AND dispatch_count = 0" : ""} RETURNING *`, params);
      if (!rows[0]) { await client.query("ROLLBACK"); return null; }
      if (auditRecord) await auditRow(client, auditRecord, id);
      await client.query("COMMIT");
      return rowToOperation(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function noteReadback(id, evidence) {
    await pool.query("UPDATE karryam_admin.operation_requests SET readback_count = readback_count + 1, last_readback_at = now(), outcome_evidence = $2 WHERE id = $1 AND status IN ('UNKNOWN_OUTCOME','DISPATCHING')", [id, JSON.stringify(evidence)]);
  }

  return {
    get,
    recordRejection: (op, auditRecord) => insertOnce(op, "REJECTED", auditRecord),
    recordIntent: (op, auditRecord) => insertOnce(op, "RECORDED", auditRecord),
    transition,
    noteReadback,
  };
}

const TRANSITIONS = { RECORDED: ["REJECTED", "DISPATCHING"], DISPATCHING: ["SUCCEEDED", "FAILED", "UNKNOWN_OUTCOME"], UNKNOWN_OUTCOME: ["SUCCEEDED", "FAILED"] };

function memoryOperations(audit) {
  const byId = new Map();
  async function insertOnce(op, status, auditRecord) {
    for (const prior of byId.values()) {
      if (prior.service_id === op.serviceId && prior.idempotency_key === op.idempotencyKey) {
        return { kind: prior.request_digest === op.requestDigest && prior.operation_id === op.id && prior.staff_ref === op.staffRef ? "REPLAY" : "KEY_CONFLICT", operation: { ...prior } };
      }
    }
    if (byId.has(op.id)) return { kind: "COMMAND_CONFLICT", operation: { ...byId.get(op.id) } };
    const at = new Date().toISOString();
    const operation = rowToOperation({
      id: op.id, capability_id: op.capabilityId, status, reason_code: op.reasonCode || (status === "RECORDED" ? "INTENT_RECORDED" : "REJECTED"), created_at: at, updated_at: at,
      request_digest: op.requestDigest, service_id: op.serviceId, idempotency_key: op.idempotencyKey, staff_ref: op.staffRef, risk: op.risk, bridge_capability_id: op.bridgeCapabilityId,
      intent_digest: op.intentDigest, scope: op.scope, approval_ref: op.approvalRef, dispatch_count: 0,
    });
    await audit.record({ ...auditRecord, operation_id: op.id });
    byId.set(op.id, operation);
    return { kind: "CREATED", operation: { ...operation } };
  }
  return {
    byId,
    async get(id) { return byId.has(id) ? { ...byId.get(id) } : null; },
    recordRejection: (op, a) => insertOnce(op, "REJECTED", a),
    recordIntent: (op, a) => insertOnce(op, "RECORDED", a),
    async transition(id, from, to, fields, auditRecord) {
      const op = byId.get(id);
      if (!op || op.status !== from || !(TRANSITIONS[from] || []).includes(to) || (to === "DISPATCHING" && op.dispatch_count !== 0)) return null;
      const next = { ...op, status: to, updated_at: new Date().toISOString() };
      if (to === "DISPATCHING") { next.dispatch_count = 1; next.dispatched_at = next.updated_at; }
      if (fields.reasonCode) next.reason_code = fields.reasonCode;
      if (fields.sourceStatus !== undefined) next.source_status = fields.sourceStatus;
      if (fields.sourceVersion !== undefined) next.source_version = fields.sourceVersion;
      if (fields.evidence !== undefined) next.outcome_evidence = fields.evidence;
      if (auditRecord) await audit.record({ ...auditRecord, operation_id: id });
      byId.set(id, next);
      return { ...next };
    },
    async noteReadback(id, evidence) { const op = byId.get(id); if (op) byId.set(id, { ...op, readback_count: op.readback_count + 1, outcome_evidence: evidence }); },
  };
}

module.exports = { pgOperations, memoryOperations, rowToOperation };
