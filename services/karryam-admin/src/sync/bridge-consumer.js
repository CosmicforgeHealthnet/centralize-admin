"use strict";

// Stage A worker: Karryam Backoffice Bridge HQ event feed -> Karryam Admin.
//
//   for each approved feed scope (partition), under a fenced lease:
//     1. retry a pending ACK (committed but not yet acknowledged);
//     2. read one bounded page after the committed cursor;
//     3. verify each event (pinned adapters, scope, ordering) and apply it
//        in its own transaction; stop at the first event that cannot be
//        verified or applied (quarantine + hold; never skipped);
//     4. ACK the committed cursor to the Bridge (only after commit);
//     5. publish sync-health observations.
//
// At-least-once transport, exactly-once application: replays are recognised
// by event ID + digest, sequences never regress, projections are
// version-fenced. This worker never calls Headquarters, and its ACK to the
// Bridge never depends on Headquarters being online.

const { randomUUID } = require("node:crypto");
const { verifyEvent, rawDigest } = require("./bridge-events");
const { partitionKeyFor } = require("./store");
const { PINNED_BRIDGE_CONTRACT } = require("../bridge/contracts");
const R = require("../bridge/contracts/registry");

const SESSION_ROTATE_MS = 12 * 3600 * 1000;
const WINDOW_MS = 31 * 24 * 3600 * 1000 - 5 * 60 * 1000;
const MAX_PAGES_PER_RUN = 20;

function contractRevision() {
  const s = R.summary();
  return require("node:crypto").createHash("sha256").update([PINNED_BRIDGE_CONTRACT.source_commit, s.source_artifacts.openapi_sha256, s.source_artifacts.capability_matrix_sha256].join("|")).digest("hex");
}

