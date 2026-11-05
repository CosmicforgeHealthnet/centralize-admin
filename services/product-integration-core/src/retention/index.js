"use strict";

// HQ data lifecycle (Section 9.4.8), product-neutral:
//  - each approved dataset declares retention_days; after that the
//    minimized inbox payload is cleared while event identity, digests,
//    sequence and lineage stay;
//  - legal holds (two-person, released once) override retention and are
//    enforced again by the inbox guard trigger;
//  - retention runs and hold placement serialize on one advisory lock, so a
//    hold placed during a run is never skipped.

const { randomUUID } = require("node:crypto");
const { T } = require("../db");

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const STAFF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const DATASET = /^[a-z][a-z0-9_.-]{1,95}$/;
const LOCK = 7340117009;

class RetentionError extends Error {
  constructor(reason) { super(reason); this.name = "RetentionError"; this.reason = reason; }
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

function createRetention(pool) {
  async function placeLegalHold({ productAdminId, datasetId = null, entityType = null, entityId = null, reasonCode, caseReference, placedBy, approvedBy }) {
    if (!CODE.test(String(reasonCode)) || !REF.test(String(caseReference))) throw new RetentionError("HOLD_REASON_INVALID");
    if (!STAFF.test(String(placedBy)) || !STAFF.test(String(approvedBy))) throw new RetentionError("HOLD_ACTOR_INVALID");
    if (placedBy === approvedBy) throw new RetentionError("HOLD_REQUIRES_INDEPENDENT_APPROVER");
    if (datasetId !== null && !DATASET.test(String(datasetId))) throw new RetentionError("HOLD_TARGET_INVALID");
    if ((entityType === null) !== (entityId === null) || (entityType !== null && (!REF.test(String(entityType)) || !REF.test(String(entityId))))) throw new RetentionError("HOLD_TARGET_INVALID");
    const id = randomUUID();
    await tx(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
      await client.query(`INSERT INTO ${T}hq_product_admin_legal_holds (id, product_admin_id, dataset_id, entity_type, entity_id, reason_code, case_reference, placed_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, productAdminId, datasetId, entityType, entityId, reasonCode, caseReference, placedBy, approvedBy]);
    });
    return id;
  }

  async function releaseLegalHold({ id, releasedBy, releaseReason }) {
    if (!STAFF.test(String(releasedBy)) || !CODE.test(String(releaseReason))) throw new RetentionError("HOLD_RELEASE_INVALID");
    const { rowCount } = await pool.query(`UPDATE ${T}hq_product_admin_legal_holds SET released_at = now(), released_by = $2, release_reason = $3 WHERE id = $1 AND released_at IS NULL`, [id, releasedBy, releaseReason]);
    if (rowCount !== 1) throw new RetentionError("HOLD_NOT_ACTIVE");
  }

  /** Clears inbox payloads older than their dataset's retention; held rows stay. */
  async function clearExpiredInboxPayloads({ minimumDays = 1 } = {}) {
    return tx(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
      const expired = `FROM ${T}hq_product_admin_subscriptions s JOIN ${T}hq_product_admin_datasets d ON d.id = s.dataset_row_id
        WHERE i.subscription_id = s.id AND i.payload IS NOT NULL AND i.received_at < now() - make_interval(days => GREATEST(d.retention_days, $1::int))`;
      const { rows: [held] } = await client.query(`SELECT count(*)::int AS n FROM ${T}hq_product_admin_event_inbox i, ${T}hq_product_admin_subscriptions s JOIN ${T}hq_product_admin_datasets d ON d.id = s.dataset_row_id
        WHERE i.subscription_id = s.id AND i.payload IS NOT NULL AND i.received_at < now() - make_interval(days => GREATEST(d.retention_days, $1::int))
          AND hq_integration.under_legal_hold(i.product_admin_id, i.dataset_id, i.entity_type, i.entity_id)`, [minimumDays]);
      const { rowCount } = await client.query(`UPDATE ${T}hq_product_admin_event_inbox i SET payload = NULL, payload_cleared_at = now(), payload_cleared_reason = 'RETENTION'
        ${expired} AND NOT hq_integration.under_legal_hold(i.product_admin_id, i.dataset_id, i.entity_type, i.entity_id)`, [minimumDays]);
      return { cleared: rowCount, retainedUnderHold: held.n };
    });
  }

  return { placeLegalHold, releaseLegalHold, clearExpiredInboxPayloads };
}

module.exports = { createRetention, RetentionError };
