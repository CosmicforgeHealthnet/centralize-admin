"use strict";

// Operator HQ data-governance actions (Section 9.4.8), product-neutral, run
// through the approved operations workflow with the runtime credential:
//
//   node scripts/legal-hold.js place --product-admin <uuid> [--dataset <id>] [--entity-type <t> --entity-id <id>] --reason <CODE> --case <ref> --placed-by <staff> --approved-by <other staff>
//   node scripts/legal-hold.js release --id <uuid> --released-by <staff> --reason <CODE>
//   node scripts/legal-hold.js retention
//
// Two-person holds, single release and hold-aware retention are enforced by
// src/retention and again by database triggers.

const { Pool } = require("pg");
const C = require("../../../packages/admin-contracts");
const { createRetention } = require("../src/retention");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const url = process.env.PIC_DATABASE_URL;
  if (!url) throw new Error("PIC_DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: url, max: 2, application_name: "product-integration-core-legal-hold" });
  const r = createRetention(pool);
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  try {
    const command = process.argv[2];
    if (command === "place") {
      out({ hold_id: await r.placeLegalHold({ productAdminId: arg("product-admin"), datasetId: arg("dataset") || null, entityType: arg("entity-type") || null, entityId: arg("entity-id") || null,
        reasonCode: arg("reason"), caseReference: arg("case"), placedBy: arg("placed-by"), approvedBy: arg("approved-by") }) });
    } else if (command === "release") {
      await r.releaseLegalHold({ id: arg("id"), releasedBy: arg("released-by"), releaseReason: arg("reason") });
      out({ released: true });
    } else if (command === "retention") {
      out(await r.clearExpiredInboxPayloads());
    } else {
      throw new Error("USAGE: place | release | retention");
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ event: "legal_hold_failed", reason: C.migrationSafety.redactUrl(err.reason || err.message) }) + "\n");
  process.exit(1);
});
