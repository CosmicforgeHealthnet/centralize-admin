"use strict";

// Durable pipeline state in the dedicated Karryam Admin database.
//
// Stage A (Bridge -> Karryam Admin): one transaction per event applies the
// minimized projection (version-fenced), records gaps and lineage, derives
// the affected HQ metrics into the Stage B outbox and advances the cursor.
// The Bridge ACK happens only after that commit (see bridge-consumer.js).
//
// Stage B (Karryam Admin -> HQ): the outbox is append-only with contiguous
// sequences per (dataset, partition); HQ acknowledgements are monotonic and
// can never pass the committed head. Stage A never waits for Stage B.

const { randomUUID } = require("node:crypto");
const { events: E } = require("../packages");
const D = require("./datasets");

const PARTITION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SOURCE_COVERAGE_MAX_AGE_MS = 2 * 86400000;

function partitionKeyFor(scope) {
  const key = [scope.market, scope.organization, scope.zone, scope.tenant].join(":");
  if (key.length <= 128 && PARTITION.test(key)) return key;
  return "p-" + require("node:crypto").createHash("sha256").update(key).digest("hex").slice(0, 40);
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

function createPipelineStore(pool, { serviceInstanceId, productId = "karryam", now = Date.now } = {}) {
  // ---------------------------------------------------------------- Stage A
  async function ensurePartitions(scopes, consumer) {
    const keys = [];
    for (const s of scopes) {
      const key = partitionKeyFor(s);
      await pool.query(
        `INSERT INTO karryam_admin.bridge_feed_partitions (partition_key, market, organization, zone, tenant, consumer) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (partition_key) DO NOTHING`,
        [key, s.market, s.organization, s.zone, s.tenant, consumer]);
      keys.push(key);
    }
    return keys;
  }

  async function recordContractRevision(rev) {
    await pool.query(`INSERT INTO karryam_admin.bridge_contract_revisions (revision, source_commit, openapi_sha256, matrix_sha256, capability_count) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (revision) DO NOTHING`,
      [rev.revision, rev.sourceCommit, rev.openapiSha256, rev.matrixSha256, rev.capabilityCount]);
  }

  async function partition(key) {
    const { rows } = await pool.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1`, [key]);
    return rows[0] || null;
  }

  async function listPartitions() {
    const { rows } = await pool.query(`SELECT * FROM karryam_admin.bridge_feed_partitions ORDER BY partition_key`);
    return rows;
  }

  // Fenced lease: a new token every acquisition; a stale holder can no longer
  // commit because every write re-checks owner and token under FOR UPDATE.
  async function acquireLease(key, workerId, leaseSeconds) {
    const { rows } = await pool.query(
      `UPDATE karryam_admin.bridge_feed_partitions SET lease_owner = $2, lease_token = lease_token + 1, lease_expires_at = to_timestamp($3::double precision / 1000)
       WHERE partition_key = $1 AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < to_timestamp($4::double precision / 1000) OR lease_owner = $2)
       RETURNING *`, [key, workerId, now() + leaseSeconds * 1000, now()]);
    return rows[0] || null;
  }

  async function releaseLease(key, workerId, token) {
    await pool.query(`UPDATE karryam_admin.bridge_feed_partitions SET lease_owner = NULL, lease_expires_at = NULL WHERE partition_key = $1 AND lease_owner = $2 AND lease_token = $3`, [key, workerId, token]);
  }

  async function lockOwned(client, key, workerId, token) {
    const { rows } = await client.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1 FOR UPDATE`, [key]);
    const p = rows[0];
    if (!p || p.lease_owner !== workerId || String(p.lease_token) !== String(token) || !p.lease_expires_at || p.lease_expires_at.getTime() < now()) return null;
    return p;
  }

  async function quarantine(client, key, { eventId, sequence, eventType, reason, digest }) {
    await client.query(
      // Re-detection of an already resolved event reopens the record.
      `INSERT INTO karryam_admin.event_quarantine (partition_key, event_id, sequence, event_type, reason, raw_digest) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (partition_key, raw_digest, reason) DO UPDATE SET resolved_at = NULL, resolution = NULL, resolved_by = NULL, detected_at = now()
       WHERE karryam_admin.event_quarantine.resolved_at IS NOT NULL`,
      [key, typeof eventId === "string" ? eventId.slice(0, 64) : null, Number.isSafeInteger(sequence) ? sequence : null, typeof eventType === "string" ? eventType.slice(0, 128) : null, CODE.test(reason) ? reason : "EVENT_REJECTED", digest]);
  }

  async function hold(client, key, sequence, reason) {
    await client.query(`UPDATE karryam_admin.bridge_feed_partitions SET hold_sequence = $2, hold_reason = $3, hold_detected_at = now(), last_error_code = $3 WHERE partition_key = $1 AND hold_sequence IS NULL`,
      [key, Number.isSafeInteger(sequence) ? sequence : null, reason]);
  }

  // Records a verification failure. FEED delivery holds the cursor at the
  // event: it is never applied, never skipped and never ACKed past.
  async function rejectEvent(key, workerId, token, { event, reason, digest, delivery }) {
    return tx(pool, async (client) => {
      const p = await lockOwned(client, key, workerId, token);
      if (!p) return "LEASE_LOST";
      const sequence = event && Number.isSafeInteger(event.sequence) ? event.sequence : null;
      await quarantine(client, key, { eventId: event && event.event_id, sequence, eventType: event && event.event_type, reason, digest });
      if (delivery === "FEED") await hold(client, key, sequence, reason);
      await deriveSyncHealth(client, p);
      return delivery === "FEED" ? "QUARANTINED_HELD" : "QUARANTINED";
    });
  }

  async function coverageComplete(client, p, source) {
    if (!p.started_from_zero || p.hold_sequence !== null) return false;
    const { rows: [r] } = await client.query(
      `SELECT
         (SELECT count(*) FROM karryam_admin.entity_version_gaps WHERE partition_key = $1 AND source_service = $2 AND entity_type = $3 AND repaired_at IS NULL)::int AS gaps,
         (SELECT count(*) FROM karryam_admin.event_quarantine WHERE partition_key = $1 AND resolved_at IS NULL)::int AS quarantined,
         (SELECT row_to_json(c) FROM karryam_admin.source_coverage c WHERE c.source_service = $2 AND c.entity_type = $3) AS source`,
      [p.partition_key, source.source_service, source.entity_type]);
    const s = r.source;
    return r.gaps === 0 && r.quarantined === 0 && s && s.bridge_coverage === "COMPLETE" && s.bridge_open_gaps === 0 && now() - Date.parse(s.observed_at) <= SOURCE_COVERAGE_MAX_AGE_MS;
  }

  async function projectionRows(client, key, def) {
    if (def.source.entity_type === "campaign_revision") {
      const { rows } = await client.query(
        `SELECT DISTINCT ON (payload->>'campaign_id') payload FROM karryam_admin.entity_projections
         WHERE partition_key = $1 AND source_service = $2 AND entity_type = $3 AND NOT tombstone
         ORDER BY payload->>'campaign_id', (payload->>'revision')::bigint DESC, entity_version DESC`, [key, def.source.source_service, def.source.entity_type]);
      return rows.map((r) => r.payload);
    }
    const { rows } = await client.query(
      `SELECT payload->>'status' AS status, payload->>'priority' AS priority, count(*)::int AS n FROM karryam_admin.entity_projections
       WHERE partition_key = $1 AND source_service = $2 AND entity_type = $3 AND NOT tombstone GROUP BY 1, 2`, [key, def.source.source_service, def.source.entity_type]);
    return rows.map((r) => ({ status: r.status, priority: r.priority, _n: r.n }));
  }

  // Upserts a metric snapshot and appends a derived HQ event, only when the
  // observation changed. Same transaction as the projection change.
  async function publishObservation(client, p, datasetId, obs, sourceEventId) {
    const { rows: [prev] } = await client.query(`SELECT * FROM karryam_admin.metric_snapshots WHERE metric_id = $1 AND partition_key = $2 AND window_start = $3 FOR UPDATE`, [obs.metric_id, p.partition_key, obs.window_start]);
    const sameValue = prev && (prev.value === null ? obs.value === null : obs.value !== null && Number(prev.value) === obs.value);
    if (prev && sameValue && prev.value_state === obs.value_state && prev.coverage === obs.coverage) return null;
    const version = prev ? Number(prev.entity_version) + 1 : 1;
    await client.query(
      `INSERT INTO karryam_admin.metric_snapshots (metric_id, partition_key, window_start, window_end, value, value_state, coverage, observed_at, entity_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (metric_id, partition_key, window_start) DO UPDATE SET value = EXCLUDED.value, value_state = EXCLUDED.value_state, coverage = EXCLUDED.coverage, observed_at = EXCLUDED.observed_at, entity_version = EXCLUDED.entity_version, updated_at = now()`,
      [obs.metric_id, p.partition_key, obs.window_start, obs.window_end, obs.value, obs.value_state, obs.coverage, obs.observed_at, version]);
    await client.query(`INSERT INTO karryam_admin.hq_outbox_heads (dataset_id, partition_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [datasetId, p.partition_key]);
    const { rows: [head] } = await client.query(`SELECT head_sequence FROM karryam_admin.hq_outbox_heads WHERE dataset_id = $1 AND partition_key = $2 FOR UPDATE`, [datasetId, p.partition_key]);
    const sequence = Number(head.head_sequence) + 1;
    await client.query(`UPDATE karryam_admin.hq_outbox_heads SET head_sequence = $3 WHERE dataset_id = $1 AND partition_key = $2`, [datasetId, p.partition_key, sequence]);
    const emitted = new Date(now()).toISOString();
    const event = E.createEvent({
      schema_id: "cosmicforge.metric-observation", schema_version: "1.0.0", family: D.familyId(datasetId),
      event_id: randomUUID(), source_id: serviceInstanceId, product_id: productId, dataset_id: datasetId,
      partition_key: p.partition_key, sequence,
      entity: { type: "metric_observation", id: obs.metric_id + ":" + obs.window_start.slice(0, 10), version },
      scope: { market: p.market, organization: p.organization, zone: p.zone, tenant: p.tenant },
      classification: "INTERNAL", occurred_at: obs.observed_at || emitted, emitted_at: emitted, payload: obs,
    });
    await client.query(`INSERT INTO karryam_admin.hq_outbox (dataset_id, partition_key, sequence, event_id, family, event, payload_digest, source_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [datasetId, p.partition_key, sequence, event.event_id, event.family, JSON.stringify(event), event.payload_digest, sourceEventId || null]);
    return event;
  }

  async function deriveForSource(client, p, def, sourceEvent) {
    const complete = await coverageComplete(client, p, def.source);
    const rows = await projectionRows(client, p.partition_key, def);
    const observedAt = new Date(now()).toISOString();
    const published = [];
    for (const obs of D.deriveFromProjections(def, rows, { complete, observedAt })) {
      const ev = await publishObservation(client, p, def.dataset_id, obs, sourceEvent && sourceEvent.event_id);
      if (ev) {
        published.push(ev);
        if (sourceEvent) {
          await client.query(`INSERT INTO karryam_admin.projection_lineage (source_event_id, partition_key, source_sequence, entity_type, entity_ref, entity_version, derived_event_id, metric_id, operation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DERIVE_METRIC')`,
            [sourceEvent.event_id, p.partition_key, sourceEvent.sequence || null, sourceEvent.entity_type, sourceEvent.entity_ref, sourceEvent.entity_version, ev.event_id, obs.metric_id]);
        }
      }
    }
    return published;
  }

  async function deriveSyncHealth(client, p) {
    const def = D.BY_DATASET.get("karryam.sync_health");
    const { rows: [r] } = await client.query(
      `SELECT (SELECT count(*) FROM karryam_admin.entity_version_gaps WHERE partition_key = $1 AND repaired_at IS NULL)::int AS gaps,
              (SELECT count(*) FROM karryam_admin.event_quarantine WHERE partition_key = $1 AND resolved_at IS NULL)::int AS quarantined`, [p.partition_key]);
    const observedAt = new Date(now()).toISOString();
    const lag = p.head_sequence === null ? null : Math.max(0, Number(p.head_sequence) - Number(p.last_sequence));
    const values = { lag, gaps: r.gaps, quarantine: r.quarantined };
    const out = [];
    for (const m of def.metrics) {
      const value = values[m.pipeline];
      const obs = D.observation(m.metric_id, value === null || value === undefined ? null : value, value === null ? "UNKNOWN" : "COMPLETE", observedAt);
      const ev = await publishObservation(client, p, def.dataset_id, obs, null);
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * Applies one verified Bridge event. delivery FEED advances the cursor;
   * REWIND re-reads already-passed sequences to catch late-visible rows and
   * never moves the cursor. Returns the outcome string.
   */
  async function applyEvent(key, workerId, token, event, verified, { delivery = "FEED", contractRevision }) {
    return tx(pool, async (client) => {
      const p = await lockOwned(client, key, workerId, token);
      if (!p) return "LEASE_LOST";
      if (p.hold_sequence !== null) return "HELD";
      const last = Number(p.last_sequence);
      const { rows: [existing] } = await client.query(`SELECT event_digest, partition_key, sequence FROM karryam_admin.bridge_event_inbox WHERE event_id = $1`, [event.event_id]);
      if (existing) {
        if (existing.event_digest === verified.digest && existing.partition_key === key) return "DUPLICATE";
        // Same event ID, different content: an integrity incident, never a duplicate.
        await quarantine(client, key, { eventId: event.event_id, sequence: event.sequence, eventType: event.event_type, reason: "EVENT_ID_DIGEST_CONFLICT", digest: verified.digest });
        if (delivery === "FEED") await hold(client, key, event.sequence, "EVENT_ID_DIGEST_CONFLICT");
        await deriveSyncHealth(client, { ...p, hold_sequence: delivery === "FEED" ? event.sequence : p.hold_sequence });
        return delivery === "FEED" ? "QUARANTINED_HELD" : "QUARANTINED";
      }
      if (delivery === "FEED" && event.sequence <= last) {
        await quarantine(client, key, { eventId: event.event_id, sequence: event.sequence, eventType: event.event_type, reason: "SEQUENCE_REGRESSION", digest: verified.digest });
        await hold(client, key, event.sequence, "SEQUENCE_REGRESSION");
        return "QUARANTINED_HELD";
      }
      if (delivery === "REWIND" && event.sequence > last) return "BEYOND_CURSOR";
      const { rows: [seqTaken] } = await client.query(`SELECT event_id FROM karryam_admin.bridge_event_inbox WHERE partition_key = $1 AND sequence = $2`, [key, event.sequence]);
      if (seqTaken) {
        await quarantine(client, key, { eventId: event.event_id, sequence: event.sequence, eventType: event.event_type, reason: "SEQUENCE_REUSED", digest: verified.digest });
        if (delivery === "FEED") await hold(client, key, event.sequence, "SEQUENCE_REUSED");
        return delivery === "FEED" ? "QUARANTINED_HELD" : "QUARANTINED";
      }

      const ident = [event.source_service, event.entity_type, event.entity_ref];
      const { rows: [current] } = await client.query(`SELECT entity_version FROM karryam_admin.entity_projections WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3 FOR UPDATE`, ident);
      const currentVersion = current ? Number(current.entity_version) : null;
      let outcome = "APPLIED";
      if (currentVersion !== null && event.entity_version <= currentVersion) outcome = "STALE";
      else if (currentVersion !== null && event.entity_version > currentVersion + 1) outcome = "GAP_APPLIED";
      if (delivery === "REWIND") outcome = outcome === "STALE" ? "LATE_STALE" : "LATE_APPLIED";
      const scope = { market: event.market, organization: event.scope.organization, zone: event.scope.zone, tenant: event.scope.tenant };
      await client.query(
        `INSERT INTO karryam_admin.bridge_event_inbox (partition_key, event_id, sequence, event_type, source_service, entity_type, entity_ref, entity_version, tombstone, classification, scope, payload, event_digest, outcome, delivery, occurred_at, emitted_at, contract_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [key, event.event_id, event.sequence, event.event_type, ...ident, event.entity_version, event.tombstone, event.classification, JSON.stringify(scope), JSON.stringify(verified.payload), verified.digest, outcome, delivery, event.occurred_at, event.emitted_at, contractRevision]);
      let published = [];
      if (outcome !== "STALE" && outcome !== "LATE_STALE") {
        if (currentVersion !== null && event.entity_version > currentVersion + 1) {
          await client.query(`INSERT INTO karryam_admin.entity_version_gaps (partition_key, source_service, entity_type, entity_ref, previous_version, received_version) VALUES ($1,$2,$3,$4,$5,$6)`,
            [key, ...ident, currentVersion, event.entity_version]);
        }
        await client.query(
          `INSERT INTO karryam_admin.entity_projections (source_service, entity_type, entity_ref, partition_key, entity_version, tombstone, classification, scope, payload, occurred_at, source_event_id, coverage)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'INCREMENTAL')
           ON CONFLICT (source_service, entity_type, entity_ref) DO UPDATE SET partition_key = EXCLUDED.partition_key, entity_version = EXCLUDED.entity_version, tombstone = EXCLUDED.tombstone,
             classification = EXCLUDED.classification, scope = EXCLUDED.scope, payload = EXCLUDED.payload, occurred_at = EXCLUDED.occurred_at, source_event_id = EXCLUDED.source_event_id, coverage = 'INCREMENTAL'`,
          [...ident, key, event.entity_version, event.tombstone, event.classification, JSON.stringify(scope), JSON.stringify(event.tombstone ? {} : verified.payload), event.occurred_at, event.event_id]);
        await client.query(`INSERT INTO karryam_admin.projection_lineage (source_event_id, partition_key, source_sequence, entity_type, entity_ref, entity_version, operation) VALUES ($1,$2,$3,$4,$5,$6,'APPLY_EVENT')`,
          [event.event_id, key, event.sequence, event.entity_type, event.entity_ref, event.entity_version]);
      }
      if (delivery === "FEED") {
        await client.query(`UPDATE karryam_admin.bridge_feed_partitions SET last_sequence = $2, last_success_at = now(), contract_revision = $3, last_error_code = NULL WHERE partition_key = $1`, [key, event.sequence, contractRevision]);
      }
      if (outcome !== "STALE" && outcome !== "LATE_STALE") {
        const def = D.BY_SOURCE.get(event.source_service + "|" + event.entity_type);
        if (def) published = await deriveForSource(client, { ...p, last_sequence: delivery === "FEED" ? event.sequence : last }, def, event);
      }
      return outcome;
    });
  }

  // Version-fenced repair from an authorized source snapshot (e.g. the HQ
  // support queue). Never overwrites a newer local version.
  async function applySnapshotRecord(key, workerId, token, record, runId) {
    return tx(pool, async (client) => {
      const p = await lockOwned(client, key, workerId, token);
      if (!p) return "LEASE_LOST";
      const ident = [record.source_service, record.entity_type, record.entity_ref];
      const { rows: [current] } = await client.query(`SELECT entity_version FROM karryam_admin.entity_projections WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3 FOR UPDATE`, ident);
      const currentVersion = current ? Number(current.entity_version) : null;
      if (currentVersion !== null && record.entity_version <= currentVersion) {
        await client.query(`UPDATE karryam_admin.entity_version_gaps SET repaired_at = now(), repaired_by_run = $5 WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3 AND repaired_at IS NULL AND received_version <= $4`, [...ident, currentVersion, runId]);
        return "STALE";
      }
      await client.query(
        `INSERT INTO karryam_admin.entity_projections (source_service, entity_type, entity_ref, partition_key, entity_version, tombstone, classification, scope, payload, occurred_at, source_event_id, coverage)
         VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,'BACKFILLED')
         ON CONFLICT (source_service, entity_type, entity_ref) DO UPDATE SET entity_version = EXCLUDED.entity_version, tombstone = false, classification = EXCLUDED.classification,
           scope = EXCLUDED.scope, payload = EXCLUDED.payload, occurred_at = EXCLUDED.occurred_at, source_event_id = EXCLUDED.source_event_id, coverage = 'BACKFILLED'`,
        [...ident, key, record.entity_version, record.classification, JSON.stringify(record.scope), JSON.stringify(record.payload), record.observed_at, record.synthetic_event_id]);
      await client.query(`UPDATE karryam_admin.entity_version_gaps SET repaired_at = now(), repaired_by_run = $5 WHERE source_service = $1 AND entity_type = $2 AND entity_ref = $3 AND repaired_at IS NULL AND received_version <= $4`, [...ident, record.entity_version, runId]);
      await client.query(`INSERT INTO karryam_admin.projection_lineage (source_event_id, partition_key, entity_type, entity_ref, entity_version, operation) VALUES ($1,$2,$3,$4,$5,'BACKFILL_SNAPSHOT')`,
        [record.synthetic_event_id, key, record.entity_type, record.entity_ref, record.entity_version]);
      const def = D.BY_SOURCE.get(record.source_service + "|" + record.entity_type);
      if (def) await deriveForSource(client, p, def, null);
      return "BACKFILLED";
    });
  }

  async function setHead(key, workerId, token, head) {
    await pool.query(`UPDATE karryam_admin.bridge_feed_partitions SET head_sequence = $4 WHERE partition_key = $1 AND lease_owner = $2 AND lease_token = $3`, [key, workerId, token, head]);
  }

  // ACK bookkeeping after the Bridge accepted the acknowledgement.
  async function recordAck(key, workerId, token, sequence) {
    const { rowCount } = await pool.query(
      `UPDATE karryam_admin.bridge_feed_partitions SET acked_sequence = $4, last_ack_at = now() WHERE partition_key = $1 AND lease_owner = $2 AND lease_token = $3 AND $4 <= last_sequence AND $4 >= acked_sequence`,
      [key, workerId, token, sequence]);
    return rowCount === 1;
  }

  async function recordError(key, code) {
    await pool.query(`UPDATE karryam_admin.bridge_feed_partitions SET last_error_code = $2 WHERE partition_key = $1`, [key, CODE.test(code) ? code : "FEED_ERROR"]);
  }

  async function publishSyncHealth(key) {
    return tx(pool, async (client) => {
      const { rows: [p] } = await client.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1 FOR UPDATE`, [key]);
      if (!p) return [];
      return deriveSyncHealth(client, p);
    });
  }

  // Re-derives projection-backed metrics (after coverage changes).
  async function rederive(key) {
    return tx(pool, async (client) => {
      const { rows: [p] } = await client.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1 FOR UPDATE`, [key]);
      if (!p) return [];
      const out = [];
      for (const def of D.DEFINITIONS.filter((d) => d.source)) out.push(...await deriveForSource(client, p, def, null));
      out.push(...await deriveSyncHealth(client, p));
      return out;
    });
  }

  async function recordSourceCoverage(sources, observedAt) {
    for (const s of sources) {
      await pool.query(
        `INSERT INTO karryam_admin.source_coverage (source_service, entity_type, bridge_coverage, bridge_open_gaps, bridge_backfill, bridge_freshness, observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (source_service, entity_type) DO UPDATE SET bridge_coverage = EXCLUDED.bridge_coverage, bridge_open_gaps = EXCLUDED.bridge_open_gaps, bridge_backfill = EXCLUDED.bridge_backfill, bridge_freshness = EXCLUDED.bridge_freshness, observed_at = EXCLUDED.observed_at`,
        [s.source_service, s.entity_type, s.coverage, s.open_gaps, s.last_backfill_status, s.freshness, observedAt]);
    }
  }

  // Operator recovery of a held partition: the held event is resolved with an
  // explicit, audited reason. Releasing does NOT skip the event: the next
  // feed read starts after the committed cursor and re-reads it.
  async function releaseHold(key, { operator, resolution }) {
    if (!CODE.test(String(resolution))) throw new Error("RESOLUTION_CODE_REQUIRED");
    return tx(pool, async (client) => {
      const { rows: [p] } = await client.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1 FOR UPDATE`, [key]);
      if (!p || p.hold_sequence === null) return false;
      await client.query(`UPDATE karryam_admin.event_quarantine SET resolved_at = now(), resolution = $2, resolved_by = $3 WHERE partition_key = $1 AND resolved_at IS NULL`, [key, resolution, operator]);
      await client.query(`UPDATE karryam_admin.bridge_feed_partitions SET hold_sequence = NULL, hold_reason = NULL, hold_detected_at = NULL WHERE partition_key = $1`, [key]);
      return true;
    });
  }

  async function startRun(fields) {
    const id = randomUUID();
    await pool.query(`INSERT INTO karryam_admin.sync_runs (id, stage, trigger_kind, partition_key, worker_id, fencing_token, contract_revision, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'RUNNING')`,
      [id, fields.stage, fields.trigger || "SCHEDULED", fields.partitionKey || null, fields.workerId, fields.token === undefined ? null : fields.token, fields.contractRevision || null]);
    return id;
  }

  async function finishRun(id, { status, counts = {}, details = {}, errorCode = null }) {
    await pool.query(`UPDATE karryam_admin.sync_runs SET finished_at = now(), status = $2, counts = $3, details = $4, error_code = $5 WHERE id = $1`,
      [id, status, JSON.stringify(counts), JSON.stringify(details), errorCode && CODE.test(errorCode) ? errorCode : errorCode ? "RUN_FAILED" : null]);
  }

  async function clearExpiredPayloads(retentionDays) {
    const { rowCount } = await pool.query(`UPDATE karryam_admin.bridge_event_inbox SET payload = NULL, payload_cleared_at = now() WHERE payload IS NOT NULL AND received_at < now() - make_interval(days => $1)`, [retentionDays]);
    return rowCount;
  }

  // ---------------------------------------------------------------- Stage B
  async function outboxPartitions() {
    const { rows } = await pool.query(`SELECT dataset_id, partition_key, head_sequence FROM karryam_admin.hq_outbox_heads ORDER BY dataset_id, partition_key`);
    return rows.map((r) => ({ dataset_id: r.dataset_id, partition_key: r.partition_key, head_sequence: Number(r.head_sequence) }));
  }

  async function outboxEvents(datasetId, partitionKey, afterSequence, limit) {
    const { rows } = await pool.query(`SELECT event FROM karryam_admin.hq_outbox WHERE dataset_id = $1 AND partition_key = $2 AND sequence > $3 ORDER BY sequence LIMIT $4`, [datasetId, partitionKey, afterSequence, limit]);
    const { rows: [head] } = await pool.query(`SELECT head_sequence FROM karryam_admin.hq_outbox_heads WHERE dataset_id = $1 AND partition_key = $2`, [datasetId, partitionKey]);
    return { events: rows.map((r) => r.event), headSequence: head ? Number(head.head_sequence) : 0 };
  }

  // Returns ACKED | REGRESSION | BEYOND_HEAD | UNKNOWN_PARTITION.
  async function outboxAck(consumer, datasetId, partitionKey, sequence) {
    return tx(pool, async (client) => {
      const { rows: [head] } = await client.query(`SELECT head_sequence FROM karryam_admin.hq_outbox_heads WHERE dataset_id = $1 AND partition_key = $2 FOR SHARE`, [datasetId, partitionKey]);
      if (!head) return "UNKNOWN_PARTITION";
      if (sequence > Number(head.head_sequence)) return "BEYOND_HEAD";
      const { rows: [prior] } = await client.query(`SELECT acked_sequence FROM karryam_admin.hq_outbox_acks WHERE consumer = $1 AND dataset_id = $2 AND partition_key = $3 FOR UPDATE`, [consumer, datasetId, partitionKey]);
      if (prior && sequence < Number(prior.acked_sequence)) return "REGRESSION";
      await client.query(`INSERT INTO karryam_admin.hq_outbox_acks (consumer, dataset_id, partition_key, acked_sequence) VALUES ($1,$2,$3,$4)
                          ON CONFLICT (consumer, dataset_id, partition_key) DO UPDATE SET acked_sequence = EXCLUDED.acked_sequence, acked_at = now()`, [consumer, datasetId, partitionKey, sequence]);
      return "ACKED";
    });
  }

  async function outboxAcks() {
    const { rows } = await pool.query(`SELECT consumer, dataset_id, partition_key, acked_sequence, acked_at FROM karryam_admin.hq_outbox_acks ORDER BY consumer, dataset_id, partition_key`);
    return rows.map((r) => ({ ...r, acked_sequence: Number(r.acked_sequence) }));
  }

  // Latest observation per metric for one dataset partition (snapshot).
  async function latestObservations(datasetId, partitionKey) {
    const def = D.BY_DATASET.get(datasetId);
    if (!def) return [];
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (metric_id) * FROM karryam_admin.metric_snapshots WHERE partition_key = $1 AND metric_id = ANY($2) ORDER BY metric_id, window_start DESC`,
      [partitionKey, def.metrics.map((m) => m.metric_id)]);
    return rows;
  }

  // Consistent snapshot: latest observation per metric and the outbox head
  // they cover, read in one REPEATABLE READ transaction.
  async function snapshot(datasetId, partitionKey) {
    const def = D.BY_DATASET.get(datasetId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { rows: [head] } = await client.query(`SELECT head_sequence FROM karryam_admin.hq_outbox_heads WHERE dataset_id = $1 AND partition_key = $2`, [datasetId, partitionKey]);
      const { rows } = await client.query(
        `SELECT DISTINCT ON (metric_id) * FROM karryam_admin.metric_snapshots WHERE partition_key = $1 AND metric_id = ANY($2) ORDER BY metric_id, window_start DESC`,
        [partitionKey, def ? def.metrics.map((m) => m.metric_id) : []]);
      const { rows: [p] } = await client.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1`, [partitionKey]);
      let complete = Boolean(p);
      if (p && def && def.source) complete = await coverageComplete(client, p, def.source);
      if (p && def && !def.source) complete = p.hold_sequence === null;
      await client.query("COMMIT");
      return { partition: p || null, headSequence: head ? Number(head.head_sequence) : 0, rows, complete: complete && rows.length > 0 && rows.every((r) => r.coverage === "COMPLETE" || r.coverage === "UNKNOWN") };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- reports
  async function pipelineSummary() {
    const { rows: partitions } = await pool.query(
      `SELECT p.*,
         (SELECT count(*) FROM karryam_admin.entity_version_gaps g WHERE g.partition_key = p.partition_key AND g.repaired_at IS NULL)::int AS open_gaps,
         (SELECT count(*) FROM karryam_admin.event_quarantine q WHERE q.partition_key = p.partition_key AND q.resolved_at IS NULL)::int AS open_quarantine
       FROM karryam_admin.bridge_feed_partitions p ORDER BY p.partition_key`);
    const { rows: quarantine } = await pool.query(`SELECT partition_key, reason, count(*)::int AS n, max(detected_at) AS last_detected_at FROM karryam_admin.event_quarantine WHERE resolved_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2`);
    const { rows: runs } = await pool.query(`SELECT DISTINCT ON (stage, partition_key) id, stage, partition_key, status, started_at, finished_at, counts, error_code FROM karryam_admin.sync_runs ORDER BY stage, partition_key, started_at DESC`);
    const { rows: coverage } = await pool.query(`SELECT * FROM karryam_admin.source_coverage ORDER BY source_service, entity_type`);
    return { partitions, quarantine, runs, coverage };
  }

  async function projectionGroups(partitionKeys, sourceService, entityType, fields) {
    if (!fields.length || fields.some((f) => !/^[a-z][a-z0-9_]{0,63}$/.test(f))) throw new Error("FIELD_NAME_INVALID");
    const cols = fields.map((f) => `payload->>'${f}' AS ${f}`).join(", ");
    const group = fields.map((_, i) => String(i + 2)).join(", ");
    const { rows } = await pool.query(
      `SELECT partition_key, ${cols}, count(*)::int AS n, max(updated_at) AS last_updated FROM karryam_admin.entity_projections
       WHERE partition_key = ANY($1) AND source_service = $2 AND entity_type = $3 AND NOT tombstone GROUP BY 1, ${group} ORDER BY 1, ${group}`,
      [partitionKeys, sourceService, entityType]);
    return rows;
  }

  async function campaignLatest(partitionKeys) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (partition_key, payload->>'campaign_id') partition_key, payload, updated_at FROM karryam_admin.entity_projections
       WHERE partition_key = ANY($1) AND source_service = 'notification-service' AND entity_type = 'campaign_revision' AND NOT tombstone
       ORDER BY partition_key, payload->>'campaign_id', (payload->>'revision')::bigint DESC, entity_version DESC LIMIT 500`, [partitionKeys]);
    return rows;
  }

  async function coverageFor(partitionKey, source) {
    const client = await pool.connect();
    try {
      const { rows: [p] } = await client.query(`SELECT * FROM karryam_admin.bridge_feed_partitions WHERE partition_key = $1`, [partitionKey]);
      return p ? coverageComplete(client, p, source) : false;
    } finally { client.release(); }
  }

  return {
    ensurePartitions, recordContractRevision, partition, listPartitions, acquireLease, releaseLease, rejectEvent, applyEvent, applySnapshotRecord,
    setHead, recordAck, recordError, publishSyncHealth, rederive, recordSourceCoverage, releaseHold, startRun, finishRun, clearExpiredPayloads,
    outboxPartitions, outboxEvents, outboxAck, outboxAcks, latestObservations, snapshot, pipelineSummary, projectionGroups, campaignLatest, coverageFor,
  };
}

module.exports = { createPipelineStore, partitionKeyFor };
