"use strict";

// Representative rows written the way the 002 release wrote them (used by
// the Section 9 upgrade test and the backup/restore drill).

const { randomUUID, createHash } = require("node:crypto");

const sha = (s) => "sha256:" + createHash("sha256").update(String(s)).digest("hex");
const hex = (s) => createHash("sha256").update(String(s)).digest("hex");

function outboxEvent({ datasetId, partitionKey, sequence, eventId = randomUUID(), classification = "INTERNAL" }) {
  return { schema_id: "cosmicforge.metric-observation", schema_version: "1.0.0", family: datasetId + ".metric_observation", event_id: eventId, product_id: "karryam", dataset_id: datasetId,
    partition_key: partitionKey, sequence, classification, payload_digest: sha(eventId), payload: { value: 1 } };
}

async function seedRelease002(owner) {
  const P = "NG-LAGOS:karryam-ng:lagos-island:tenant-a";
  await owner.query(`INSERT INTO karryam_admin.bridge_feed_partitions (partition_key, market, organization, zone, tenant, consumer, last_sequence, acked_sequence, head_sequence) VALUES ($1,'NG-LAGOS','karryam-ng','lagos-island','tenant-a','ka.c',40,30,45)`, [P]);
  await owner.query(`INSERT INTO karryam_admin.bridge_contract_revisions (revision, source_commit, openapi_sha256, matrix_sha256, capability_count) VALUES ($1,'a4adee6',$2,$3,435)`, [hex("rev"), hex("oa"), hex("mx")]);
  const ev = randomUUID();
  await owner.query(`INSERT INTO karryam_admin.bridge_event_inbox (partition_key, event_id, sequence, event_type, source_service, entity_type, entity_ref, entity_version, tombstone, classification, scope, payload, event_digest, outcome, delivery, occurred_at, emitted_at, contract_revision)
    VALUES ($1,$2,40,'support.case.changed.v1','support-dispute-service','support_case','case-1',3,false,'INTERNAL','{"market":"NG-LAGOS"}','{"status":"OPEN"}',$3,'APPLIED','FEED',now(),now(),$4)`, [P, ev, sha(ev), hex("rev")]);
  await owner.query(`INSERT INTO karryam_admin.entity_projections (source_service, entity_type, entity_ref, partition_key, entity_version, classification, scope, payload, occurred_at, source_event_id, coverage)
    VALUES ('support-dispute-service','support_case','case-1',$1,3,'INTERNAL','{"market":"NG-LAGOS"}','{"status":"OPEN"}',now(),$2,'INCREMENTAL')`, [P, ev]);
  await owner.query(`INSERT INTO karryam_admin.metric_snapshots (metric_id, partition_key, window_start, window_end, value, value_state, coverage, observed_at, entity_version) VALUES ('karryam.support.cases_open',$1,'2026-10-30','2026-10-31',7,'OBSERVED','COMPLETE',now(),2)`, [P]);
  await owner.query(`INSERT INTO karryam_admin.hq_outbox_heads (dataset_id, partition_key, head_sequence) VALUES ('karryam.support_operations',$1,0)`, [P]);
  await owner.query(`UPDATE karryam_admin.hq_outbox_heads SET head_sequence = 1 WHERE partition_key = $1`, [P]);
  const e = outboxEvent({ datasetId: "karryam.support_operations", partitionKey: P, sequence: 1 });
  await owner.query(`INSERT INTO karryam_admin.hq_outbox (dataset_id, partition_key, sequence, event_id, family, event, payload_digest) VALUES ($1,$2,1,$3,$4,$5,$6)`, [e.dataset_id, P, e.event_id, e.family, JSON.stringify(e), e.payload_digest]);
  await owner.query(`INSERT INTO karryam_admin.hq_outbox_acks (consumer, dataset_id, partition_key, acked_sequence) VALUES ('hq-pic','karryam.support_operations',$1,1)`, [P]);
  await owner.query(`INSERT INTO karryam_admin.event_quarantine (partition_key, event_id, sequence, event_type, reason, raw_digest) VALUES ($1,'x',41,'support.case.changed.v1','SCHEMA_INVALID',$2)`, [P, sha("bad")]);
  const op = randomUUID();
  await owner.query(`INSERT INTO karryam_admin.operation_requests (id, service_id, idempotency_key, request_digest, capability_id, staff_ref, status, reason_code) VALUES ($1,'hq-pic','idem-0000000000000001',$2,'karryam.x','staff-1','REJECTED','CAPABILITY_DISABLED')`, [op, sha(op)]);
  await owner.query(`INSERT INTO karryam_admin.approval_references (id, capability_id, intent_digest, scope, requested_by, status, expires_at) VALUES ($1,'karryam.x',$2,'{}','staff-1','PROPOSED',now() + interval '1 hour')`, [randomUUID(), sha("intent")]);
  await owner.query(`INSERT INTO karryam_admin.sync_runs (id, stage, trigger_kind, worker_id, status, finished_at, counts) VALUES ($1,'BRIDGE_FEED','SCHEDULED','w1','SUCCEEDED',now(),'{"received":3}')`, [randomUUID()]);
  return { partition: P, eventId: ev, operationId: op };
}

module.exports = { outboxEvent, seedRelease002, sha, hex };
