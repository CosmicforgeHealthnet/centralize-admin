"use strict";

// The single synchronization and availability gate, shared by the sync
// engine (at run start and again inside every apply/ACK transaction), the
// staff navigation and read API. Deny by default: a product synchronizes, and
// is shown as available, only when every condition below holds. Any state
// this file does not list as safe blocks.

const C = require("../../../../packages/admin-contracts");
const { T } = require("../db");

// The only drift state in which synchronization may run: the health checker
// verified a manifest from the approved signer whose catalog is exactly the
// active, approved contract.
const SYNC_SAFE_DRIFT = Object.freeze(["NONE"]);

// The product's identity or signed manifest can no longer be verified.
const IDENTITY_DRIFT = Object.freeze(["IDENTITY_MISMATCH", "MANIFEST_EXPIRED", "MANIFEST_INVALID"]);

// The product now publishes a contract that differs from the approved one.
// BREAKING_DETECTED needs a new major onboarding; ADDITIVE_PENDING_REVIEW
// needs propose -> certify -> activate before anything new is consumed.
const CONTRACT_DRIFT = Object.freeze(["BREAKING_DETECTED", "ADDITIVE_PENDING_REVIEW"]);

const SIGNER_REASONS = Object.freeze(["TRUST_STORE_UNAVAILABLE", "TRUST_STORE_CHANGED", "SIGNER_UNKNOWN", "SIGNER_REVOKED", "SIGNER_EXPIRED", "SIGNER_SCOPE_MISMATCH"]);

function driftBlock(drift) {
  if (SYNC_SAFE_DRIFT.includes(drift)) return null;
  if (IDENTITY_DRIFT.includes(drift) || CONTRACT_DRIFT.includes(drift)) return drift;
  return "DRIFT_STATE_UNRECOGNIZED";
}

// Re-checks the registry-approved signer against the trust store in force.
function signerBlock(row, trustStore, nowMs) {
  if (!trustStore || typeof trustStore !== "object") return "TRUST_STORE_UNAVAILABLE";
  if (typeof trustStore.isCurrent === "function" && !trustStore.isCurrent()) return "TRUST_STORE_CHANGED";
  const kid = row.approved_signer_kid;
  const entry = kid && Object.prototype.hasOwnProperty.call(trustStore, kid) ? trustStore[kid] : null;
  if (!entry || typeof entry !== "object") return "SIGNER_UNKNOWN";
  if (entry.revoked !== false && entry.revoked !== undefined) return "SIGNER_REVOKED";
  const notAfter = typeof entry.notAfter === "number" ? entry.notAfter : Date.parse(entry.notAfter);
  if (!Number.isFinite(notAfter) || notAfter <= nowMs) return "SIGNER_EXPIRED";
  if (entry.productId !== row.product_id || entry.environment !== row.environment) return "SIGNER_SCOPE_MISMATCH";
  return null;
}

function manifestBlock(row, nowMs) {
  const expires = row.manifest_expires_at ? new Date(row.manifest_expires_at).getTime() : NaN;
  return !Number.isFinite(expires) || expires <= nowMs ? "MANIFEST_EXPIRED" : null;
}

function protocolOf(contract) {
  if (contract.catalog && contract.catalog.protocol) return contract.catalog.protocol;
  return { major: contract.protocol_major, minor: contract.protocol_minor };
}

// Full gate. `row` is the registration (hq_product_admins), `contract` the
// contract the caller is about to use. Returns null or a sanitized reason.
//   trustStore: required for synchronization; pass `false` only for staff
//   read paths that have no trust store (signer checks are then left to the
//   engine and the health checker).
function syncBlock({ row, contract, trustStore, environment, nowMs }) {
  if (trustStore !== false) {
    if (!trustStore || typeof trustStore !== "object") return "TRUST_STORE_UNAVAILABLE";
    if (typeof trustStore.isCurrent === "function" && !trustStore.isCurrent()) return "TRUST_STORE_CHANGED";
  }
  if (!row || row.lifecycle_status !== "ENABLED") return "PRODUCT_NOT_ENABLED";
  if (environment !== undefined && row.environment !== environment) return "ENVIRONMENT_MISMATCH";
  if (!contract || (contract.status !== undefined && contract.status !== "ACTIVE")) return "NO_ACTIVE_CONTRACT";
  if (contract.id !== undefined && row.current_contract_id !== undefined && String(contract.id) !== String(row.current_contract_id)) return "CONTRACT_SUPERSEDED";
  if (!C.isSupportedProtocol(protocolOf(contract))) return "PROTOCOL_UNSUPPORTED";
  const drift = driftBlock(row.drift_status);
  if (drift) return drift;
  const manifest = manifestBlock(row, nowMs);
  if (manifest) return manifest;
  if (trustStore !== false) return signerBlock(row, trustStore, nowMs);
  return null;
}

// Sync-run outcome for a block reason.
function blockStatus(reason) {
  if (reason === "PRODUCT_NOT_ENABLED") return "ABORTED_REVOKED";
  if (IDENTITY_DRIFT.includes(reason) || SIGNER_REASONS.includes(reason)) return "BLOCKED_IDENTITY";
  if (CONTRACT_DRIFT.includes(reason) || reason === "CONTRACT_SUPERSEDED") return "BLOCKED_CONTRACT_DRIFT";
  return "BLOCKED_SYNC_POLICY";
}

// Staff-facing availability reason (navigation and product reads).
function availabilityReason(reason) {
  if (reason === null) return null;
  if (reason === "PRODUCT_NOT_ENABLED" || reason === "NO_ACTIVE_CONTRACT") return "NOT_ENABLED";
  if (reason === "PROTOCOL_UNSUPPORTED") return "PROTOCOL_INCOMPATIBLE";
  if (IDENTITY_DRIFT.includes(reason) || SIGNER_REASONS.includes(reason)) return "IDENTITY_NOT_VERIFIED";
  return "CONTRACT_DRIFT";
}

const GATE_COLUMNS = "id, product_id, environment, lifecycle_status, drift_status, manifest_expires_at, approved_signer_kid, current_contract_id";

// Re-reads the registration and active contract inside a transaction (FOR
// SHARE, so a concurrent revocation, drift record or contract activation
// waits for, or is seen by, this decision) and re-evaluates the gate.
async function currentBlock(db, { productAdminId, contractId, trustStore, environment, nowMs, lock = false }) {
  const { rows: [row] } = await db.query(`SELECT ${GATE_COLUMNS} FROM ${T}hq_product_admins WHERE id = $1${lock ? " FOR SHARE" : ""}`, [productAdminId]);
  if (!row) return "PRODUCT_NOT_ENABLED";
  const { rows: [contract] } = await db.query(`SELECT id, status, protocol_major, protocol_minor FROM ${T}hq_product_admin_contracts WHERE id = $1${lock ? " FOR SHARE" : ""}`, [row.current_contract_id]);
  if (contract && contractId !== undefined && String(contract.id) !== String(contractId)) return row.lifecycle_status === "ENABLED" ? "CONTRACT_SUPERSEDED" : "PRODUCT_NOT_ENABLED";
  return syncBlock({ row, contract: contract || null, trustStore, environment, nowMs });
}

module.exports = { SYNC_SAFE_DRIFT, IDENTITY_DRIFT, CONTRACT_DRIFT, driftBlock, signerBlock, syncBlock, blockStatus, availabilityReason, currentBlock };
