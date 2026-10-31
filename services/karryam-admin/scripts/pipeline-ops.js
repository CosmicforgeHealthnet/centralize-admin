"use strict";

// Operator-triggered Stage A operations (run through the approved GitHub
// Actions operations workflow, never by a coding agent on the host):
//
//   node scripts/pipeline-ops.js reconcile [--full-backfill]
//   node scripts/pipeline-ops.js status
//   node scripts/pipeline-ops.js release-hold --partition <key> --resolution <CODE> --operator <ref>
//
// "release-hold" records an audited resolution for a held partition's
// quarantined events. It never skips the held event: the next feed read
// re-reads from the committed cursor, so an unverifiable event holds again.

const { loadConfig } = require("../src/config");
const { createPool } = require("../src/db/pool");
const { createBridgeClient } = require("../src/bridge/client");
const { createPipelineStore } = require("../src/sync/store");
const { createBridgeConsumer } = require("../src/sync/bridge-consumer");
const { pgAudit } = require("../src/audit");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const command = process.argv[2];
  const config = loadConfig(process.env);
  if (!config.enabled || !config.feed.enabled) throw Object.assign(new Error(), { reason: "KARRYAM_BRIDGE_FEED_DISABLED" });
  const pool = createPool(config.databaseUrl, { max: 2 });
  const store = createPipelineStore(pool, { serviceInstanceId: config.serviceInstanceId });
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  try {
    if (command === "status") {
      const s = await store.pipelineSummary();
      out({ partitions: s.partitions.map((p) => ({ partition_key: p.partition_key, last_sequence: Number(p.last_sequence), acked_sequence: Number(p.acked_sequence), head_sequence: p.head_sequence === null ? null : Number(p.head_sequence), hold: p.hold_reason, open_gaps: p.open_gaps, open_quarantine: p.open_quarantine })), quarantine: s.quarantine, coverage: s.coverage });
    } else if (command === "reconcile") {
      const consumer = createBridgeConsumer({ feed: config.feed, store, bridgeClient: createBridgeClient(config.bridge, { metrics: {} }), workerId: "karryam-operator-reconcile" });
      await consumer.init();
      out({ results: await consumer.reconcile({ trigger: "OPERATOR", backfill: process.argv.includes("--full-backfill") ? "FULL" : "GAPS" }) });
    } else if (command === "release-hold") {
      const partition = arg("partition");
      const resolution = arg("resolution");
      const operator = arg("operator");
      if (!partition || !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(resolution)) || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(String(operator))) throw Object.assign(new Error(), { reason: "ARGUMENTS_INVALID" });
      const released = await store.releaseHold(partition, { operator, resolution });
      await pgAudit(pool).record({ endpoint: "pipeline.release-hold", method: "CLI", staff_ref: operator, action: "pipeline.release_hold", outcome: released ? "HOLD_RELEASED" : "NO_HOLD", reason_code: resolution, metadata: { partition_key: partition } });
      out({ partition, released });
    } else {
      throw Object.assign(new Error(), { reason: "UNKNOWN_COMMAND" });
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ event: "pipeline_ops_failed", reason: err.reason || err.code || "FAILED" }) + "\n");
  process.exit(1);
});
