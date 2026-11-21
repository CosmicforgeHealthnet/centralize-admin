"use strict";

// Generic HQ <- Product Admin synchronization engine.
//
// At-least-once delivery with exactly-once application:
//   - only ENABLED products with ACTIVE contracts and APPROVED, enabled
//     subscriptions are scheduled;
//   - each partition is processed under a fenced lease;
//   - the destination always comes from the trusted registry endpoint;
//   - every event is verified (identity, schema, digest, scope, sequence)
//     and applied in one transaction together with lineage and the cursor;
//   - ACK is sent only after commit and retried without re-applying;
//   - gaps stop the cursor and are reconciled from approved snapshots;
//   - revocation stops consumption at the next event boundary.
// There is no product-specific branch anywhere in this file.

const { randomUUID } = require("node:crypto");
const C = require("../../../../packages/admin-contracts");
const E = require("../../../../packages/event-contracts");
const { T } = require("../db");
const { recordAudit } = require("../audit");
const { clientFor } = require("../registry/endpoints");
const { checkObservation, applyObservation } = require("../projections/metrics");
const policy = require("../registry/sync-policy");

const validateEventsPage = C.compile(C.schemas.eventsPage);
const validateSyncStatus = C.compile(C.schemas.syncStatus);
const validateSnapshot = C.compile(C.schemas.snapshot);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function safeCode(value, fallback) {
  return typeof value === "string" && CODE.test(value) ? value : fallback;
}

// Kept for compatibility: identity drift states (see registry/sync-policy).
const IDENTITY_BLOCKING_DRIFT = policy.IDENTITY_DRIFT;

// Validation failures that are policy filters rather than integrity
// failures. The event registry reports these only after identity, schema,
// digest and payload checks have all passed, so the event is authentic and
// understood; it is simply not for this subscription. Every other failure
// holds the partition (see hold()).
const POLICY_FILTERED = Object.freeze(["SCOPE_DENIED"]);

// The run-start gate. Deny by default (registry/sync-policy): only drift
// state NONE may synchronize, so identity drift, BREAKING_DETECTED,
// ADDITIVE_PENDING_REVIEW and any unrecognised state all block. The signer is
// re-checked against the trust store on every run, so a signer revoked or
// expired in configuration stops consumption before the next health check.
function identityBlock(sub, trustStore, nowMs, environment) {
  return policy.syncBlock({ row: sub, contract: { catalog: sub.catalog }, trustStore, environment, nowMs });
}

