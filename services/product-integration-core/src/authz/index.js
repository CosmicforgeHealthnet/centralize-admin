"use strict";

// Product- and platform-scoped authorization backed by registry grants.
// Staff tier is carried for audit context only and is never consulted.

const I = require("../../../../packages/identity-and-permissions");
const { T } = require("../db");
const { recordAudit } = require("../audit");

function toGrant(row) {
  return {
    id: row.id,
    grant_kind: row.grant_kind,
    product_id: row.product_id,
    staff_id: row.staff_id,
    role: row.role,
    effect: row.effect,
    actions: row.actions,
    datasets: row.datasets,
    scope: row.scope,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

async function loadGrants(db, staffId) {
  try {
    const { rows } = await db.query(`SELECT * FROM ${T}hq_product_admin_grants WHERE staff_id = $1`, [staffId]);
    return rows.map(toGrant);
  } catch {
    return null; // policy unavailable -> deny
  }
}

class AuthorizationError extends Error {
  constructor(reason, status = 403) {
    super(reason);
    this.name = "AuthorizationError";
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Authorizes and audits. Denials are always audited; allowed sensitive
 * actions are audited too. If the audit write fails the request is denied.
 */
async function authorizeStaff(db, { subject, action, productId = null, productAdminId = null, datasetId = null, requestedScope = {}, productScope = null, correlationId, now = Date.now() }) {
  const grants = await loadGrants(db, subject.staffId);
  const decision = I.authorize({ subject, productId, action, datasetId, requestedScope, grants, productScope, now });
  const sensitive = !decision.allowed || action.startsWith("integration.") || action === "operation.submit" || action === "product.capabilities.read";
  if (sensitive) {
    try {
      await recordAudit(db, { correlationId, actorType: "STAFF", actorId: subject.staffId, productId, productAdminId, action, outcome: decision.allowed ? "ALLOWED" : "DENIED", reasonCode: decision.allowed ? null : decision.reason, metadata: { dataset_id: datasetId, session_ref: subject.sessionId } });
    } catch {
      throw new AuthorizationError("AUDIT_UNAVAILABLE", 503);
    }
  }
  if (!decision.allowed) throw new AuthorizationError(decision.reason, decision.reason === "POLICY_UNAVAILABLE" ? 503 : 403);
  return decision;
}

module.exports = { loadGrants, authorizeStaff, AuthorizationError, toGrant };
