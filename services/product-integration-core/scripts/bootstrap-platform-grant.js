"use strict";

// Operator bootstrap for the FIRST platform integration grants (nobody can
// administer integrations until someone is explicitly granted). Uses the
// migration/operator credential, never the runtime credential, and writes an
// OPERATOR audit record in the same transaction.
//
// Usage:
//   PIC_MIGRATION_DATABASE_URL=... node scripts/bootstrap-platform-grant.js \
//     --operator <operator-id> --staff <staff-id> --actions integration.read,integration.request \
//     [--expires-at 2027-01-31T00:00:00Z]

const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const I = require("../../../packages/identity-and-permissions");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const url = process.env.PIC_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("PIC_MIGRATION_DATABASE_URL is required");
  const operator = arg("operator");
  const grant = {
    id: randomUUID(), grant_kind: "PLATFORM", product_id: null, staff_id: arg("staff"), role: null, effect: "ALLOW",
    actions: String(arg("actions") || "").split(",").filter(Boolean), datasets: [], scope: {}, expires_at: arg("expires-at") || null, revoked_at: null,
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(String(operator)) || operator === grant.staff_id) throw new Error("--operator must be a distinct operator identity");
  const errors = I.grantErrors(grant);
  if (errors.length) throw new Error("invalid grant: " + errors.join(","));
  if (grant.expires_at && !(Date.parse(grant.expires_at) > Date.now())) throw new Error("--expires-at must be in the future");
  const client = new Client({ connectionString: url, application_name: "product-integration-core-bootstrap" });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO hq_integration.hq_product_admin_grants (id, grant_kind, staff_id, effect, actions, expires_at, granted_by) VALUES ($1,'PLATFORM',$2,'ALLOW',$3,$4,$5)`, [grant.id, grant.staff_id, grant.actions, grant.expires_at, "operator:" + operator]);
    await client.query(`INSERT INTO hq_integration.hq_product_admin_security_audit (actor_type, actor_id, action, outcome, metadata) VALUES ('OPERATOR',$1,'integration.grant.bootstrap','RECORDED',$2)`, [operator, JSON.stringify({ grant_ref: grant.id, staff_ref: grant.staff_id, actions: grant.actions })]);
    await client.query("COMMIT");
    console.log(JSON.stringify({ event: "platform_grant_bootstrapped", grant_id: grant.id, staff_id: grant.staff_id, actions: grant.actions }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "bootstrap_failed", error: String(err.message).replace(/postgres(ql)?:\/\/[^\s]+/g, "[redacted-url]") }));
  process.exit(1);
});
