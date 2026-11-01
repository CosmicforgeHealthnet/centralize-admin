#!/usr/bin/env node
// Section 14: evidence-based final WP/DoD/release closure. Never promotes code
// certification or disposable test results to real staging acceptance.
// Consumes the Section 13.3 gate artifact for the SAME SHA.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORK_PACKAGES = [
  { id: "WP0", name: "Freeze and compatibility", gates: [1,2,6], paths: ["services/karryam-admin/src/bridge/contracts/karrygo-backoffice-v1.json","infrastructure/scripts/product-admin-contract-audit.mjs"] },
  { id: "WP1", name: "Universal protocols", gates: [9], paths: ["packages/admin-contracts","packages/event-contracts","packages/service-clients","packages/identity-and-permissions"] },
  { id: "WP2", name: "HQ registry and DB", gates: [9], paths: ["services/product-integration-core/src/onboarding/service.js","services/product-integration-core/migrations/001_product_admin_registry.sql"] },
  { id: "WP3", name: "Karryam runtime", gates: [3,4], paths: ["services/karryam-admin/migrations/001_karryam_admin_foundation.sql","services/karryam-admin/src/protocol/manifest.js"] },
  { id: "WP4", name: "Bridge authentication client", gates: [5], paths: ["services/karryam-admin/src/bridge/client/signing.js","services/karryam-admin/src/bridge/client/index.js"] },
  { id: "WP5", name: "Capability and resource readers", gates: [6,10], paths: ["services/karryam-admin/src/modules/reads.js","services/karryam-admin/src/bridge/contracts/karrygo-capabilities.v1.json"] },
  { id: "WP6", name: "Karryam event processor", gates: [8], paths: ["services/karryam-admin/src/sync/bridge-consumer.js","services/karryam-admin/src/worker/index.js"] },
  { id: "WP7", name: "HQ generic sync workers", gates: [8,9], paths: ["services/product-integration-core/src/sync/engine.js","services/product-integration-core/src/projections/metrics.js"] },
  { id: "WP8", name: "Shared departments and metrics", gates: [10,13], paths: ["services/karryam-admin/src/modules/reports.js","services/central-admin-api/src/modules/product-gateway/routes.js"] },
  { id: "WP9", name: "Commands and governance", gates: [11], paths: ["services/karryam-admin/src/operations/service.js","services/karryam-admin/scripts/high-risk-certification.js"] },
  { id: "WP10", name: "Single-VPS staging", gates: [3,4,5,7,12,14], paths: ["infrastructure/product-admin/staging/docker-compose.yml",".github/workflows/product-admin-staging-ops.yml"] },
  { id: "WP11", name: "Release certification", gates: [8,9,10,11,12,13], paths: ["infrastructure/scripts/product-admin-staging-gates.mjs","services/product-integration-core/tests/journeys-postgres.test.js"] }
];
export const BACKEND_DOD = [
  { id: "B1", name: "Independent typed Karryam Admin APIs", gates: [10] },
  { id: "B2", name: "Independent durable administrative store", gates: [3,7] },
  { id: "B3", name: "Only the secured Bridge reaches operations", gates: [4,5] },
  { id: "B4", name: "Durable event consumption and reconciliation", gates: [8] },
  { id: "B5", name: "Universal Product Admin Protocol exposed to HQ", gates: [9] },
  { id: "B6", name: "Authorized module reads and governed owner actions", gates: [10,11] },
  { id: "B7", name: "Live staging security, network, audit and CI certification", gates: [3,4,5,6,7,8,10,11,12] },
  { id: "B8", name: "Operates while Headquarters is unavailable", gates: [8] }
];
export const HQ_DOD = [
  { id: "H1", name: "Register new product with independent identity/manifest", gates: [5,9] },
  { id: "H2", name: "Explicit approved datasets and scoped grants", gates: [9,10] },
  { id: "H3", name: "Ingest events and metrics with provenance", gates: [8,9] },
  { id: "H4", name: "Generic dashboards and scoped data", gates: [10,13] },
  { id: "H5", name: "Sync health and alerts", gates: [12] },
  { id: "H6", name: "Suspend/revoke and recover/backfill", gates: [8,9] },
  { id: "H7", name: "Synthetic third product without hardcoded HQ logic", gates: [9] }
];
const STAGES = [
  { id:"A", name:"Staging release A — WP0-WP4", wp:["WP0","WP1","WP2","WP3","WP4"] },
  { id:"B", name:"Staging release B — WP5-WP8", wp:["WP5","WP6","WP7","WP8"] },
  { id:"C", name:"Staging release C — WP9-WP11", wp:["WP9","WP10","WP11"] }
];
function statusFor(ids, byId) {
  const a=ids.map(id=>byId.get(id)?.status || "NOT_RUN");
  if(a.includes("FAIL")) return "FAIL";
  if(a.includes("NOT_RUN")) return "NOT_RUN";
  return a.includes("PENDING_EXTERNAL") ? "PENDING_EXTERNAL" : "PASS";
}
export function evaluate({sha, gatesReport, missingFiles=[]}) {
  const now=new Date().toISOString();
  const gates=gatesReport?.gates;
  const unique=Array.isArray(gates) ? new Map(gates.map(g=>[g.id,g])) : new Map();
  const valid=Boolean(gatesReport && gatesReport.sha===sha &&
    Array.isArray(gates) && gates.length===14 && unique.size===14 &&
    Array.from({length:14},(_,i)=>i+1).every(i=>unique.has(i)) &&
    gates.every(g=>["PASS","FAIL","PENDING_EXTERNAL","NOT_RUN"].includes(g.status)));
  const status=(ids)=>valid ? statusFor(ids,unique) : "NOT_RUN";
  const missing=new Set(missingFiles);
  const work_packages=WORK_PACKAGES.map(w=>{
    const missing_paths=w.paths.filter(p=>missing.has(p));
    const evidence_status=status(w.gates);
    return {id:w.id,name:w.name,evidence_status,
      code_status:missing_paths.length || evidence_status==="FAIL" ? "BLOCKED" :
        evidence_status==="NOT_RUN" ? "NOT_RUN" : "SUPPORTED_BY_CI",
      required_gates:w.gates,source_paths:w.paths,missing_paths,
      live_status:evidence_status==="PASS" ? "PASS" : evidence_status};
  });
  const backend_dod=BACKEND_DOD.map(d=>({...d,status:status(d.gates)}));
  const hq_dod=HQ_DOD.map(d=>({...d,status:status(d.gates)}));
  const releases=STAGES.map(s=>{
    const w=work_packages.filter(x=>s.wp.includes(x.id));
    const a=w.map(x=>x.live_status);
    return {id:s.id,name:s.name,work_packages:s.wp,status:a.includes("FAIL")?"FAIL":a.includes("NOT_RUN")?"NOT_RUN":a.includes("PENDING_EXTERNAL")?"PENDING_EXTERNAL":"PASS"};
  });
  const code_ok=valid && work_packages.every(w=>w.code_status==="SUPPORTED_BY_CI") &&
    backend_dod.every(d=>!["FAIL","NOT_RUN"].includes(d.status)) &&
    hq_dod.every(d=>!["FAIL","NOT_RUN"].includes(d.status));
  const all_live=code_ok && gates.every(g=>g.status==="PASS");
  const result=!code_ok ? "EVIDENCE_INCOMPLETE_OR_FAILED" :
    all_live ? "STAGING_GATES_PASSED_SIGNOFF_PENDING" : "CODE_ACCEPTED_STAGING_PENDING";
  return {report:"product-admin-section14-closure",schema_version:1,sha,generated_at:now,
    source_gate_result:gatesReport?.result || null,valid_gate_evidence:valid,
    result,code_accepted:code_ok,all_staging_gates_passed:all_live,
    owner_signed_go_no_go_verified:false,production_promotion:"NO_GO",
    reason:!valid?"Missing, stale or malformed Section 13.3 gate evidence":
      !code_ok?"At least one implementation or evidence gate failed or was not run":
      !all_live?"Real staging certification remains pending for one or more gates":
      "All 14 gates passed, but an independent owner-signed release decision is still required",
    work_packages,backend_dod,hq_dod,releases,
    external_prerequisites:[
      "Protected product-admin-staging GitHub environment with authorized reviewers and dedicated VPS secrets",
      "Operator-provisioned databases/roles, backup and actual migrations on staging",
      "Real private Bridge identity enrollment, approved owner policies, source network proof",
      "Real S3-S7 pilot, resource and approved command certification, monitoring and restore evidence",
      "Owner-approved legacy dispatch mapping, parity and observation window",
      "Independent signed go/no-go for any main/production promotion"
    ]};
}
export function markdown(r){
  const rows=(arr)=>arr.map(w=>"| "+w.id+" | "+w.name+" | **"+(w.code_status||w.status)+"** | "+(w.live_status||w.status)+" |").join("\n");
  return ["# Section 14 closure — "+r.result,"","Commit: "+r.sha+". Source gates: "+(r.source_gate_result||"missing")+".","",
    "Production promotion: **"+r.production_promotion+"**. Signed owner decision verified: **NO**.","",
    "## WP0–WP11","| WP | Engineering deliverable | Code evidence | Live certification |","|---|---|---|---|",rows(r.work_packages),"",
    "## Karryam backend DoD (14.1)","| # | Requirement | Evidence status | Status |","|---|---|---|---|",rows(r.backend_dod),"",
    "## HQ universal DoD (14.2)","| # | Requirement | Evidence status | Status |","|---|---|---|---|",rows(r.hq_dod),"",
    "## Release groups (14.3)","| Release | Scope | Evidence status | Live status |","|---|---|---|---|",rows(r.releases),"",
    "## Required external evidence",...r.external_prerequisites.map(x=>"- "+x),"",
    "This evaluator does not approve promotions or accept disposable test artifacts as live staging certification.",""].join("\n");
}
function arg(name){const i=process.argv.indexOf("--"+name);return i<0?null:process.argv[i+1];}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const sha=arg("sha"),gateFile=arg("gates");
  if(!sha || !/^[a-f0-9]{40}$/.test(sha) || !gateFile){console.error("required: --sha FULL_SHA --gates PATH [--report PATH] [--markdown PATH]");process.exit(2);}
  let gateData=null;
  try{gateData=JSON.parse(fs.readFileSync(gateFile,"utf8"));}catch{}
  const missingFiles=WORK_PACKAGES.flatMap(w=>w.paths).filter(p=>!fs.existsSync(path.join(ROOT,p)));
  const r=evaluate({sha,gatesReport:gateData,missingFiles});
  for(const [flag,contents] of [["report",JSON.stringify(r,null,2)],["markdown",markdown(r)]]){
    const file=arg(flag);if(file){fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,contents+"\n");}
  }
  process.stdout.write(markdown(r));
  process.exit(r.code_accepted?0:1);
}