function createSyncEngine({ pool, endpoints, environment, trustStore, workerId = "pic-worker-" + randomUUID().slice(0, 8), leaseSeconds = 30, now = Date.now, logger = () => {}, clientOptions = {}, hooks = {} }) {
  async function alert(code, context) {
    logger({ service: "product-integration-core", event: "integration_alert", code, ...context });
    await recordAudit(pool, { correlationId: context.correlation_id || null, actorType: "SYSTEM", actorId: workerId, productId: context.product_id || null, productAdminId: context.product_admin_id || null, action: "integration.alert", outcome: "ERROR", reasonCode: code, metadata: { subscription_ref: context.subscription_id || null, partition_key: context.partition_key || null } }).catch(() => {});
  }

  async function loadSubscriptions(productAdminId, { scheduled = false } = {}) {
    const { rows } = await pool.query(
      `SELECT s.*, p.product_id, p.service_instance_id, p.environment, p.endpoint_ref, p.lifecycle_status, p.allowed_scope AS product_scope,
              p.drift_status, p.manifest_expires_at, p.approved_signer_kid,
              d.dataset_id, d.version AS dataset_version, d.schema_digest AS dataset_schema_digest, d.scope_dimensions, d.metrics,
              c.id AS contract_id, c.catalog
       FROM ${T}hq_product_admin_subscriptions s
       JOIN ${T}hq_product_admins p ON p.id = s.product_admin_id
       JOIN ${T}hq_product_admin_datasets d ON d.id = s.dataset_row_id
       JOIN ${T}hq_product_admin_contracts c ON c.id = p.current_contract_id AND c.status = 'ACTIVE'
       WHERE p.lifecycle_status = 'ENABLED' AND p.environment = $1 AND s.enabled AND s.status = 'ACTIVE' AND d.approval_status = 'APPROVED'
         AND ($2::uuid IS NULL OR p.id = $2::uuid)
         -- Scheduled runs honour each subscription's poll interval; operator-triggered runs do not.
         AND (NOT $3::boolean OR NOT EXISTS (SELECT 1 FROM ${T}hq_product_admin_sync_runs r WHERE r.subscription_id = s.id AND r.run_kind = 'EVENTS'
               AND r.started_at > to_timestamp($4::double precision / 1000) - make_interval(secs => s.poll_interval_seconds)))
       ORDER BY p.product_id, s.id`, [environment, productAdminId || null, scheduled, now()]);
    return rows;
  }

  async function quarantine(client, sub, { event, partitionKey, sequence, reason, correlationId }) {
    const eventId = event && typeof event.event_id === "string" && UUID.test(event.event_id) ? event.event_id : null;
    const inserted = await client.query(
      `INSERT INTO ${T}hq_product_admin_quarantine (id, product_admin_id, subscription_id, event_id, partition_key, sequence, reason_code, event_digest, schema_id, schema_version, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [randomUUID(), sub.product_admin_id, sub.id, eventId, partitionKey, Number.isSafeInteger(sequence) ? sequence : null, reason,
        event && typeof event === "object" ? (() => { try { return E.eventDigest(event); } catch { return null; } })() : null,
        event && typeof event.schema_id === "string" ? event.schema_id.slice(0, 96) : null,
        event && typeof event.schema_version === "string" ? event.schema_version.slice(0, 16) : null,
        JSON.stringify({ correlation_id: correlationId, family: event && typeof event.family === "string" ? event.family.slice(0, 96) : null })]);
    // Repeated redelivery of the same rejected event is recorded once.
    await client.query(`UPDATE ${T}hq_product_admin_subscriptions SET quarantined_count = quarantined_count + $2, coverage = 'PARTIAL', updated_at = now() WHERE id = $1`, [sub.id, inserted.rowCount]);
  }

  // The gate again, inside the caller's transaction: a revocation, drift
  // record, trust change or contract activation that committed after the run
  // started is seen here, before any effect is applied or acknowledged.
  function gate(db, sub, lock) {
    return policy.currentBlock(db, { productAdminId: sub.product_admin_id, contractId: sub.contract_id, trustStore, environment, nowMs: now(), lock });
  }

  // An event at the next sequence that cannot be verified or applied is
  // quarantined and the partition is held at that sequence: the cursor does
  // not move past it, nothing after it is applied, and it is never ACKed.
  // The hold is recorded like a gap (gap_from = gap_to = sequence) so that it
  // is visible and recovered only by reconciliation from an approved,
  // complete snapshot that covers it.
  async function hold(client, sub, { event, partitionKey, sequence, reason, correlationId }) {
    await quarantine(client, sub, { event, partitionKey, sequence, reason, correlationId });
    await client.query(`UPDATE ${T}hq_product_admin_sync_cursors SET gap_from = $3, gap_to = $3, gap_detected_at = now(), hold_reason = $4 WHERE subscription_id = $1 AND partition_key = $2`, [sub.id, partitionKey, sequence, safeCode(reason, "EVENT_REJECTED")]);
    await client.query(`UPDATE ${T}hq_product_admin_subscriptions SET gap_status = 'GAP_DETECTED', coverage = 'PARTIAL', updated_at = now() WHERE id = $1`, [sub.id]);
    await client.query("COMMIT");
    return "QUARANTINED_HELD";
  }

  // Processes one event in its own transaction. Returns an outcome string.
  async function processEvent(sub, registry, datasetDef, partitionKey, token, event, correlationId) {
    const validation = registry.validate(event, { allowedScope: sub.allowed_scope, datasetId: sub.dataset_id, partitionKey, now: now() });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const blocked = await gate(client, sub, true);
      if (blocked) { await client.query("ROLLBACK"); return blocked === "PRODUCT_NOT_ENABLED" ? "ABORTED_REVOKED" : "BLOCKED_SYNC_GATE"; }
      const s = await client.query(`SELECT enabled, status FROM ${T}hq_product_admin_subscriptions WHERE id = $1 FOR SHARE`, [sub.id]);
      if (!s.rows[0].enabled || s.rows[0].status !== "ACTIVE") { await client.query("ROLLBACK"); return "SKIPPED_POLICY"; }
      const c = await client.query(`SELECT last_sequence, lease_token, lease_owner FROM ${T}hq_product_admin_sync_cursors WHERE subscription_id = $1 AND partition_key = $2 FOR UPDATE`, [sub.id, partitionKey]);
      const cursor = c.rows[0];
      if (!cursor || String(cursor.lease_token) !== String(token) || cursor.lease_owner !== workerId) { await client.query("ROLLBACK"); return "LEASE_LOST"; }
      const last = Number(cursor.last_sequence);
      const sequence = event && Number.isSafeInteger(event.sequence) && event.sequence >= 1 ? event.sequence : null;
      if (sequence === null) {
        await quarantine(client, sub, { event, partitionKey, sequence: null, reason: "ENVELOPE_INVALID", correlationId });
        await client.query("COMMIT");
        return "MALFORMED_PAGE";
      }

      const decision = E.sequenceDecision(last, sequence);
      if (decision === "ALREADY_SEEN") {
        const existing = validation.ok || (event && UUID.test(String(event.event_id)))
          ? await client.query(`SELECT event_digest FROM ${T}hq_product_admin_event_inbox WHERE product_admin_id = $1 AND event_id = $2`, [sub.product_admin_id, event.event_id])
          : { rows: [] };
        let digest = null;
        try { digest = E.eventDigest(event); } catch { digest = null; }
        if (existing.rows[0] && existing.rows[0].event_digest === digest) { await client.query("COMMIT"); return "DUPLICATE"; }
        await quarantine(client, sub, { event, partitionKey, sequence, reason: existing.rows[0] ? "DIGEST_CONFLICT" : "SEQUENCE_REPLAY_CONFLICT", correlationId });
        await client.query("COMMIT");
        return "QUARANTINED_REPLAY";
      }
      if (decision === "GAP") {
        await client.query(`UPDATE ${T}hq_product_admin_sync_cursors SET gap_from = $3, gap_to = $4, gap_detected_at = now(), hold_reason = 'SEQUENCE_GAP' WHERE subscription_id = $1 AND partition_key = $2`, [sub.id, partitionKey, last + 1, sequence - 1]);
        await client.query(`UPDATE ${T}hq_product_admin_subscriptions SET gap_status = 'GAP_DETECTED', coverage = 'PARTIAL', updated_at = now() WHERE id = $1`, [sub.id]);
        await client.query("COMMIT");
        return "GAP";
      }

      // decision === NEXT
      const advance = async () => client.query(`UPDATE ${T}hq_product_admin_sync_cursors SET last_sequence = $3, last_event_id = $4, last_success_at = now() WHERE subscription_id = $1 AND partition_key = $2`,
        [sub.id, partitionKey, sequence, event && UUID.test(String(event.event_id)) ? event.event_id : null]);
      if (!validation.ok) {
        // An authentic, schema-valid event outside the subscription's allowed
        // scope is a policy filter: recorded, never applied, and skipped.
        if (POLICY_FILTERED.includes(validation.reason)) {
          await quarantine(client, sub, { event, partitionKey, sequence, reason: validation.reason, correlationId });
          await advance();
          await client.query("COMMIT");
          return "QUARANTINED_FILTERED";
        }
        // Unknown schema or family, invalid identity, digest, payload or
        // classification: never applied, and the cursor never crosses it.
        return await hold(client, sub, { event, partitionKey, sequence, reason: validation.reason, correlationId });
      }
      const prior = await client.query(`SELECT event_digest FROM ${T}hq_product_admin_event_inbox WHERE product_admin_id = $1 AND event_id = $2`, [sub.product_admin_id, event.event_id]);
      if (prior.rows[0]) {
        return await hold(client, sub, { event, partitionKey, sequence, reason: prior.rows[0].event_digest === validation.eventDigest ? "EVENT_ID_REUSED" : "DIGEST_CONFLICT", correlationId });
      }

      let application = "NO_PROJECTION";
      let metricRowId = null;
      if (validation.family.projection === "METRIC_OBSERVATION") {
        const check = checkObservation(datasetDef, event.payload);
        if (!check.ok) return await hold(client, sub, { event, partitionKey, sequence, reason: check.reason, correlationId });
        const applied = await applyObservation(client, { productAdmin: { id: sub.product_admin_id, product_id: sub.product_id }, subscription: sub, contractId: sub.contract_id, dataset: datasetDef, metric: check.metric, payload: event.payload, scope: event.scope, entityVersion: event.entity.version, sequence, now: now() });
        application = applied.application;
        metricRowId = applied.metricRowId || null;
      }
      const inbox = await client.query(
        `INSERT INTO ${T}hq_product_admin_event_inbox (product_admin_id, subscription_id, contract_id, event_id, event_digest, payload_digest, family, schema_id, schema_version, dataset_id, partition_key, sequence, entity_type, entity_id, entity_version, scope, classification, payload, occurred_at, emitted_at, application, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
        [sub.product_admin_id, sub.id, sub.contract_id, event.event_id, validation.eventDigest, event.payload_digest, event.family, event.schema_id, event.schema_version, event.dataset_id, partitionKey, sequence, event.entity.type, event.entity.id, event.entity.version, JSON.stringify(event.scope), event.classification, JSON.stringify(event.payload), event.occurred_at, event.emitted_at, application, correlationId]);
      if (metricRowId) {
        await client.query(
          `INSERT INTO ${T}hq_product_admin_lineage (product_admin_id, metric_row_id, inbox_id, contract_id, dataset_id, operation, source_sequence, source_entity_version) VALUES ($1,$2,$3,$4,$5,'APPLY_EVENT',$6,$7)`,
          [sub.product_admin_id, metricRowId, inbox.rows[0].id, sub.contract_id, sub.dataset_id, sequence, event.entity.version]);
      }
      await advance();
      const observed = event.payload && typeof event.payload.observed_at === "string" ? event.payload.observed_at : event.occurred_at;
      await client.query(
        `UPDATE ${T}hq_product_admin_subscriptions SET last_success_at = now(), last_source_observation_at = GREATEST(COALESCE(last_source_observation_at, $2::timestamptz), $2::timestamptz),
           coverage = CASE WHEN coverage IN ('UNKNOWN', 'NONE') THEN 'COMPLETE' ELSE coverage END, updated_at = now() WHERE id = $1`, [sub.id, observed]);
      await client.query("COMMIT");
      return application === "STALE_IGNORED" ? "STALE" : "APPLIED";
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ACK only what has been committed, only while the product still passes the
  // gate, and only up to the contiguous committed sequence; retried on the
  // next run if it fails.
  async function ack(client, sub, partitionKey, token, sequence, correlationId) {
    if (hooks.beforeAck) await hooks.beforeAck({ subscriptionId: sub.id, partitionKey, sequence });
    const blocked = await gate(pool, sub, false);
    if (blocked) return blocked === "PRODUCT_NOT_ENABLED" ? "SKIPPED_REVOKED" : "SKIPPED_BLOCKED";
    try {
      const res = await client.ackEvents({ dataset_id: sub.dataset_id, partition_key: partitionKey, sequence }, { correlationId });
      if (res.status !== 200) return "ACK_FAILED";
    } catch {
      return "ACK_FAILED";
    }
    await pool.query(`UPDATE ${T}hq_product_admin_sync_cursors SET acked_sequence = GREATEST(acked_sequence, $4) WHERE subscription_id = $1 AND partition_key = $2 AND lease_token = $3 AND $4 <= last_sequence`, [sub.id, partitionKey, token, sequence]);
    return "ACKED";
  }

  async function finishRun(runId, fields) {
    await pool.query(
      `UPDATE ${T}hq_product_admin_sync_runs SET finished_at = now(), status = $2, events_received = $3, events_applied = $4, events_duplicate = $5, events_stale = $6, events_quarantined = $7, ack_status = $8, acked_sequence = $9, error_code = $10 WHERE id = $1`,
      [runId, fields.status, fields.received || 0, fields.applied || 0, fields.duplicate || 0, fields.stale || 0, fields.quarantined || 0, fields.ackStatus || "NOT_REQUIRED", fields.ackedSequence ?? null, fields.errorCode || null]);
  }

  async function acquireLease(sub, partitionKey) {
    await pool.query(`INSERT INTO ${T}hq_product_admin_sync_cursors (id, subscription_id, partition_key) VALUES ($1,$2,$3) ON CONFLICT (subscription_id, partition_key) DO NOTHING`, [randomUUID(), sub.id, partitionKey]);
    const { rows } = await pool.query(
      `UPDATE ${T}hq_product_admin_sync_cursors SET lease_owner = $3, lease_token = lease_token + 1, lease_expires_at = to_timestamp($4::double precision / 1000)
       WHERE subscription_id = $1 AND partition_key = $2 AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < to_timestamp($5::double precision / 1000) OR lease_owner = $3)
       RETURNING lease_token, last_sequence, acked_sequence, gap_from, gap_to`,
      [sub.id, partitionKey, workerId, now() + leaseSeconds * 1000, now()]);
    return rows[0] || null;
  }

  async function releaseLease(sub, partitionKey, token) {
    await pool.query(`UPDATE ${T}hq_product_admin_sync_cursors SET lease_owner = NULL, lease_expires_at = NULL WHERE subscription_id = $1 AND partition_key = $2 AND lease_token = $3 AND lease_owner = $4`, [sub.id, partitionKey, token, workerId]);
  }

  async function syncPartition(sub, client, registry, datasetDef, partition) {
    const partitionKey = partition.partition_key;
    const correlationId = randomUUID();
    const runId = randomUUID();
    const lease = await acquireLease(sub, partitionKey);
    await pool.query(`INSERT INTO ${T}hq_product_admin_sync_runs (id, product_admin_id, subscription_id, partition_key, run_kind, worker_id, fencing_token, correlation_id, status) VALUES ($1,$2,$3,$4,'EVENTS',$5,$6,$7,'RUNNING')`,
      [runId, sub.product_admin_id, sub.id, partitionKey, workerId, lease ? lease.lease_token : null, correlationId]);
    const ctx = { product_id: sub.product_id, product_admin_id: sub.product_admin_id, subscription_id: sub.id, partition_key: partitionKey, correlation_id: correlationId };
    if (!lease) {
      await finishRun(runId, { status: "LEASE_LOST", errorCode: "LEASE_HELD_BY_OTHER_WORKER" });
      return { partitionKey, status: "LEASE_LOST" };
    }
    const token = lease.lease_token;
    const stats = { received: 0, applied: 0, duplicate: 0, stale: 0, quarantined: 0 };
    let last = Number(lease.last_sequence);
    let acked = Number(lease.acked_sequence);
    await pool.query(`UPDATE ${T}hq_product_admin_sync_cursors SET head_sequence = $3 WHERE subscription_id = $1 AND partition_key = $2`, [sub.id, partitionKey, partition.head_sequence]);
    if (lease.gap_from !== null) {
      await finishRun(runId, { status: "PARTIAL_GAP", errorCode: "GAP_PENDING_RECONCILIATION" });
      await releaseLease(sub, partitionKey, token);
      return { partitionKey, status: "PARTIAL_GAP" };
    }

    // 1. Retry a pending ACK first (no re-application: the events are committed).
    if (acked < last) {
      const outcome = await ack(client, sub, partitionKey, token, last, correlationId);
      if (outcome !== "ACKED") {
        if (outcome === "ACK_FAILED") await alert("ACK_FAILED", ctx);
        const reason = outcome === "SKIPPED_BLOCKED" ? await gate(pool, sub, false) : null;
        if (reason) await alert(safeCode(reason, "SYNC_BLOCKED"), ctx);
        await finishRun(runId, { status: outcome === "SKIPPED_REVOKED" ? "ABORTED_REVOKED" : outcome === "SKIPPED_BLOCKED" ? "BLOCKED" : "FAILED", ackStatus: outcome, errorCode: safeCode(reason || outcome, outcome) });
        await releaseLease(sub, partitionKey, token);
        return { partitionKey, status: outcome === "SKIPPED_BLOCKED" ? "BLOCKED" : outcome, reason: reason || undefined };
      }
      acked = last;
    }

    // 2. Fetch one bounded page from the registry-pinned destination.
    let page;
    try {
      const res = await client.getEvents({ dataset_id: sub.dataset_id, partition_key: partitionKey, after_sequence: last, limit: sub.page_limit }, { correlationId });
      if (res.status !== 200) {
        const reason = safeCode(res.json.error && res.json.error.reason, "EVENTS_UNAVAILABLE");
        await alert(reason, ctx);
        await finishRun(runId, { status: "FAILED", errorCode: reason });
        await releaseLease(sub, partitionKey, token);
        return { partitionKey, status: "FAILED", reason };
      }
      page = res.json.result;
    } catch (err) {
      await alert("PRODUCT_ADMIN_UNREACHABLE", ctx);
      await finishRun(runId, { status: "FAILED", errorCode: "PRODUCT_ADMIN_UNREACHABLE" });
      await releaseLease(sub, partitionKey, token);
      return { partitionKey, status: "FAILED", reason: "PRODUCT_ADMIN_UNREACHABLE" };
    }
    if (!validateEventsPage(page).valid || page.dataset_id !== sub.dataset_id || page.partition_key !== partitionKey || page.events.length > sub.page_limit) {
      await alert("EVENTS_PAGE_INVALID", ctx);
      await finishRun(runId, { status: "FAILED", errorCode: "EVENTS_PAGE_INVALID" });
      await releaseLease(sub, partitionKey, token);
      return { partitionKey, status: "FAILED", reason: "EVENTS_PAGE_INVALID" };
    }

    // 3. Verify and apply in sequence order; stop at gaps, revocation or lease loss.
    const events = [...page.events].sort((a, b) => (Number(a && a.sequence) || 0) - (Number(b && b.sequence) || 0));
    let terminal = null;
    for (const event of events) {
      stats.received += 1;
      const outcome = await processEvent(sub, registry, datasetDef, partitionKey, token, event, correlationId);
      if (outcome === "APPLIED") stats.applied += 1;
      else if (outcome === "STALE") stats.stale += 1;
      else if (outcome === "DUPLICATE") stats.duplicate += 1;
      else if (outcome.startsWith("QUARANTINED")) stats.quarantined += 1;
      // Only an applied (or stale-but-recorded) event moves the cursor.
      if (["APPLIED", "STALE", "QUARANTINED_FILTERED"].includes(outcome)) last = event.sequence;
      if (["GAP", "QUARANTINED_HELD", "ABORTED_REVOKED", "BLOCKED_SYNC_GATE", "LEASE_LOST", "SKIPPED_POLICY", "MALFORMED_PAGE"].includes(outcome)) { terminal = outcome; break; }
      if (hooks.afterCommit) await hooks.afterCommit({ subscriptionId: sub.id, partitionKey, sequence: event.sequence, outcome });
    }
    if (stats.quarantined) await alert("EVENTS_QUARANTINED", ctx);
    if (terminal === "GAP") await alert("SEQUENCE_GAP_DETECTED", ctx);
    if (terminal === "QUARANTINED_HELD") await alert("EVENT_INTEGRITY_HOLD", ctx);
    if (terminal === "BLOCKED_SYNC_GATE") {
      // Blocked mid-run: nothing after the block is applied or acknowledged.
      const reason = safeCode(await gate(pool, sub, false), "SYNC_BLOCKED");
      await alert(reason, ctx);
      await finishRun(runId, { ...stats, status: "BLOCKED", errorCode: reason });
      await releaseLease(sub, partitionKey, token);
      return { partitionKey, status: "BLOCKED", reason, ...stats };
    }
    if (terminal === "ABORTED_REVOKED" || terminal === "LEASE_LOST" || terminal === "SKIPPED_POLICY") {
      await finishRun(runId, { ...stats, status: terminal, errorCode: terminal === "LEASE_LOST" ? "FENCING_TOKEN_SUPERSEDED" : terminal });
      if (terminal !== "LEASE_LOST") await releaseLease(sub, partitionKey, token);
      return { partitionKey, status: terminal, ...stats };
    }

    // 4. ACK after commit: only the contiguous sequence committed before any
    // gap or hold is eligible.
    let ackStatus = "NOT_REQUIRED";
    if (last > acked) {
      ackStatus = await ack(client, sub, partitionKey, token, last, correlationId);
      if (ackStatus === "ACK_FAILED") await alert("ACK_FAILED", ctx);
    }
    const held = terminal === "GAP" || terminal === "QUARANTINED_HELD";
    const status = held ? "PARTIAL_GAP" : terminal === "MALFORMED_PAGE" ? "FAILED" : ackStatus === "SKIPPED_BLOCKED" ? "BLOCKED" : "SUCCEEDED";
    await finishRun(runId, { ...stats, status, ackStatus, ackedSequence: ackStatus === "ACKED" ? last : null, errorCode: terminal === "MALFORMED_PAGE" ? "EVENTS_PAGE_INVALID" : terminal === "QUARANTINED_HELD" ? "EVENT_INTEGRITY_HOLD" : ackStatus === "SKIPPED_BLOCKED" ? "SYNC_BLOCKED" : null });
    await releaseLease(sub, partitionKey, token);
    return { partitionKey, status, ackStatus, last, ...stats };
  }

  // Backfills a detected gap from an authoritative snapshot. Never moves an
  // entity backwards; clears the gap only if the snapshot covers it.
  async function reconcilePartition(sub, client, datasetDef, partitionKey) {
    const correlationId = randomUUID();
    const runId = randomUUID();
    const ctx = { product_id: sub.product_id, product_admin_id: sub.product_admin_id, subscription_id: sub.id, partition_key: partitionKey, correlation_id: correlationId };
    const lease = await acquireLease(sub, partitionKey);
    await pool.query(`INSERT INTO ${T}hq_product_admin_sync_runs (id, product_admin_id, subscription_id, partition_key, run_kind, worker_id, fencing_token, correlation_id, status) VALUES ($1,$2,$3,$4,'RECONCILE',$5,$6,$7,'RUNNING')`,
      [runId, sub.product_admin_id, sub.id, partitionKey, workerId, lease ? lease.lease_token : null, correlationId]);
    if (!lease) { await finishRun(runId, { status: "LEASE_LOST", errorCode: "LEASE_HELD_BY_OTHER_WORKER" }); return "LEASE_LOST"; }
    const token = lease.lease_token;
    let snapshot;
    let asOf;
    try {
      const res = await client.getDatasetSnapshot(sub.dataset_id, { query: { partition_key: partitionKey }, correlationId });
      if (res.status !== 200) throw Object.assign(new Error("SNAPSHOT_UNAVAILABLE"), { reason: safeCode(res.json.error && res.json.error.reason, "SNAPSHOT_UNAVAILABLE") });
      snapshot = res.json.result;
      asOf = res.json.as_of;
      if (!validateSnapshot(snapshot).valid || snapshot.dataset_id !== sub.dataset_id || snapshot.dataset_version !== sub.schema_revision || !asOf) throw Object.assign(new Error("SNAPSHOT_INVALID"), { reason: "SNAPSHOT_INVALID" });
    } catch (err) {
      const reason = err.reason || "PRODUCT_ADMIN_UNREACHABLE";
      await alert(reason, ctx);
      await finishRun(runId, { status: "FAILED", errorCode: reason });
      await releaseLease(sub, partitionKey, token);
      return reason;
    }
    const through = (snapshot.partitions.find((p) => p.partition_key === partitionKey) || {}).through_sequence;
    const db = await pool.connect();
    let result = "PARTIAL_GAP";
    const stats = { received: snapshot.records.length, applied: 0, stale: 0, quarantined: 0 };
    try {
      await db.query("BEGIN");
      const blocked = await gate(db, sub, true);
      if (blocked) {
        await db.query("ROLLBACK");
        const revoked = blocked === "PRODUCT_NOT_ENABLED";
        await finishRun(runId, { status: revoked ? "ABORTED_REVOKED" : "BLOCKED", errorCode: revoked ? "ABORTED_REVOKED" : safeCode(blocked, "SYNC_BLOCKED") });
        if (!revoked) { await alert(safeCode(blocked, "SYNC_BLOCKED"), ctx); await releaseLease(sub, partitionKey, token); }
        return revoked ? "ABORTED_REVOKED" : "BLOCKED";
      }
      const c = await db.query(`SELECT * FROM ${T}hq_product_admin_sync_cursors WHERE subscription_id = $1 AND partition_key = $2 FOR UPDATE`, [sub.id, partitionKey]);
      if (String(c.rows[0].lease_token) !== String(token) || c.rows[0].lease_owner !== workerId) { await db.query("ROLLBACK"); await finishRun(runId, { status: "LEASE_LOST", errorCode: "FENCING_TOKEN_SUPERSEDED" }); return "LEASE_LOST"; }
      for (const record of snapshot.records) {
        const scopeOk = Object.keys(record.scope).every((dim) => sub.scope_dimensions.includes(dim)) &&
          Object.entries(sub.allowed_scope).every(([dim, values]) => record.scope[dim] !== undefined && values.includes(record.scope[dim]));
        const check = scopeOk ? checkObservation(datasetDef, record.payload) : { ok: false, reason: "SCOPE_DENIED" };
        if (!check.ok) {
          await quarantine(db, sub, { event: null, partitionKey, sequence: null, reason: "SNAPSHOT_" + check.reason, correlationId });
          stats.quarantined += 1;
          continue;
        }
        const applied = await applyObservation(db, { productAdmin: { id: sub.product_admin_id, product_id: sub.product_id }, subscription: sub, contractId: sub.contract_id, dataset: datasetDef, metric: check.metric, payload: record.payload, scope: record.scope, entityVersion: record.entity.version, sequence: null, now: now() });
        if (applied.application === "APPLIED") {
          stats.applied += 1;
          await db.query(`INSERT INTO ${T}hq_product_admin_lineage (product_admin_id, metric_row_id, snapshot_ref, contract_id, dataset_id, operation, source_entity_version) VALUES ($1,$2,$3,$4,$5,'RECONCILE_SNAPSHOT',$6)`,
            [sub.product_admin_id, applied.metricRowId, snapshot.snapshot_id, sub.contract_id, sub.dataset_id, record.entity.version]);
        } else {
          stats.stale += 1;
        }
      }
      const cursor = c.rows[0];
      if (cursor.gap_to !== null && Number.isSafeInteger(through) && through >= Number(cursor.gap_to) && snapshot.complete) {
        await db.query(`UPDATE ${T}hq_product_admin_sync_cursors SET last_sequence = GREATEST(last_sequence, $3), gap_from = NULL, gap_to = NULL, gap_detected_at = NULL, hold_reason = NULL, last_success_at = now() WHERE subscription_id = $1 AND partition_key = $2`, [sub.id, partitionKey, through]);
        // Events held in quarantine within the covered range are superseded by
        // the authoritative snapshot. The quarantine record itself is kept.
        await db.query(`UPDATE ${T}hq_product_admin_quarantine SET resolved_at = now(), resolved_by = $4, resolution = 'SUPERSEDED_BY_SNAPSHOT'
                        WHERE subscription_id = $1 AND partition_key = $2 AND sequence IS NOT NULL AND sequence <= $3 AND resolved_at IS NULL`, [sub.id, partitionKey, through, workerId]);
        result = "RECONCILED";
      }
      await db.query(`UPDATE ${T}hq_product_admin_subscriptions SET last_reconciliation_at = now(), last_source_observation_at = GREATEST(COALESCE(last_source_observation_at, $2::timestamptz), $2::timestamptz), updated_at = now() WHERE id = $1`, [sub.id, asOf]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
    if (result !== "RECONCILED") await alert("RECONCILIATION_INCOMPLETE", ctx);
    await finishRun(runId, { ...stats, status: result === "RECONCILED" ? "SUCCEEDED" : "PARTIAL_GAP", errorCode: result === "RECONCILED" ? null : "SNAPSHOT_DOES_NOT_COVER_GAP" });
    await releaseLease(sub, partitionKey, token);
    return result;
  }

  async function refreshCoverage(sub) {
    await pool.query(
      `UPDATE ${T}hq_product_admin_subscriptions s SET
         gap_status = CASE WHEN EXISTS (SELECT 1 FROM ${T}hq_product_admin_sync_cursors c WHERE c.subscription_id = s.id AND c.gap_from IS NOT NULL) THEN 'GAP_DETECTED' ELSE 'NONE' END,
         coverage = CASE
           WHEN EXISTS (SELECT 1 FROM ${T}hq_product_admin_sync_cursors c WHERE c.subscription_id = s.id AND c.gap_from IS NOT NULL) OR EXISTS (SELECT 1 FROM ${T}hq_product_admin_quarantine q WHERE q.subscription_id = s.id AND q.resolved_at IS NULL) THEN 'PARTIAL'
           WHEN s.last_success_at IS NULL THEN s.coverage
           ELSE 'COMPLETE' END,
         updated_at = now()
       WHERE s.id = $1`, [sub.id]);
  }

  async function syncSubscription(sub) {
    const ctx = { product_id: sub.product_id, product_admin_id: sub.product_admin_id, subscription_id: sub.id };
    const blocked = identityBlock(sub, trustStore, now(), environment);
    if (blocked) {
      // Nothing is requested from the Product Admin (no events, snapshots,
      // reconciliation or ACK); the cursor and committed data are untouched
      // and the block is recorded as a sanitized alert.
      await alert(safeCode(blocked, "SYNC_BLOCKED"), ctx);
      await pool.query(`UPDATE ${T}hq_product_admins SET sync_status = 'FAILING' WHERE id = $1 AND lifecycle_status = 'ENABLED'`, [sub.product_admin_id]);
      return { subscriptionId: sub.id, status: policy.blockStatus(blocked), reason: blocked };
    }
    const datasetDef = (sub.catalog.datasets || []).find((d) => d.dataset_id === sub.dataset_id && d.version === sub.schema_revision);
    if (!datasetDef || datasetDef.schema_digest !== sub.schema_digest) {
      await pool.query(`UPDATE ${T}hq_product_admin_subscriptions SET status = 'POLICY_BLOCKED', policy_block_reason = 'SCHEMA_REVISION_NOT_IN_ACTIVE_CONTRACT', updated_at = now() WHERE id = $1`, [sub.id]);
      await alert("SCHEMA_REVISION_NOT_IN_ACTIVE_CONTRACT", ctx);
      return { subscriptionId: sub.id, status: "POLICY_BLOCKED" };
    }
    let client;
    try { client = clientFor(endpoints, sub, clientOptions); } catch (err) {
      await alert(safeCode(err.reason, "ENDPOINT_INVALID"), ctx);
      return { subscriptionId: sub.id, status: "FAILED", reason: err.reason };
    }
    const registry = E.createEventRegistry({ productId: sub.product_id, sourceId: sub.service_instance_id, families: sub.catalog.event_families, datasets: sub.catalog.datasets });
    const results = [];

    const gaps = await pool.query(`SELECT partition_key FROM ${T}hq_product_admin_sync_cursors WHERE subscription_id = $1 AND gap_from IS NOT NULL`, [sub.id]);
    for (const row of gaps.rows) results.push({ partitionKey: row.partition_key, reconcile: await reconcilePartition(sub, client, datasetDef, row.partition_key) });

    let status;
    try {
      const res = await client.getSyncStatus();
      if (res.status !== 200 || !validateSyncStatus(res.json.result).valid) throw Object.assign(new Error(), { reason: safeCode(res.json.error && res.json.error.reason, "SYNC_STATUS_INVALID") });
      status = res.json.result;
      if (status.event_source !== "CERTIFIED") throw Object.assign(new Error(), { reason: "EVENT_SOURCE_NOT_CERTIFIED" });
    } catch (err) {
      const reason = err.reason || "PRODUCT_ADMIN_UNREACHABLE";
      await alert(reason, ctx);
      await pool.query(`UPDATE ${T}hq_product_admins SET health_status = 'UNREACHABLE', health_checked_at = now(), sync_status = 'FAILING' WHERE id = $1 AND lifecycle_status = 'ENABLED'`, [sub.product_admin_id]);
      return { subscriptionId: sub.id, status: "FAILED", reason, results };
    }
    for (const partition of status.partitions.filter((p) => p.dataset_id === sub.dataset_id)) {
      const stop = await gate(pool, sub, false);
      if (stop) { results.push({ partitionKey: partition.partition_key, status: stop === "PRODUCT_NOT_ENABLED" ? "ABORTED_REVOKED" : "BLOCKED", reason: stop }); break; }
      results.push(await syncPartition(sub, client, registry, datasetDef, partition));
    }
    await refreshCoverage(sub);
    const failing = results.some((r) => r.status === "FAILED" || r.status === "ACK_FAILED" || r.status === "BLOCKED" || r.reconcile === "BLOCKED");
    const gap = results.some((r) => r.status === "PARTIAL_GAP");
    await pool.query(`UPDATE ${T}hq_product_admins SET health_status = 'REACHABLE', health_checked_at = now(), sync_status = $2 WHERE id = $1 AND lifecycle_status = 'ENABLED'`,
      [sub.product_admin_id, failing ? "FAILING" : gap ? "GAP_DETECTED" : "HEALTHY"]);
    return { subscriptionId: sub.id, status: "DONE", results };
  }

  async function tick({ productAdminId = null, scheduled = false } = {}) {
    const subs = await loadSubscriptions(productAdminId, { scheduled });
    const out = [];
    for (const sub of subs) out.push(await syncSubscription(sub));
    return out;
  }

  return { tick, workerId, reconcilePartition, syncSubscription, loadSubscriptions };
}

module.exports = { createSyncEngine, identityBlock, IDENTITY_BLOCKING_DRIFT, SYNC_SAFE_DRIFT: policy.SYNC_SAFE_DRIFT };
