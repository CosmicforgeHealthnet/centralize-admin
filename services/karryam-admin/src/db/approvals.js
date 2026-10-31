"use strict";

// Independent approval references (Section 4.5 foundation). An approval is
// bound to one capability, one intent digest and one exact scope; it is
// decided by a different staff member with recent MFA, expires, and is
// consumed at most once by exactly one operation. The database enforces the
// two-person rule, the bindings and single consumption (migration 002).

class ApprovalError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ApprovalError";
    this.reason = reason;
  }
}

const sameScope = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

function rowTo(row) {
  return {
    approval_id: row.id, capability_id: row.capability_id, intent_digest: row.intent_digest, scope: row.scope, requested_by: row.requested_by,
    requested_at: new Date(row.requested_at).toISOString(), status: row.status, decided_by: row.decided_by || null,
    decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null, expires_at: new Date(row.expires_at).toISOString(),
    consumed_by: row.consumed_by || null,
  };
}

function pgApprovals(pool, { now = Date.now } = {}) {
  return {
    async propose({ id, capabilityId, intentDigest, scope, requestedBy, ttlSeconds }) {
      const { rows } = await pool.query(
        `INSERT INTO karryam_admin.approval_references (id, capability_id, intent_digest, scope, requested_by, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,'PROPOSED', to_timestamp($6::double precision / 1000)) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, capabilityId, intentDigest, JSON.stringify(scope), requestedBy, now() + ttlSeconds * 1000]);
      if (!rows[0]) throw new ApprovalError("APPROVAL_ID_REUSED");
      return rowTo(rows[0]);
    },
    async decide({ id, decidedBy, approve, mfaAt }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [row] } = await client.query("SELECT * FROM karryam_admin.approval_references WHERE id = $1 FOR UPDATE", [id]);
        if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
        if (row.status !== "PROPOSED") throw new ApprovalError("APPROVAL_ALREADY_DECIDED");
        if (row.expires_at.getTime() <= now()) throw new ApprovalError("APPROVAL_EXPIRED");
        if (row.requested_by === decidedBy) throw new ApprovalError("APPROVER_MUST_BE_INDEPENDENT");
        const { rows: [updated] } = await client.query(
          "UPDATE karryam_admin.approval_references SET status = $2, decided_by = $3, decided_at = now(), decided_mfa_at = to_timestamp($4) WHERE id = $1 RETURNING *",
          [id, approve ? "APPROVED" : "REJECTED", decidedBy, mfaAt]);
        await client.query("COMMIT");
        return rowTo(updated);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    // Validates and consumes in one transaction (single use).
    async consume({ id, operationId, capabilityId, intentDigest, scope, requestedBy }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [row] } = await client.query("SELECT * FROM karryam_admin.approval_references WHERE id = $1 FOR UPDATE", [id]);
        if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
        if (row.status === "CONSUMED") throw new ApprovalError("APPROVAL_ALREADY_CONSUMED");
        if (row.status !== "APPROVED") throw new ApprovalError("APPROVAL_NOT_APPROVED");
        if (row.expires_at.getTime() <= now()) throw new ApprovalError("APPROVAL_EXPIRED");
        if (row.capability_id !== capabilityId || row.intent_digest !== intentDigest || !sameScope(row.scope, scope)) throw new ApprovalError("APPROVAL_BINDING_MISMATCH");
        if (row.requested_by !== requestedBy || row.decided_by === requestedBy) throw new ApprovalError("APPROVAL_REQUESTER_MISMATCH");
        await client.query("UPDATE karryam_admin.approval_references SET status = 'CONSUMED', consumed_by = $2, consumed_at = now() WHERE id = $1", [id, operationId]);
        await client.query("COMMIT");
        return true;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async get(id) {
      const { rows } = await pool.query("SELECT * FROM karryam_admin.approval_references WHERE id = $1", [id]);
      return rows[0] ? rowTo(rows[0]) : null;
    },
  };
}

function memoryApprovals({ now = Date.now } = {}) {
  const rows = new Map();
  return {
    rows,
    async propose({ id, capabilityId, intentDigest, scope, requestedBy, ttlSeconds }) {
      if (rows.has(id)) throw new ApprovalError("APPROVAL_ID_REUSED");
      const row = { id, capability_id: capabilityId, intent_digest: intentDigest, scope, requested_by: requestedBy, requested_at: new Date(now()), status: "PROPOSED", decided_by: null, decided_at: null, expires_at: new Date(now() + ttlSeconds * 1000), consumed_by: null };
      rows.set(id, row);
      return rowTo(row);
    },
    async decide({ id, decidedBy, approve }) {
      const row = rows.get(id);
      if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
      if (row.status !== "PROPOSED") throw new ApprovalError("APPROVAL_ALREADY_DECIDED");
      if (row.expires_at.getTime() <= now()) throw new ApprovalError("APPROVAL_EXPIRED");
      if (row.requested_by === decidedBy) throw new ApprovalError("APPROVER_MUST_BE_INDEPENDENT");
      Object.assign(row, { status: approve ? "APPROVED" : "REJECTED", decided_by: decidedBy, decided_at: new Date(now()) });
      return rowTo(row);
    },
    async consume({ id, operationId, capabilityId, intentDigest, scope, requestedBy }) {
      const row = rows.get(id);
      if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
      if (row.status === "CONSUMED") throw new ApprovalError("APPROVAL_ALREADY_CONSUMED");
      if (row.status !== "APPROVED") throw new ApprovalError("APPROVAL_NOT_APPROVED");
      if (row.expires_at.getTime() <= now()) throw new ApprovalError("APPROVAL_EXPIRED");
      if (row.capability_id !== capabilityId || row.intent_digest !== intentDigest || !sameScope(row.scope, scope)) throw new ApprovalError("APPROVAL_BINDING_MISMATCH");
      if (row.requested_by !== requestedBy || row.decided_by === requestedBy) throw new ApprovalError("APPROVAL_REQUESTER_MISMATCH");
      Object.assign(row, { status: "CONSUMED", consumed_by: operationId });
      return true;
    },
    async get(id) { return rows.has(id) ? rowTo(rows.get(id)) : null; },
  };
}

module.exports = { pgApprovals, memoryApprovals, ApprovalError };
