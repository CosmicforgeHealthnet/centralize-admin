"use strict";

// Operator tool (Section 11.3): records or revokes a high-risk (R3/R4)
// command certification. Uses ONLY the migration credential (the runtime
// role cannot write certifications). Never enables a command by itself.
//
//   KARRYAM_ADMIN_MIGRATION_DATABASE_URL=... node scripts/high-risk-certification.js certify \
//     --capability karryam.<bridge capability> --policy-revision <owner policy revision> \
//     --evidence <evidence reference> --certified-by <staff> --second-reviewer <other staff> --days <1..180>
//   KARRYAM_ADMIN_MIGRATION_DATABASE_URL=... node scripts/high-risk-certification.js revoke \
//     --id <certification uuid> --revoked-by <staff> --reason <REASON_CODE>
//   KARRYAM_ADMIN_MIGRATION_DATABASE_URL=... node scripts/high-risk-certification.js list

const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const R = require("../src/bridge/contracts/registry");
const { contractRevision } = require("../src/sync/bridge-consumer");
const { contracts } = require("../src/packages");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; } else out._.push(argv[i]);
  }
  return out;
}

function certificationFor(a, nowMs = Date.now()) {
  const id = String(a.capability || "");
  const source = id.startsWith("karryam.") ? R.capability(id.slice("karryam.".length)) : null;
  if (!source || !["COMMAND", "RETRIEVAL"].includes(source.kind)) throw new Error("CAPABILITY_NOT_A_SOURCE_COMMAND");
  if (!["R3", "R4"].includes(source.risk)) throw new Error("CAPABILITY_NOT_HIGH_RISK");
  if (["BLOCKED_DEPENDENCY", "DISABLED"].includes(source.matrix_state)) throw new Error("CAPABILITY_DISABLED_AT_SOURCE");
  const days = Number(a.days);
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("DAYS_INVALID");
  if (!a["certified-by"] || !a["second-reviewer"] || a["certified-by"] === a["second-reviewer"]) throw new Error("TWO_DISTINCT_REVIEWERS_REQUIRED");
  return {
    id: randomUUID(), capability_id: id, risk: source.risk, contract_revision: contractRevision(), source_policy_revision: a["policy-revision"],
    evidence_ref: a.evidence, certified_by: a["certified-by"], second_reviewer: a["second-reviewer"],
    valid_from: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + days * 86400000).toISOString(),
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const url = process.env.KARRYAM_ADMIN_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("KARRYAM_ADMIN_MIGRATION_DATABASE_URL_REQUIRED");
  if (process.env.KARRYAM_ADMIN_DATABASE_URL && process.env.KARRYAM_ADMIN_DATABASE_URL === url) throw new Error("RUNTIME_AND_MIGRATION_CREDENTIALS_MUST_DIFFER");
  const client = new Client({ connectionString: url, application_name: "karryam-admin-high-risk-certification" });
  await client.connect();
  try {
    if (a._[0] === "certify") {
      const c = certificationFor(a);
      await client.query(
        `INSERT INTO karryam_admin.high_risk_certifications (id, capability_id, risk, contract_revision, source_policy_revision, evidence_ref, certified_by, second_reviewer, valid_from, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.id, c.capability_id, c.risk, c.contract_revision, c.source_policy_revision, c.evidence_ref, c.certified_by, c.second_reviewer, c.valid_from, c.expires_at]);
      console.log(JSON.stringify({ event: "high_risk_certified", certification_id: c.id, capability_id: c.capability_id, contract_revision: c.contract_revision, expires_at: c.expires_at, note: "Restart Karryam Admin to re-evaluate exposure; the operator allowlist, runtime Bridge availability, MFA, independent approval and Bridge authorization are still required." }));
    } else if (a._[0] === "revoke") {
      const { rowCount } = await client.query(`UPDATE karryam_admin.high_risk_certifications SET revoked_at = now(), revoked_by = $2, revocation_reason = $3 WHERE id = $1 AND revoked_at IS NULL`, [a.id, a["revoked-by"], a.reason]);
      if (rowCount !== 1) throw new Error("CERTIFICATION_NOT_ACTIVE");
      console.log(JSON.stringify({ event: "high_risk_certification_revoked", certification_id: a.id, note: "Takes effect immediately for new submissions" }));
    } else if (a._[0] === "list") {
      const { rows } = await client.query(`SELECT id, capability_id, risk, contract_revision, source_policy_revision, certified_by, second_reviewer, valid_from, expires_at, revoked_at FROM karryam_admin.high_risk_certifications ORDER BY certified_at`);
      console.log(JSON.stringify({ event: "high_risk_certifications", rows }));
    } else {
      throw new Error("USAGE: certify | revoke | list");
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(JSON.stringify({ event: "failed", reason: contracts.migrationSafety.redactUrl(err.message) })); process.exit(1); });
}

module.exports = { certificationFor };
