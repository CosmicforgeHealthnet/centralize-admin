"use strict";

// Independent approval references (Sections 4.5 and 11.3). An approval is
// bound to one capability, one intent digest, one exact scope and, when
// given, the expected source version; for high-risk (R3/R4) commands also to
// the certification and source policy revision the approver reviewed. It is
// decided by a different staff member with recent MFA, expires, can be
// revoked, and is consumed at most once by exactly one operation. The
// database enforces the two-person rule, the immutable bindings, single
// decision and single consumption (migrations 002-004).

class ApprovalError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ApprovalError";
    this.reason = reason;
  }
}

const sameScope = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function rowTo(row) {
  return {
    approval_id: row.id, capability_id: row.capability_id, intent_digest: row.intent_digest, scope: row.scope, requested_by: row.requested_by,
    requested_at: new Date(row.requested_at).toISOString(), status: row.status, decided_by: row.decided_by || null,
    decided_at: row.decided_at ? new Date(row.decided_at).toISOString() : null, expires_at: new Date(row.expires_at).toISOString(),
    consumed_by: row.consumed_by || null, risk: row.risk || null,
    expected_version: row.expected_version === null || row.expected_version === undefined ? null : Number(row.expected_version),
    source_policy_revision: row.source_policy_revision || null, certification_id: row.certification_id || null,
    target_type: row.target_type || null, target_id: row.target_id || null, request_reason_code: row.request_reason_code || null, case_reference: row.case_reference || null,
  };
}

// Shared consumption checks (identical for both stores).
function consumeErrors(row, { capabilityId, intentDigest, scope, requestedBy, expectedVersion, sourcePolicyRevision, certificationId }, nowMs) {
  if (!row) return "APPROVAL_NOT_FOUND";
  if (row.status === "CONSUMED") return "APPROVAL_ALREADY_CONSUMED";
  if (row.status === "REVOKED") return "APPROVAL_REVOKED";
  if (row.status !== "APPROVED") return "APPROVAL_NOT_APPROVED";
  if (new Date(row.expires_at).getTime() <= nowMs) return "APPROVAL_EXPIRED";
  if (row.capability_id !== capabilityId || row.intent_digest !== intentDigest || !sameScope(row.scope, scope)) return "APPROVAL_BINDING_MISMATCH";
  if (row.requested_by !== requestedBy || row.decided_by === requestedBy) return "APPROVAL_REQUESTER_MISMATCH";
  if (row.expected_version !== null && row.expected_version !== undefined && Number(row.expected_version) !== expectedVersion) return "APPROVAL_SOURCE_VERSION_CHANGED";
  // High-risk approvals stay valid only under the certification and source
  // policy revision the approver reviewed.
  if (certificationId !== undefined || row.certification_id) {
    if ((row.certification_id || null) !== (certificationId || null)) return "APPROVAL_CERTIFICATION_CHANGED";
    if ((row.source_policy_revision || null) !== (sourcePolicyRevision || null)) return "APPROVAL_POLICY_CHANGED";
  }
  return null;
}

