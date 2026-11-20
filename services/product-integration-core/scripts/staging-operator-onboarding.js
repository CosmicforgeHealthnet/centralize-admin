"use strict";

// No HTTP endpoint, bearer token, staff identity or invented MFA proof.
// Runs only as root with a protected owner-signed staging delegation.
//
// --product selects one reviewed staging registration below (default
// karryam, unchanged). The signed decision and the root-pinned authority must
// name that same product and exactly the scope approved for it; nothing here
// widens what a signed operator decision may do.
const { randomUUID } = require("node:crypto");
const { loadConfig } = require("../src/config");
const { loadOperatorPermit, equalScope } = require("../src/onboarding/operator");
const { createOnboarding } = require("../src/onboarding/service");

const SCOPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PRODUCTS = Object.freeze({
  karryam: Object.freeze({
    registration: Object.freeze({ product_id: "karryam", display_name: "Karryam", service_instance_id: "karryam-admin-staging-1", environment: "staging", endpoint_ref: "karryam-staging", workload_identity: "cf://staging/product-admin/karryam", approved_signer_kid: "karryam-staging-manifest-2026-11" }),
    dataset: /^karryam\.(support_operations|sync_health|verification_pipeline|marketing_campaigns)$/,
    // Read-only datasets an operator may approve/subscribe without a per-decision dataset pin.
    defaultDatasets: Object.freeze(["karryam.support_operations", "karryam.sync_health"]),
    scopeInput: false,
    approvedScope: () => ({ market: ["NG-LAG"], organization: ["karryam-staging"], zone: ["NG-LAG-MAIN"], tenant: ["karryam-staging-operations"] }),
  }),
  // docs/product-admin/cfmeet-admin-design.md sections 2 and 8. The operator
  // names the zone and CF Meet tenant; both must equal the signed scope. The
  // tenant is the Platform Access tenant UUID (canonical lowercase), never a
  // slug: the CF Meet Bridge passes it to owners as tenantId.
  // No dataset is approved by default: each must be pinned in the signed
  // decision and the root-owned authority entry.
  cfmeet: Object.freeze({
    registration: Object.freeze({ product_id: "cfmeet", display_name: "CF Meet", service_instance_id: "cfmeet-admin-staging-1", environment: "staging", endpoint_ref: "cfmeet-staging", workload_identity: "cf://staging/product-admin/cfmeet", approved_signer_kid: "cfmeet-staging-manifest-2026-11" }),
    dataset: /^cfmeet\.[a-z][a-z0-9_]{1,63}$/,
    defaultDatasets: Object.freeze([]),
    scopeInput: true,
    zones: Object.freeze(["production", "sandbox"]),
    tenant: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    approvedScope: (args) => ({ market: ["GLOBAL"], organization: ["cfmeet"], zone: [args["--zone"]], tenant: [args["--tenant"]] }),
  }),
});

function options(argv) {
  const allowed = new Set(["--decision", "--step", "--id", "--expected-revision", "--evidence-ref", "--dataset", "--version", "--contract", "--apply", "--product", "--zone", "--tenant"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!allowed.has(k) || Object.hasOwn(out, k)) throw new Error("INVALID_ARGUMENTS");
    if (k === "--apply") out[k] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("INVALID_ARGUMENTS"); out[k] = argv[++i]; }
  }
  const steps = ["inspect", "request", "verify-identity", "validate-contract", "review-policy", "approve-dataset", "certify-staging", "approve", "subscribe", "propose-contract", "certify-contract", "activate-contract"];
  if (!out["--decision"] || !steps.includes(out["--step"])) throw new Error("DECISION_AND_STEP_REQUIRED");
  const product = Object.hasOwn(PRODUCTS, out["--product"] || "karryam") ? PRODUCTS[out["--product"] || "karryam"] : null;
  if (!product) throw new Error("PRODUCT_NOT_SUPPORTED");
  if (!product.scopeInput && (Object.hasOwn(out, "--zone") || Object.hasOwn(out, "--tenant"))) throw new Error("INVALID_ARGUMENTS");
  if (product.scopeInput && (!product.zones.includes(out["--zone"]) || !SCOPE_VALUE.test(out["--tenant"] || "") || (product.tenant && !product.tenant.test(out["--tenant"])))) throw new Error("PRODUCT_SCOPE_REQUIRED");
  if (!["request"].includes(out["--step"]) && !/^[0-9a-f-]{36}$/.test(out["--id"] || "")) throw new Error("REGISTRATION_ID_REQUIRED");
  if (["verify-identity", "validate-contract", "review-policy", "certify-staging", "approve", "activate-contract"].includes(out["--step"]) && (!/^[1-9][0-9]{0,8}$/.test(out["--expected-revision"] || ""))) throw new Error("EXPECTED_REVISION_REQUIRED");
  if (["review-policy", "certify-staging", "certify-contract"].includes(out["--step"]) && !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/.test(out["--evidence-ref"] || "")) throw new Error("EVIDENCE_REF_REQUIRED");
  if (["approve-dataset", "subscribe"].includes(out["--step"]) && (!product.dataset.test(out["--dataset"] || "") || out["--version"] !== "1.0.0")) throw new Error("DATASET_NOT_ALLOWED");
  if (["certify-contract", "activate-contract"].includes(out["--step"]) && !/^[0-9a-f-]{36}$/.test(out["--contract"] || "")) throw new Error("CONTRACT_ID_REQUIRED");
  return out;
}

