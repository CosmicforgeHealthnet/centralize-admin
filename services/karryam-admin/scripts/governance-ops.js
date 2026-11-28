"use strict";

// Operator data-governance actions on the Karryam Admin database (Section 9.4.8),
// run through the approved operations workflow, never by a coding agent on a host:
//
//   node scripts/governance-ops.js holds
//   node scripts/governance-ops.js hold-entity --source <service> --type <entity type> --ref <entity ref> --reason <CODE> --case <ref> --placed-by <staff> --approved-by <other staff>
//   node scripts/governance-ops.js hold-partition --partition <key> --reason <CODE> --case <ref> --placed-by <staff> --approved-by <other staff>
//   node scripts/governance-ops.js release-hold --id <uuid> --released-by <staff> --reason <CODE>
//   node scripts/governance-ops.js retention            (per-class policy; held rows kept)
//   node scripts/governance-ops.js erase --source <service> --type <entity type> --ref <entity ref> --fulfilment-operation <uuid> --actor <staff>
//
// Two-person holds, single release, retention and erasure rules are
// enforced by db/governance.js and again by database triggers.

const { loadConfig } = require("../src/config");
const { createPool } = require("../src/db/pool");
const { createGovernanceStore } = require("../src/db/governance");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const command = process.argv[2];
  const config = loadConfig(process.env);
  if (!config.enabled) throw Object.assign(new Error(), { reason: "KARRYAM_ADMIN_DISABLED" });
  const pool = createPool(config.databaseUrl, { max: 2 });
  const gov = createGovernanceStore(pool);
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  try {
    if (command === "holds") out({ holds: await gov.activeLegalHolds() });
    else if (command === "hold-entity") out({ hold_id: await gov.placeLegalHold({ target: { kind: "ENTITY", sourceService: arg("source"), entityType: arg("type"), entityRef: arg("ref") }, reasonCode: arg("reason"), caseReference: arg("case"), placedBy: arg("placed-by"), approvedBy: arg("approved-by") }) });
    else if (command === "hold-partition") out({ hold_id: await gov.placeLegalHold({ target: { kind: "PARTITION", partitionKey: arg("partition") }, reasonCode: arg("reason"), caseReference: arg("case"), placedBy: arg("placed-by"), approvedBy: arg("approved-by") }) });
    else if (command === "release-hold") out({ released: await gov.releaseLegalHold({ id: arg("id"), releasedBy: arg("released-by"), releaseReason: arg("reason") }) });
    else if (command === "retention") out(await gov.clearExpiredPayloads({ configuredDays: config.feed && config.feed.enabled ? config.feed.retentionDays : null }));
    else if (command === "erase") out(await gov.eraseEntity({ sourceService: arg("source"), entityType: arg("type"), entityRef: arg("ref"), fulfilmentOperationId: arg("fulfilment-operation"), actor: arg("actor") }));
    else throw Object.assign(new Error(), { reason: "USAGE" });
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ event: "governance_ops_failed", reason: (err && (err.reason || err.code)) || "FAILED" }) + "\n");
  process.exit(1);
});