function pgApprovals(pool, { now = Date.now } = {}) {
  async function withRow(id, fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [row] } = await client.query("SELECT * FROM cfmeet_admin.approval_references WHERE id = $1 FOR UPDATE", [id]);
      const out = await fn(client, row);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async propose({ id, capabilityId, intentDigest, scope, requestedBy, ttlSeconds, risk = null, expectedVersion = null, sourcePolicyRevision = null, certificationId = null, summary = {} }) {
      const { rows } = await pool.query(
        `INSERT INTO cfmeet_admin.approval_references (id, capability_id, intent_digest, scope, requested_by, status, expires_at, risk, expected_version, source_policy_revision, certification_id,
           target_type, target_id, request_reason_code, case_reference)
         VALUES ($1,$2,$3,$4,$5,'PROPOSED', to_timestamp($6::double precision / 1000), $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, capabilityId, intentDigest, JSON.stringify(scope), requestedBy, now() + ttlSeconds * 1000, risk, expectedVersion, sourcePolicyRevision, certificationId,
          summary.targetType || null, summary.targetId || null, summary.reasonCode || null, summary.caseReference || null]);
      if (!rows[0]) throw new ApprovalError("APPROVAL_ID_REUSED");
      return rowTo(rows[0]);
    },
    async decide({ id, decidedBy, approve, mfaAt }) {
      return withRow(id, async (client, row) => {
        if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
        if (row.status !== "PROPOSED") throw new ApprovalError("APPROVAL_ALREADY_DECIDED");
        if (row.expires_at.getTime() <= now()) throw new ApprovalError("APPROVAL_EXPIRED");
        if (row.requested_by === decidedBy) throw new ApprovalError("APPROVER_MUST_BE_INDEPENDENT");
        const { rows: [updated] } = await client.query(
          "UPDATE cfmeet_admin.approval_references SET status = $2, decided_by = $3, decided_at = now(), decided_mfa_at = to_timestamp($4) WHERE id = $1 RETURNING *",
          [id, approve ? "APPROVED" : "REJECTED", decidedBy, mfaAt]);
        return rowTo(updated);
      });
    },
    async revoke({ id, revokedBy, reasonCode }) {
      if (!CODE.test(String(reasonCode))) throw new ApprovalError("REVOCATION_REASON_REQUIRED");
      return withRow(id, async (client, row) => {
        if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
        if (!["PROPOSED", "APPROVED"].includes(row.status)) throw new ApprovalError("APPROVAL_NOT_REVOCABLE");
        if (row.status === "APPROVED" && row.requested_by === revokedBy) throw new ApprovalError("REQUESTER_CANNOT_REVOKE_APPROVAL");
        const { rows: [updated] } = await client.query(
          "UPDATE cfmeet_admin.approval_references SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, revocation_reason = $3 WHERE id = $1 RETURNING *", [id, revokedBy, reasonCode]);
        return rowTo(updated);
      });
    },
    // Validates and consumes in one transaction (single use).
    async consume({ id, operationId, ...binding }) {
      return withRow(id, async (client, row) => {
        const error = consumeErrors(row, binding, now());
        if (error) throw new ApprovalError(error);
        await client.query("UPDATE cfmeet_admin.approval_references SET status = 'CONSUMED', consumed_by = $2, consumed_at = now() WHERE id = $1", [id, operationId]);
        return true;
      });
    },
    async get(id) {
      const { rows } = await pool.query("SELECT * FROM cfmeet_admin.approval_references WHERE id = $1", [id]);
      return rows[0] ? rowTo(rows[0]) : null;
    },
    // Approvals inbox page (read only), newest first. The keyset carries
    // requested_at at full database precision (microseconds, UTC, ISO 8601
    // whatever the session DateStyle), so no row is skipped or repeated
    // between pages.
    async list(filter) {
      const params = [];
      const where = [];
      const add = (sql, ...values) => {
        const at = params.length;
        params.push(...values);
        where.push(sql.replace(/\$(\d)/g, (_, n) => "$" + (at + Number(n))));
      };
      add("scope->'market' ? $1 AND scope->'organization' ? $2", filter.market, filter.organization);
      if (filter.zone) add("scope->'zone' ? $1", filter.zone);
      if (filter.tenant) add("scope->'tenant' ? $1", filter.tenant);
      if (filter.requestedBy) add("requested_by = $1", filter.requestedBy);
      if (filter.notRequestedBy) add("requested_by <> $1", filter.notRequestedBy);
      if (filter.openAt !== undefined) add("status = 'PROPOSED' AND expires_at > to_timestamp($1::double precision / 1000)", filter.openAt);
      if (filter.after) add("(requested_at, id) < ($1::timestamptz, $2::uuid)", filter.after.at, filter.after.id);
      params.push(filter.limit);
      const { rows } = await pool.query(
        `SELECT *, to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS keyset_at FROM cfmeet_admin.approval_references WHERE ${where.join(" AND ")} ORDER BY requested_at DESC, id DESC LIMIT $${params.length}`, params);
      return rows.map((row) => ({ approval: rowTo(row), key: { at: row.keyset_at, id: row.id } }));
    },
  };
}

function memoryApprovals({ now = Date.now } = {}) {
  const rows = new Map();
  const get = (id) => rows.get(id);
  return {
    rows,
    async propose({ id, capabilityId, intentDigest, scope, requestedBy, ttlSeconds, risk = null, expectedVersion = null, sourcePolicyRevision = null, certificationId = null, summary = {} }) {
      if (rows.has(id)) throw new ApprovalError("APPROVAL_ID_REUSED");
      const row = { id, capability_id: capabilityId, intent_digest: intentDigest, scope, requested_by: requestedBy, requested_at: new Date(now()), status: "PROPOSED", decided_by: null, decided_at: null,
        expires_at: new Date(now() + ttlSeconds * 1000), consumed_by: null, risk, expected_version: expectedVersion, source_policy_revision: sourcePolicyRevision, certification_id: certificationId,
        target_type: summary.targetType, target_id: summary.targetId, request_reason_code: summary.reasonCode, case_reference: summary.caseReference };
      rows.set(id, row);
      return rowTo(row);
    },
    async decide({ id, decidedBy, approve }) {
      const row = get(id);
      if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
      if (row.status !== "PROPOSED") throw new ApprovalError("APPROVAL_ALREADY_DECIDED");
      if (row.expires_at.getTime() <= now()) throw new ApprovalError("APPROVAL_EXPIRED");
      if (row.requested_by === decidedBy) throw new ApprovalError("APPROVER_MUST_BE_INDEPENDENT");
      Object.assign(row, { status: approve ? "APPROVED" : "REJECTED", decided_by: decidedBy, decided_at: new Date(now()) });
      return rowTo(row);
    },
    async revoke({ id, revokedBy, reasonCode }) {
      if (!CODE.test(String(reasonCode))) throw new ApprovalError("REVOCATION_REASON_REQUIRED");
      const row = get(id);
      if (!row) throw new ApprovalError("APPROVAL_NOT_FOUND");
      if (!["PROPOSED", "APPROVED"].includes(row.status)) throw new ApprovalError("APPROVAL_NOT_REVOCABLE");
      if (row.status === "APPROVED" && row.requested_by === revokedBy) throw new ApprovalError("REQUESTER_CANNOT_REVOKE_APPROVAL");
      Object.assign(row, { status: "REVOKED" });
      return rowTo(row);
    },
    async consume({ id, operationId, ...binding }) {
      const row = get(id);
      const error = consumeErrors(row, binding, now());
      if (error) throw new ApprovalError(error);
      Object.assign(row, { status: "CONSUMED", consumed_by: operationId });
      return true;
    },
    async get(id) { return rows.has(id) ? rowTo(rows.get(id)) : null; },
    // Same filter and order as the PostgreSQL store (requested_at DESC, id DESC).
    async list(filter) {
      const has = (row, dim, value) => Array.isArray(row.scope[dim]) && row.scope[dim].includes(value);
      const before = (row) => {
        const at = row.requested_at.getTime();
        const after = Date.parse(filter.after.at);
        return at < after || (at === after && row.id < filter.after.id);
      };
      return [...rows.values()]
        .filter((row) => has(row, "market", filter.market) && has(row, "organization", filter.organization)
          && (!filter.zone || has(row, "zone", filter.zone)) && (!filter.tenant || has(row, "tenant", filter.tenant))
          && (!filter.requestedBy || row.requested_by === filter.requestedBy) && (!filter.notRequestedBy || row.requested_by !== filter.notRequestedBy)
          && (filter.openAt === undefined || (row.status === "PROPOSED" && row.expires_at.getTime() > filter.openAt))
          && (!filter.after || before(row)))
        .sort((a, b) => b.requested_at - a.requested_at || (a.id < b.id ? 1 : -1))
        .slice(0, filter.limit)
        .map((row) => ({ approval: rowTo(row), key: { at: row.requested_at.toISOString(), id: row.id } }));
    },
  };
}

module.exports = { pgApprovals, memoryApprovals, ApprovalError, consumeErrors };
