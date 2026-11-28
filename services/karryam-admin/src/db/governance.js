"use strict";

// Section 9 data governance in the dedicated Karryam Admin database:
//
//  - runtime capability discovery snapshots (separate from the pinned
//    static inventory; missing or expired means UNKNOWN, never available);
//  - legal holds (two-person, released once) that override retention and
//    erasure, enforced again by database triggers;
//  - per-data-class retention that clears minimized inbox payloads while
//    keeping event identity, digest and lineage;
//  - authorized erasure, allowed only after the source owner confirmed a
//    privacy fulfilment through the governed operation pipeline.
//
// Retention, erasure and hold placement serialize on one advisory lock so a
// hold placed while a retention run is in flight is never skipped.

const { randomUUID } = require("node:crypto");

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const STAFF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RETENTION_LOCK = 728_411_009;
const SNAPSHOT_TTL_SECONDS = 900;
const PRIVACY_FULFILMENT = "karryam.hq.privacy.fulfilment";

class GovernanceError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "GovernanceError";
    this.reason = reason;
  }
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function createGovernanceStore(pool, { now = Date.now } = {}) {
  // ------------------------------------------------- capability discovery
  /**
   * Stores one Bridge discovery result. `discovery` is the Bridge result
   * ({ contract_version, openapi_sha256, capabilities[] }); only entries that
   * exist in the pinned registry are kept, with the state the Bridge
   * reported. Returns the number of rows stored.
   */
  async function recordCapabilityDiscovery({ discovery, registry, contractRevision, staff, ttlSeconds = SNAPSHOT_TTL_SECONDS }) {
    if (!discovery || !Array.isArray(discovery.capabilities) || !HEX64.test(String(discovery.openapi_sha256 || ""))) throw new GovernanceError("DISCOVERY_INVALID");
    if (!HEX64.test(String(contractRevision))) throw new GovernanceError("CONTRACT_REVISION_INVALID");
    const ttl = Math.max(60, Math.min(Number(ttlSeconds) || SNAPSHOT_TTL_SECONDS, 86400));
    const discoveryId = randomUUID();
    const observedAt = new Date(now());
    const expiresAt = new Date(now() + ttl * 1000);
    let stored = 0;
    await tx(pool, async (client) => {
      for (const item of discovery.capabilities.slice(0, 1000)) {
        const pinned = item && typeof item.id === "string" ? registry.capability(item.id) : null;
        if (!pinned) continue; // unknown to the pinned contract: never cached as a capability
        const state = typeof item.state === "string" && /^[A-Z][A-Z_]{1,31}$/.test(item.state) ? item.state : "UNKNOWN";
        await client.query(
          `INSERT INTO karryam_admin.capability_snapshots (discovery_id, capability_id, observed_state, required_permission, risk, source_owner, contract_revision, source_openapi_sha256, policy_fingerprint, market, organization, bridge_role, staff_ref, observed_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14)`,
          [discoveryId, pinned.id, state, pinned.permission, pinned.risk, pinned.owner, contractRevision, discovery.openapi_sha256,
            staff.market, staff.organization, staff.role, staff.sub, observedAt, expiresAt]);
        stored += 1;
      }
    });
    return { discoveryId, stored, observedAt: observedAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }

  /**
   * Latest unexpired runtime observation of one capability for one Bridge
   * role. Returns { state, observed_at, expires_at } where state is the
   * Bridge-reported state, or UNKNOWN when there is no current observation
   * or the observation was made against another source contract.
   */
  async function runtimeAvailability(capabilityId, bridgeRole, { contractRevision, openapiSha256 } = {}) {
    const { rows: [row] } = await pool.query(
      `SELECT observed_state, observed_at, expires_at, contract_revision, source_openapi_sha256 FROM karryam_admin.capability_snapshots
       WHERE capability_id = $1 AND bridge_role = $2 ORDER BY observed_at DESC, id DESC LIMIT 1`, [capabilityId, bridgeRole]);
    if (!row || row.expires_at.getTime() <= now()) return { state: "UNKNOWN", reason: row ? "OBSERVATION_EXPIRED" : "NO_RUNTIME_OBSERVATION" };
    if ((contractRevision && row.contract_revision !== contractRevision) || (openapiSha256 && row.source_openapi_sha256 !== openapiSha256)) {
      return { state: "UNKNOWN", reason: "OBSERVED_UNDER_OTHER_CONTRACT" };
    }
    return { state: row.observed_state, observed_at: row.observed_at.toISOString(), expires_at: row.expires_at.toISOString() };
  }

  // ------------------------------------------------------------ legal holds
  async function placeLegalHold({ target, reasonCode, caseReference, placedBy, approvedBy }) {
    if (!CODE.test(String(reasonCode)) || !REF.test(String(caseReference))) throw new GovernanceError("HOLD_REASON_INVALID");
    if (!STAFF.test(String(placedBy)) || !STAFF.test(String(approvedBy))) throw new GovernanceError("HOLD_ACTOR_INVALID");
    if (placedBy === approvedBy) throw new GovernanceError("HOLD_REQUIRES_INDEPENDENT_APPROVER");
    const entity = target && target.kind === "ENTITY";
    if (entity ? ![target.sourceService, target.entityType, target.entityRef].every((v) => REF.test(String(v))) : !(target && target.kind === "PARTITION" && REF.test(String(target.partitionKey)))) {
      throw new GovernanceError("HOLD_TARGET_INVALID");
    }
    const id = randomUUID();
    await tx(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [RETENTION_LOCK]);
      await client.query(
        `INSERT INTO karryam_admin.legal_holds (id, hold_scope, source_service, entity_type, entity_ref, partition_key, reason_code, case_reference, placed_by, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, target.kind, entity ? target.sourceService : null, entity ? target.entityType : null, entity ? target.entityRef : null, entity ? null : target.partitionKey,
          reasonCode, caseReference, placedBy, approvedBy]);
    });
    return id;
  }

  async function releaseLegalHold({ id, releasedBy, releaseReason }) {
    if (!STAFF.test(String(releasedBy)) || !CODE.test(String(releaseReason))) throw new GovernanceError("HOLD_RELEASE_INVALID");
    const { rowCount } = await pool.query(
      `UPDATE karryam_admin.legal_holds SET released_at = now(), released_by = $2, release_reason = $3 WHERE id = $1 AND released_at IS NULL`, [id, releasedBy, releaseReason]);
    if (rowCount !== 1) throw new GovernanceError("HOLD_NOT_ACTIVE");
    return true;
  }

  async function activeLegalHolds() {
    const { rows } = await pool.query(`SELECT id, hold_scope, source_service, entity_type, entity_ref, partition_key, reason_code, case_reference, placed_by, approved_by, placed_at FROM karryam_admin.legal_holds WHERE released_at IS NULL ORDER BY placed_at`);
    return rows;
  }

  // --------------------------------------------------------------- retention
  async function retentionPolicy(dataClass) {
    const { rows: [row] } = await pool.query(`SELECT data_class, retention_days, action FROM karryam_admin.retention_policies WHERE data_class = $1`, [dataClass]);
    return row ? { dataClass: row.data_class, retentionDays: row.retention_days, action: row.action } : null;
  }

  /**
   * Clears expired minimized inbox payloads (identity, digest, sequence and
   * lineage stay). Rows under an active legal hold are skipped. The
   * effective retention is the stricter-of-longer: max(policy, configured).
   */
  async function clearExpiredPayloads({ configuredDays = null } = {}) {
    const policy = await retentionPolicy("BRIDGE_EVENT_PAYLOAD");
    if (!policy || policy.action !== "CLEAR_PAYLOAD") return { cleared: 0, retainedUnderHold: 0, retentionDays: null };
    const days = Math.max(policy.retentionDays, Number.isInteger(configuredDays) ? configuredDays : 0);
    return tx(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [RETENTION_LOCK]);
      const { rows: [held] } = await client.query(
        `SELECT count(*)::int AS n FROM karryam_admin.bridge_event_inbox WHERE payload IS NOT NULL AND received_at < now() - make_interval(days => $1)
           AND karryam_admin.under_legal_hold(partition_key, source_service, entity_type, entity_ref)`, [days]);
      const { rowCount } = await client.query(
        `UPDATE karryam_admin.bridge_event_inbox SET payload = NULL, payload_cleared_at = now(), payload_cleared_reason = 'RETENTION'
         WHERE payload IS NOT NULL AND received_at < now() - make_interval(days => $1)
           AND NOT karryam_admin.under_legal_hold(partition_key, source_service, entity_type, entity_ref)`, [days]);
      return { cleared: rowCount, retainedUnderHold: held.n, retentionDays: days };
    });
  }

  /**
   * Authorized erasure of one source entity's minimized data held by
   * Karryam Admin. Requires a SUCCEEDED privacy fulfilment operation whose
   * owner evidence is source-confirmed; refused under legal hold. Event
   * identity, digests, lineage and audit stay.
   */
  async function eraseEntity({ sourceService, entityType, entityRef, fulfilmentOperationId, actor }) {
    if (![sourceService, entityType, entityRef].every((v) => REF.test(String(v))) || !STAFF.test(String(actor))) throw new GovernanceError("ERASURE_REQUEST_INVALID");
    return tx(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [RETENTION_LOCK]);
      const { rows: [op] } = await client.query(
        `SELECT status, capability_id, source_status, reason_code FROM karryam_admin.operation_requests WHERE id = $1`, [fulfilmentOperationId]);
      if (!op || op.capability_id !== PRIVACY_FULFILMENT) throw new GovernanceError("ERASURE_REQUIRES_PRIVACY_FULFILMENT");
      if (op.status !== "SUCCEEDED" || !["SOURCE_CONFIRMED", "SOURCE_CONFIRMED_BY_READBACK"].includes(op.reason_code)) throw new GovernanceError("ERASURE_NOT_CONFIRMED_BY_OWNER");
      const { rows: [proj] } = await client.query(
        `SELECT partition_key, redacted_at FROM karryam_admin.entity_projections WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3 FOR UPDATE`, [sourceService, entityType, entityRef]);
      const partition = proj ? proj.partition_key : null;
      const { rows: [hold] } = await client.query(`SELECT karryam_admin.under_legal_hold($1,$2,$3,$4) AS held`, [partition, sourceService, entityType, entityRef]);
      if (hold.held) throw new GovernanceError("LEGAL_HOLD_ACTIVE");
      const { rowCount: payloads } = await client.query(
        `UPDATE karryam_admin.bridge_event_inbox SET payload = NULL, payload_cleared_at = now(), payload_cleared_reason = 'ERASURE'
         WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3 AND payload IS NOT NULL`, [sourceService, entityType, entityRef]);
      let projection = false;
      if (proj && !proj.redacted_at) {
        await client.query(`UPDATE karryam_admin.entity_projections SET payload = '{}'::jsonb, redacted_at = now() WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3`, [sourceService, entityType, entityRef]);
        projection = true;
      }
      await client.query(
        `INSERT INTO karryam_admin.integration_audit (endpoint, method, staff_ref, action, operation_id, outcome, reason_code, metadata) VALUES ('governance', 'INTERNAL', $1, 'privacy.erasure', $2, 'ERASURE_APPLIED', NULL, $3)`,
        [actor, fulfilmentOperationId, JSON.stringify({ entity_type: entityType, payloads_cleared: payloads, projection_redacted: projection })]);
      return { payloadsCleared: payloads, projectionRedacted: projection };
    });
  }

  return { recordCapabilityDiscovery, runtimeAvailability, placeLegalHold, releaseLegalHold, activeLegalHolds, retentionPolicy, clearExpiredPayloads, eraseEntity };
}

module.exports = { createGovernanceStore, GovernanceError, SNAPSHOT_TTL_SECONDS, RETENTION_LOCK };