// Pure checks of one verified permit against the selected product: the
// signed product and scope must equal the reviewed registration exactly.
function planFor(args, permit) {
  const id = args["--product"] || "karryam";
  const product = Object.hasOwn(PRODUCTS, id) ? PRODUCTS[id] : null;
  if (!product) throw new Error("PRODUCT_NOT_SUPPORTED");
  if (permit.decision.product_id !== product.registration.product_id || !equalScope(permit.decision.allowed_scope, product.approvedScope(args))) throw new Error("OPERATOR_SCOPE_DENIED");
  if (["propose-contract", "certify-contract", "activate-contract"].includes(args["--step"]) && !permit.decision.readonly_catalog_activation) throw new Error("OPERATOR_CATALOG_NOT_DELEGATED");
  if (["approve-dataset", "subscribe"].includes(args["--step"]) && !product.defaultDatasets.includes(args["--dataset"]) && !(permit.decision.readonly_catalog_activation?.dataset_ids || permit.decision.readonly_subscription_datasets || []).includes(args["--dataset"])) throw new Error("OPERATOR_DATASET_SCOPE_DENIED");
  const registration = { ...product.registration, allowed_scope: permit.decision.allowed_scope };
  const plan = { event: "staging_operator_onboarding", step: args["--step"], product_id: product.registration.product_id, actor_type: "OPERATOR", actor_id: "operator:" + permit.decision.operator, decision_ref: permit.decision.decision_id, apply: args["--apply"] === true };
  return { registration, plan };
}

async function run(argv = process.argv.slice(2), env = process.env) {
  const args = options(argv);
  if (env.PIC_ENVIRONMENT !== "staging" || env.PIC_EXPECT_ENVIRONMENT !== "staging") throw new Error("OPERATOR_STAGING_ONLY");
  const permit = loadOperatorPermit(args["--decision"], { environment: "staging" });
  const { registration, plan } = planFor(args, permit);
  const config = loadConfig(env);
  if (!config.enabled || config.environment !== "staging") throw new Error("STAGING_PIC_CONFIGURATION_REQUIRED");
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
    else if (args["--step"] === "subscribe") {
      if (!workflow.createSubscription) throw new Error("OPERATOR_SUBSCRIPTION_NOT_DELEGATED");
      result = await workflow.createSubscription(subject,args["--id"],{dataset_id:args["--dataset"],version:args["--version"],consumer_department:permit.decision.readonly_subscription_department,allowed_scope:permit.decision.allowed_scope,enabled:true},ctx);
    }
    else if (args["--step"] === "propose-contract") result = await workflow.proposeContractRevision(subject, args["--id"], ctx);
    else if (args["--step"] === "certify-contract") result = await workflow.certifyContract(subject, args["--id"], args["--contract"], payload, ctx);
    else if (args["--step"] === "activate-contract") result = await workflow.activateContract(subject, args["--id"], args["--contract"], payload, ctx);
    else if (args["--step"] === "approve-dataset") result = await workflow.approveDataset(subject, args["--id"], args["--dataset"], { version: args["--version"], decision: "APPROVE" }, ctx);
    else result = await workflow[methods[args["--step"]]](subject, args["--id"], payload, ctx);
    console.log(JSON.stringify({ ...plan, registration_id: result.id || args["--id"], lifecycle_status: result.lifecycle_status, revision: result.revision, approval_status: result.approval_status, subscription_id: result.subscription_id, contract_id: result.contract_id }));
  } finally { await pool.end(); }
}
if (require.main === module) run().catch((err) => { console.error(JSON.stringify({ event: "staging_operator_onboarding_failed", reason: /^[A-Z0-9_]+$/.test(err.reason || err.message || "") ? err.reason || err.message : "OPERATOR_SETUP_FAILED" })); process.exitCode = 1; });
module.exports = { options, planFor, run, PRODUCTS };
