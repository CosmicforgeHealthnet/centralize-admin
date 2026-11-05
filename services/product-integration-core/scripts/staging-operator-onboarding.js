"use strict";

// No HTTP endpoint, bearer token, staff identity or invented MFA proof.
// Runs only as root with a protected owner-signed staging delegation.
const { randomUUID } = require("node:crypto");
const { loadConfig } = require("../src/config");
const { loadOperatorPermit } = require("../src/onboarding/operator");
const { createOnboarding } = require("../src/onboarding/service");

function options(argv) {
  const allowed = new Set(["--decision", "--step", "--id", "--expected-revision", "--evidence-ref", "--dataset", "--version", "--apply"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!allowed.has(k) || Object.hasOwn(out, k)) throw new Error("INVALID_ARGUMENTS");
    if (k === "--apply") out[k] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("INVALID_ARGUMENTS"); out[k] = argv[++i]; }
  }
  const steps = ["inspect", "request", "verify-identity", "validate-contract", "review-policy", "approve-dataset", "certify-staging", "approve"];
  if (!out["--decision"] || !steps.includes(out["--step"])) throw new Error("DECISION_AND_STEP_REQUIRED");
  if (!["request"].includes(out["--step"]) && !/^[0-9a-f-]{36}$/.test(out["--id"] || "")) throw new Error("REGISTRATION_ID_REQUIRED");
  if (["verify-identity", "validate-contract", "review-policy", "certify-staging", "approve"].includes(out["--step"]) && (!/^[1-9][0-9]{0,8}$/.test(out["--expected-revision"] || ""))) throw new Error("EXPECTED_REVISION_REQUIRED");
  if (["review-policy", "certify-staging"].includes(out["--step"]) && !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/.test(out["--evidence-ref"] || "")) throw new Error("EVIDENCE_REF_REQUIRED");
  if (out["--step"] === "approve-dataset" && (out["--dataset"] !== "karryam.support_operations" && out["--dataset"] !== "karryam.sync_health" || out["--version"] !== "1.0.0")) throw new Error("DATASET_NOT_ALLOWED");
  return out;
}

async function run(argv = process.argv.slice(2), env = process.env) {
  const args = options(argv);
  if (env.PIC_ENVIRONMENT !== "staging" || env.PIC_EXPECT_ENVIRONMENT !== "staging") throw new Error("OPERATOR_STAGING_ONLY");
  const permit = loadOperatorPermit(args["--decision"], { environment: "staging" });
  const config = loadConfig(env);
  if (!config.enabled || config.environment !== "staging") throw new Error("STAGING_PIC_CONFIGURATION_REQUIRED");
  const registration = { product_id: "karryam", display_name: "Karryam", service_instance_id: "karryam-admin-staging-1", environment: "staging", endpoint_ref: "karryam-staging", workload_identity: "cf://staging/product-admin/karryam", approved_signer_kid: "karryam-staging-manifest-2026-11", allowed_scope: permit.decision.allowed_scope };
  const plan = { event: "staging_operator_onboarding", step: args["--step"], product_id: "karryam", actor_type: "OPERATOR", actor_id: "operator:" + permit.decision.operator, decision_ref: permit.decision.decision_id, apply: args["--apply"] === true };
  if (!args["--apply"]) { console.log(JSON.stringify({ ...plan, registration: args["--step"] === "request" ? registration : undefined, state: "DRY_RUN_NO_DATABASE_ACCESS" })); return; }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: config.databaseUrl, application_name: "pic-staging-operator-onboarding", max: 1, connectionTimeoutMillis: 5000 });
  try {
    const workflow = createOnboarding({ pool, endpoints: config.endpoints, trustStore: config.trustStore, environment: "staging", operatorPermit: permit });
    const subject = { staffId: plan.actor_id }; // Explicit operator, no staff session/MFA claims.
    const ctx = { correlationId: randomUUID() };
    const payload = { expected_revision: Number(args["--expected-revision"]), evidence_ref: args["--evidence-ref"] };
    const methods = { "verify-identity": "verifyIdentity", "validate-contract": "validateContract", "review-policy": "reviewPolicy", "certify-staging": "certifyStaging", approve: "approve" };
    let result;
    if (args["--step"] === "request") result = await workflow.request(subject, registration, ctx);
    else if (args["--step"] === "inspect") { const detail = await workflow.get(subject, args["--id"], ctx); result = detail.registration; }
    else if (args["--step"] === "approve-dataset") result = await workflow.approveDataset(subject, args["--id"], args["--dataset"], { version: args["--version"], decision: "APPROVE" }, ctx);
    else result = await workflow[methods[args["--step"]]](subject, args["--id"], payload, ctx);
    console.log(JSON.stringify({ ...plan, registration_id: result.id || args["--id"], lifecycle_status: result.lifecycle_status, revision: result.revision, approval_status: result.approval_status }));
  } finally { await pool.end(); }
}
if (require.main === module) run().catch((err) => { console.error(JSON.stringify({ event: "staging_operator_onboarding_failed", reason: /^[A-Z0-9_]+$/.test(err.reason || err.message || "") ? err.reason || err.message : "OPERATOR_SETUP_FAILED" })); process.exitCode = 1; });
module.exports = { options, run };