function createBridgeConsumer({ feed, store, bridgeClient, workerId = "karryam-feed-" + randomUUID().slice(0, 8), now = Date.now, logger = () => {}, hooks = {} }) {
  if (!feed || !feed.enabled) throw new Error("FEED_DISABLED");
  const revision = contractRevision();
  let session = { id: "feed-" + randomUUID(), startedAt: Math.floor(now() / 1000) };

  // The consumer principal is an operator-approved Bridge service subject.
  // Its "session" is the worker credential session, rotated every 12 h so
  // it stays well inside the Bridge's one-day session ceiling.
  function staffFor(scope) {
    if (now() - session.startedAt * 1000 > SESSION_ROTATE_MS) session = { id: "feed-" + randomUUID(), startedAt: Math.floor(now() / 1000) };
    return { sub: feed.subject, sessionId: session.id, authTime: session.startedAt, acr: feed.acr, role: feed.role, market: scope.market, organization: scope.organization, zone: scope.zone, tenant: scope.tenant };
  }

  // The Bridge keeps ONE acknowledged sequence per consumer name, while this
  // worker keeps one cursor per feed scope. Each partition therefore ACKs as
  // its own consumer, so partitions never regress each other's ACK.
  function consumerName(key) {
    const name = feed.consumer + "." + key;
    if (name.length <= 128) return name;
    return feed.consumer.slice(0, 80) + ".p-" + require("node:crypto").createHash("sha256").update(key).digest("hex").slice(0, 40);
  }

  function window() {
    const end = now();
    return { start: new Date(end - WINDOW_MS).toISOString(), end: new Date(end).toISOString() };
  }

  function baseQuery(scope, limit) {
    return { market: scope.market, organization: scope.organization, purpose: feed.purpose, zone: scope.zone, tenant: scope.tenant, ...window(), limit };
  }

  async function init() {
    await store.recordContractRevision({ revision, sourceCommit: PINNED_BRIDGE_CONTRACT.source_commit, openapiSha256: R.summary().source_artifacts.openapi_sha256, matrixSha256: R.summary().source_artifacts.capability_matrix_sha256, capabilityCount: R.CAPABILITIES.length });
    return store.ensurePartitions(feed.scopes, feed.consumer);
  }

  async function ack(scope, key, token, sequence) {
    if (hooks.beforeAck) await hooks.beforeAck({ partitionKey: key, sequence });
    try {
      const consumer = consumerName(key);
      const res = await bridgeClient.call("hq.events.ack", { staff: staffFor(scope), query: baseQuery(scope, 1), body: { consumer, sequence } });
      if (res.result.consumer !== consumer || res.result.acknowledged_sequence !== sequence) return "ACK_MISMATCH";
    } catch (err) {
      logger({ event: "bridge_ack_failed", partition_key: key, category: err.category || "UNKNOWN" });
      return "ACK_FAILED";
    }
    return (await store.recordAck(key, workerId, token, sequence)) ? "ACKED" : "ACK_NOT_RECORDED";
  }

  async function syncPartition(scope, { trigger = "SCHEDULED" } = {}) {
    const key = partitionKeyFor(scope);
    const lease = await store.acquireLease(key, workerId, feed.leaseSeconds);
    if (!lease) return { partitionKey: key, status: "LEASE_LOST" };
    const token = lease.lease_token;
    const runId = await store.startRun({ stage: "BRIDGE_FEED", trigger, partitionKey: key, workerId, token, contractRevision: revision });
    const counts = { received: 0, applied: 0, stale: 0, duplicate: 0, gap_applied: 0, quarantined: 0, pages: 0 };
    let status = "SUCCEEDED";
    let errorCode = null;
    let leaseLost = false;
    try {
      if (lease.hold_sequence !== null) { status = "HELD"; errorCode = lease.hold_reason; return { partitionKey: key, status, reason: lease.hold_reason }; }
      let last = Number(lease.last_sequence);
      if (Number(lease.acked_sequence) < last) {
        const outcome = await ack(scope, key, token, last);
        if (outcome !== "ACKED") { status = "PARTIAL"; errorCode = outcome; }
      }
      pages: for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
        let res;
        try {
          const query = baseQuery(scope, feed.pageSize);
          if (last > 0) query.cursor = String(last);
          res = await bridgeClient.call("hq.events.feed", { staff: staffFor(scope), query });
        } catch (err) {
          status = counts.applied ? "PARTIAL" : "FAILED";
          errorCode = "BRIDGE_" + (err.category || "UNAVAILABLE");
          await store.recordError(key, errorCode);
          break;
        }
        counts.pages += 1;
        const result = res.result;
        await store.setHead(key, workerId, token, result.head_sequence);
        let previous = last;
        for (const event of result.events) {
          counts.received += 1;
          const seq = event && event.sequence;
          if (!Number.isSafeInteger(seq) || seq <= previous || seq > result.head_sequence) {
            const outcome = await store.rejectEvent(key, workerId, token, { event, reason: Number.isSafeInteger(seq) && seq <= previous ? "SEQUENCE_OUT_OF_ORDER" : "SEQUENCE_INVALID", digest: rawDigest(event), delivery: "FEED" });
            counts.quarantined += 1;
            if (outcome === "LEASE_LOST") leaseLost = true;
            status = leaseLost ? "LEASE_LOST" : "HELD";
            errorCode = "SEQUENCE_ANOMALY";
            break pages;
          }
          const verified = verifyEvent(event, scope, { now: now() });
          if (!verified.ok) {
            const outcome = await store.rejectEvent(key, workerId, token, { event, reason: verified.reason, digest: verified.digest, delivery: "FEED" });
            counts.quarantined += 1;
            if (outcome === "LEASE_LOST") leaseLost = true;
            status = leaseLost ? "LEASE_LOST" : "HELD";
            errorCode = verified.reason;
            break pages;
          }
          if (hooks.beforeCommit) await hooks.beforeCommit({ partitionKey: key, sequence: seq });
          const outcome = await store.applyEvent(key, workerId, token, event, verified, { delivery: "FEED", contractRevision: revision });
          if (outcome === "LEASE_LOST") { leaseLost = true; status = "LEASE_LOST"; errorCode = "FENCING_TOKEN_SUPERSEDED"; break pages; }
          if (outcome === "HELD" || outcome === "QUARANTINED_HELD") { counts.quarantined += outcome === "QUARANTINED_HELD" ? 1 : 0; status = "HELD"; errorCode = "PARTITION_HELD"; break pages; }
          if (outcome === "DUPLICATE") counts.duplicate += 1;
          else if (outcome === "STALE") counts.stale += 1;
          else if (outcome === "GAP_APPLIED") counts.gap_applied += 1;
          else counts.applied += 1;
          if (outcome !== "DUPLICATE") last = seq;
          previous = seq;
          if (hooks.afterCommit) await hooks.afterCommit({ partitionKey: key, sequence: seq, outcome });
        }
        if (result.events.length < feed.pageSize) break;
      }
      // ACK only what is committed, never past a hold or an uncommitted event.
      if (!leaseLost) {
        const p = await store.partition(key);
        if (p && Number(p.last_sequence) > Number(p.acked_sequence)) {
          const outcome = await ack(scope, key, token, Number(p.last_sequence));
          if (outcome !== "ACKED" && status === "SUCCEEDED") { status = "PARTIAL"; errorCode = outcome; }
        }
        await store.publishSyncHealth(key);
      }
      return { partitionKey: key, status, reason: errorCode || undefined, ...counts };
    } finally {
      await store.finishRun(runId, { status, counts, errorCode }).catch(() => {});
      if (!leaseLost) await store.releaseLease(key, workerId, token).catch(() => {});
      if (status !== "SUCCEEDED") logger({ event: "bridge_feed_run", partition_key: key, status, reason: errorCode });
    }
  }

  // Reconciliation: Bridge projection status vs local state, rewind re-read
  // of recently passed sequences (late-visible rows), support-case snapshot
  // backfill for open entity gaps, then re-derivation.
  async function reconcilePartition(scope, { trigger = "SCHEDULED", backfill = "GAPS" } = {}) {
    const key = partitionKeyFor(scope);
    const lease = await store.acquireLease(key, workerId, feed.leaseSeconds);
    if (!lease) return { partitionKey: key, status: "LEASE_LOST" };
    const token = lease.lease_token;
    const runId = await store.startRun({ stage: "RECONCILE", trigger, partitionKey: key, workerId, token, contractRevision: revision });
    const counts = { late_applied: 0, rewind_duplicates: 0, rewind_conflicts: 0, backfilled: 0, backfill_stale: 0, backfill_rejected: 0 };
    const details = { local_cursor: Number(lease.last_sequence), local_acked: Number(lease.acked_sequence), hold_sequence: lease.hold_sequence === null ? null : Number(lease.hold_sequence) };
    let status = "SUCCEEDED";
    let errorCode = null;
    try {
      try {
        const res = await bridgeClient.call("hq.projections.status", { staff: staffFor(scope), query: baseQuery(scope, 1) });
        const st = res.result;
        details.bridge_head = st.head_sequence;
        details.bridge_consumer_lag = Object.prototype.hasOwnProperty.call(st.consumer_lag, consumerName(key)) ? st.consumer_lag[consumerName(key)] : null;
        details.bridge_quarantined = st.quarantined;
        details.source_coverage = st.sources.map((s) => ({ source_service: s.source_service, entity_type: s.entity_type, coverage: s.coverage, open_gaps: s.open_gaps, freshness: s.freshness }));
        await store.recordSourceCoverage(st.sources, st.as_of);
        await store.setHead(key, workerId, token, st.head_sequence);
      } catch (err) {
        status = "PARTIAL";
        errorCode = "PROJECTION_STATUS_" + (err.category || "UNAVAILABLE");
      }

      // Rewind: sequences committed by the Bridge after we passed them.
      const last = Number(lease.last_sequence);
      let cursor = Math.max(0, last - feed.rewindEvents);
      while (cursor < last) {
        let res;
        try {
          const query = baseQuery(scope, 100);
          if (cursor > 0) query.cursor = String(cursor);
          res = await bridgeClient.call("hq.events.feed", { staff: staffFor(scope), query });
        } catch (err) { status = "PARTIAL"; errorCode = errorCode || "REWIND_" + (err.category || "UNAVAILABLE"); break; }
        if (!res.result.events.length) break;
        for (const event of res.result.events) {
          if (!Number.isSafeInteger(event.sequence) || event.sequence > last) { cursor = last; break; }
          const verified = verifyEvent(event, scope, { now: now() });
          if (!verified.ok) { await store.rejectEvent(key, workerId, token, { event, reason: verified.reason, digest: verified.digest, delivery: "REWIND" }); counts.rewind_conflicts += 1; continue; }
          const outcome = await store.applyEvent(key, workerId, token, event, verified, { delivery: "REWIND", contractRevision: revision });
          if (outcome === "LEASE_LOST") throw Object.assign(new Error(), { leaseLost: true });
          if (outcome === "LATE_APPLIED" || outcome === "LATE_STALE") counts.late_applied += 1;
          else if (outcome === "DUPLICATE") counts.rewind_duplicates += 1;
          else if (outcome.startsWith("QUARANTINED")) counts.rewind_conflicts += 1;
          cursor = Math.max(cursor, event.sequence);
        }
        if (res.result.events.length < 100) break;
      }

      // Snapshot backfill of support cases from the authorized HQ support
      // queue (current source versions; never overwrites newer local data).
      const summary = await store.pipelineSummary();
      const part = summary.partitions.find((p) => p.partition_key === key);
      if (backfill === "FULL" || (part && part.open_gaps > 0)) {
        let next = "";
        for (let page = 0; page < 50; page += 1) {
          let res;
          try {
            const query = baseQuery(scope, 100);
            if (next) query.cursor = next;
            res = await bridgeClient.call("hq.support.queue", { staff: staffFor(scope), query });
          } catch (err) { status = "PARTIAL"; errorCode = errorCode || "BACKFILL_" + (err.category || "UNAVAILABLE"); break; }
          for (const item of res.result.items) {
            const record = supportRecord(item, scope);
            if (!record) { counts.backfill_rejected += 1; continue; }
            const outcome = await store.applySnapshotRecord(key, workerId, token, record, runId);
            if (outcome === "LEASE_LOST") throw Object.assign(new Error(), { leaseLost: true });
            if (outcome === "BACKFILLED") counts.backfilled += 1; else counts.backfill_stale += 1;
          }
          next = res.result.next_cursor;
          if (!next) break;
        }
      }
      await store.rederive(key);
      const after = (await store.pipelineSummary()).partitions.find((p) => p.partition_key === key);
      details.open_gaps_after = after ? after.open_gaps : null;
      details.open_quarantine_after = after ? after.open_quarantine : null;
      if (status === "SUCCEEDED" && after && (after.open_gaps > 0 || after.open_quarantine > 0 || after.hold_sequence !== null)) status = "PARTIAL";
      return { partitionKey: key, status, reason: errorCode || undefined, counts, details };
    } catch (err) {
      if (err && err.leaseLost) { status = "LEASE_LOST"; errorCode = "FENCING_TOKEN_SUPERSEDED"; return { partitionKey: key, status }; }
      status = "FAILED";
      errorCode = "RECONCILE_FAILED";
      throw err;
    } finally {
      await store.finishRun(runId, { status, counts, details, errorCode }).catch(() => {});
      if (status !== "LEASE_LOST") await store.releaseLease(key, workerId, token).catch(() => {});
    }
  }

  async function tick(opts) {
    const results = [];
    for (const scope of feed.scopes) results.push(await syncPartition(scope, opts));
    return results;
  }

  async function reconcile(opts) {
    const results = [];
    for (const scope of feed.scopes) results.push(await reconcilePartition(scope, opts));
    return results;
  }

  return { init, tick, reconcile, syncPartition, reconcilePartition, consumerName, workerId, revision };
}

