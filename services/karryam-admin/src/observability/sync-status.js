"use strict";

// Sanitized operator view of Stage A/B synchronization, read from the
// Karryam Admin database. No payloads, no source records, no credentials:
// only cursors, holds, counts, run states and coverage.

function iso(v) {
  return v instanceof Date ? v.toISOString() : v || null;
}

function createSyncStatus({ config, store = null, lastBridgeOutcome = () => null, now = Date.now }) {
  const feedOn = Boolean(config.feed && config.feed.enabled);

  function bridgeState() {
    const last = lastBridgeOutcome();
    return {
      configured: Boolean(config.bridge && config.bridge.enabled),
      certified: false,
      last_outcome: last ? last.outcome : null,
      last_outcome_at: last ? last.at : null,
    };
  }

  /** Small, fast dependency detail for /health/ready. */
  async function readiness() {
    const out = { bridge_state: bridgeState() };
    if (!store) return { ...out, worker: { feed: feedOn ? "CONFIGURED" : "DISABLED", partitions: 0 } };
    const partitions = await store.listPartitions();
    const successes = partitions.map((p) => p.last_success_at).filter(Boolean).map((d) => new Date(d).getTime());
    const nowMs = now();
    return {
      ...out,
      worker: {
        feed: feedOn ? "CONFIGURED" : "DISABLED",
        partitions: partitions.length,
        held: partitions.filter((p) => p.hold_sequence !== null && p.hold_sequence !== undefined).length,
        leased: partitions.filter((p) => p.lease_owner && p.lease_expires_at && new Date(p.lease_expires_at).getTime() > nowMs).length,
        last_success_at: successes.length ? new Date(Math.max(...successes)).toISOString() : null,
      },
    };
  }

  /** Full operator view for GET /sync/status. */
  async function full() {
    if (!store) return { status: feedOn ? "NO_PIPELINE_STORE" : "FEED_DISABLED", service: "karryam-admin", bridge: bridgeState(), partitions: [] };
    const s = await store.pipelineSummary();
    const acks = await store.outboxAcks();
    const heads = await store.outboxPartitions();
    return {
      status: "OK",
      service: "karryam-admin",
      as_of: new Date(now()).toISOString(),
      bridge: bridgeState(),
      feed: feedOn ? "CONFIGURED_NOT_CERTIFIED" : "DISABLED",
      partitions: s.partitions.map((p) => ({
        partition_key: p.partition_key,
        last_sequence: Number(p.last_sequence),
        acked_sequence: Number(p.acked_sequence),
        head_sequence: p.head_sequence === null ? null : Number(p.head_sequence),
        unacked: Number(p.last_sequence) - Number(p.acked_sequence),
        hold: p.hold_sequence === null ? null : { sequence: Number(p.hold_sequence), reason: p.hold_reason, detected_at: iso(p.hold_detected_at) },
        contract_revision: p.contract_revision,
        leased: Boolean(p.lease_owner && p.lease_expires_at && new Date(p.lease_expires_at).getTime() > now()),
        last_success_at: iso(p.last_success_at),
        last_ack_at: iso(p.last_ack_at),
        last_error_code: p.last_error_code,
        open_entity_version_gaps: p.open_gaps,
        open_quarantine: p.open_quarantine,
      })),
      quarantine: s.quarantine.map((q) => ({ partition_key: q.partition_key, reason: q.reason, count: q.n, last_detected_at: iso(q.last_detected_at) })),
      runs: s.runs.map((r) => ({ stage: r.stage, partition_key: r.partition_key, status: r.status, started_at: iso(r.started_at), finished_at: iso(r.finished_at), error_code: r.error_code })),
      coverage: s.coverage.map((c) => ({ source_service: c.source_service, entity_type: c.entity_type, coverage: c.bridge_coverage, open_gaps: c.bridge_open_gaps, backfill: c.bridge_backfill, freshness: c.bridge_freshness, observed_at: iso(c.observed_at) })),
      hq_outbox: heads.map((h) => {
        const ack = acks.filter((a) => a.dataset_id === h.dataset_id && a.partition_key === h.partition_key);
        const acked = ack.length ? Math.min(...ack.map((a) => Number(a.acked_sequence))) : 0;
        return { dataset_id: h.dataset_id, partition_key: h.partition_key, head_sequence: Number(h.head_sequence), acked_sequence: acked, unacked: Number(h.head_sequence) - acked };
      }),
    };
  }

  return { readiness, full };
}

module.exports = { createSyncStatus };
