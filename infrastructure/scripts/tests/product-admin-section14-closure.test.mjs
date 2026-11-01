import test from "node:test";
import assert from "node:assert/strict";
import {evaluate, WORK_PACKAGES, BACKEND_DOD, HQ_DOD} from "../product-admin-section14-closure.mjs";
const SHA="a".repeat(40);
const PENDING=new Set([3,4,5,6,7,8,10,11,12]);
const gates=(overrides={},sha=SHA)=>({sha,result:"CODE_CERTIFIED_STAGING_PENDING",gates:Array.from({length:14},(_,i)=>({id:i+1,status:overrides[i+1] || (PENDING.has(i+1)?"PENDING_EXTERNAL":"PASS")}))});
test("Section 14 has exactly 12 work packages, eight backend DoD, seven HQ DoD",()=>{
  assert.deepEqual(WORK_PACKAGES.map(w=>w.id),Array.from({length:12},(_,i)=>"WP"+i));
  assert.equal(BACKEND_DOD.length,8);
  assert.equal(HQ_DOD.length,7);
});
test("disposable CI does not certify staging or authorize promotion",()=>{
  const r=evaluate({sha:SHA,gatesReport:gates()});
  assert.equal(r.result,"CODE_ACCEPTED_STAGING_PENDING");
  assert.equal(r.code_accepted,true);
  assert.equal(r.production_promotion,"NO_GO");
  assert.equal(r.all_staging_gates_passed,false);
  assert.equal(r.releases.length,3);
  assert.equal(r.work_packages.length,12);
  assert.equal(r.backend_dod.find(x=>x.id==="B7").status,"PENDING_EXTERNAL");
});
test("missing or wrong commit evidence is not accepted",()=>{
  assert.equal(evaluate({sha:SHA,gatesReport:gates({},"b".repeat(40))}).code_accepted,false);
  assert.equal(evaluate({sha:SHA,gatesReport:{sha:SHA,gates:[]}}).result,"EVIDENCE_INCOMPLETE_OR_FAILED");
  assert.equal(evaluate({sha:SHA,gatesReport:null}).production_promotion,"NO_GO");
});
test("a required implementation path missing blocks closure",()=>{
  const r=evaluate({sha:SHA,gatesReport:gates(),missingFiles:["services/karryam-admin/src/modules/reads.js"]});
  assert.equal(r.code_accepted,false);
  assert.equal(r.work_packages.find(w=>w.id==="WP5").code_status,"BLOCKED");
});
test("failing and not-run gates block code acceptance",()=>{
  assert.equal(evaluate({sha:SHA,gatesReport:gates({9:"FAIL"})}).code_accepted,false);
  const pending=evaluate({sha:SHA,gatesReport:gates({5:"NOT_RUN"})});
  assert.equal(pending.code_accepted,false);
  assert.equal(pending.ci_exit_code,0); // async cross-workflow evidence may be incomplete
  assert.equal(evaluate({sha:SHA,gatesReport:gates({9:"FAIL"})}).ci_exit_code,1);
});
test("all live gates pass still requires an independently verified owner decision",()=>{
  const o=Object.fromEntries([...PENDING].map(x=>[x,"PASS"]));
  const r=evaluate({sha:SHA,gatesReport:gates(o)});
  assert.equal(r.all_staging_gates_passed,true);
  assert.equal(r.result,"STAGING_GATES_PASSED_SIGNOFF_PENDING");
  assert.equal(r.owner_signed_go_no_go_verified,false);
  assert.equal(r.production_promotion,"NO_GO");
});