// HQ support queue row -> version-fenced projection record. Only the pinned
// support-case fields survive; anything else rejects the row.
function supportRecord(item, scope) {
  const { ADAPTERS } = require("./bridge-events");
  const adapter = ADAPTERS.get("karryam.support.case.updated.v1");
  if (item.source_service !== adapter.source_service || item.classification !== adapter.classification) return null;
  const payload = {};
  for (const key of Object.keys(item.fields || {})) if (!adapter.fields[key]) return null;
  for (const [name, field] of Object.entries(adapter.fields)) {
    const value = item.fields[name] === undefined ? null : item.fields[name];
    if (value === null && field.required) return null;
    payload[name] = value;
  }
  const probe = verifyEvent({
    schema: "cosmicforge.product-admin-event.v1", event_id: "00000000-0000-4000-8000-000000000000", sequence: 1, event_type: "karryam.support.case.updated.v1",
    source_service: item.source_service, product: "karryam", entity_type: "support_case", entity_ref: item.source_case_id, entity_version: item.source_version,
    tombstone: false, occurred_at: item.received_at, emitted_at: item.received_at, market: scope.market, scope: { zone: scope.zone, organization: scope.organization, tenant: scope.tenant },
    classification: item.classification, correlation_id: "backfill", payload,
  }, scope, { now: Date.parse(item.received_at) + 1000 });
  if (!probe.ok) return null;
  return {
    source_service: item.source_service, entity_type: "support_case", entity_ref: item.source_case_id, entity_version: item.source_version,
    classification: item.classification, scope: { market: scope.market, organization: scope.organization, zone: scope.zone, tenant: scope.tenant },
    payload: probe.payload, observed_at: item.received_at, synthetic_event_id: randomUUID(),
  };
}

module.exports = { createBridgeConsumer, contractRevision, supportRecord };
