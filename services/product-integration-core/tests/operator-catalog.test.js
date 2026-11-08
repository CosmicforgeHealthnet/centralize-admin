"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign, randomUUID } = require("node:crypto");
const C = require("../../../packages/admin-contracts");
const O = require("../src/onboarding/operator");
const scope = {market:["NG-LAG"],organization:["karryam-staging"],zone:["NG-LAG-MAIN"],tenant:["karryam-staging-operations"]};
function catalogs() {
  const ids=["karryam.verification_pipeline","karryam.marketing_campaigns"];
  const datasets=ids.map((id,i)=>require("../../../packages/admin-contracts/src/testing").sampleDataset({dataset_id:id,schema_id:id,authorized_departments:[i?"marketing":"operations"],scope_dimensions:Object.keys(scope),readiness:"NOT_CERTIFIED",blockers:[{code:"STAGING_CERTIFICATION_PENDING",detail:"Pending source evidence"}]}));
  const base={product_id:"karryam",protocol:{major:1,minor:0},capabilities:[],datasets,event_families:ids.map(id=>C.standardMetricObservationFamily({family:id+".metric_observation",datasetId:id,status:"NOT_CERTIFIED"}))};
  const target=JSON.parse(JSON.stringify(base));
  target.datasets.forEach(d=>{d.readiness="CERTIFIED_BY_PRODUCT";d.blockers=[];});target.event_families.forEach(f=>{f.status="ACTIVE";});
  return {base,target,pin:{base_digest:C.catalogDigest(base),target_digest:C.catalogDigest(target),dataset_ids:ids}};
}
function signedFixture(pin, extra={}) {
 const now=Date.now(),key=generateKeyPairSync("ed25519");
 const document={schema_version:1,decision_id:"catalog-test",operator:"root@staging-host",owner_delegation_ref:"owner-test",environment:"staging",product_id:"karryam",allowed_scope:scope,issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+600000).toISOString(),allow_setup_without_staff_sessions:true,allow_single_operator_onboarding:true,readonly_catalog_activation:pin,...extra};
 const entry={purpose:"OWNER_DELEGATION",environment:"staging",product_id:"karryam",allowed_scope:scope,not_after:new Date(now+3600000).toISOString(),revoked:false,public_key_pem:key.publicKey.export({type:"spki",format:"pem"}),readonly_catalog_activation:pin,...extra};
 const envelope={document,key_id:"catalog-test-key",signature:sign(null,Buffer.from(O.DOMAIN+O.canonical(document)),key.privateKey).toString("base64url")};
 return {now,key,document,entry,envelope,trust:{keys:{"catalog-test-key":entry}}};
}
test("readiness activation needs independently pinned exact catalogs and one-hour delegation",()=>{
 const {base,target,pin}=catalogs(),f=signedFixture(pin);const opts={environment:"staging",operator:f.document.operator,now:f.now};
 const d=O.parseSignedDecision(JSON.stringify(f.envelope),f.trust,opts);assert.equal(O.assertReadonlyCatalogChange(d,base,target),true);
 const missing=JSON.parse(JSON.stringify(f.trust));delete missing.keys["catalog-test-key"].readonly_catalog_activation;
 assert.throws(()=>O.parseSignedDecision(JSON.stringify(f.envelope),missing,opts),/CATALOG_SCOPE_DENIED/);
 const wrong=JSON.parse(JSON.stringify(f.trust));wrong.keys["catalog-test-key"].readonly_catalog_activation.target_digest="sha256:"+"0".repeat(64);
 assert.throws(()=>O.parseSignedDecision(JSON.stringify(f.envelope),wrong,opts),/CATALOG_SCOPE_DENIED/);
 assert.throws(()=>O.parseSignedDecision(JSON.stringify(f.envelope),f.trust,{...opts,environment:"production"}),/STAGING_ONLY/);
 assert.throws(()=>O.parseSignedDecision(JSON.stringify(f.envelope),f.trust,{...opts,now:f.now+7200000}),/SIGNER_NOT_TRUSTED|EXPIRED/);
});
test("even pinned catalogs cannot change data fields, departments, scope, retention or commands",()=>{
 const {base,target,pin}=catalogs();
 for(const change of [x=>x.datasets[0].authorized_departments.push("finance"),x=>x.datasets[0].scope_dimensions.push("region"),x=>x.datasets[0].retention_days++,x=>x.datasets[0].allowed_fields.push({name:"phone"}),x=>x.capabilities.push({id:"write",state:"ENABLED"}),x=>x.event_families[0].projection="RAW_RECORD",x=>x.datasets[1].readiness="NOT_CERTIFIED"]){
  const altered=JSON.parse(JSON.stringify(target));change(altered);const d={product_id:"karryam",readonly_catalog_activation:{...pin,target_digest:C.catalogDigest(altered)}};
  assert.throws(()=>O.assertReadonlyCatalogChange(d,base,altered),/CATALOG_CHANGE_DENIED/);
 }
 assert.throws(()=>O.assertReadonlyCatalogChange({product_id:"karryam",readonly_catalog_activation:pin},{...base,product_id:"other"},target),/CATALOG_SCOPE_DENIED/);
 assert.throws(()=>O.assertReadonlyCatalogChange({product_id:"karryam",readonly_catalog_activation:pin},target,target),/CATALOG_SCOPE_DENIED/);
});
test("catalog delegation rejects extra fields, duplicate IDs, other products and identical digests",()=>{
 const {pin}=catalogs();
 for(const change of [{extra:true},{dataset_ids:[]},{dataset_ids:[pin.dataset_ids[0],pin.dataset_ids[0]]},{dataset_ids:["other.data"]},{dataset_ids:["karryam.a","karryam.b","karryam.c"]},{target_digest:pin.base_digest}]){
  const f=signedFixture({...pin,...change});assert.throws(()=>O.parseSignedDecision(JSON.stringify(f.envelope),f.trust,{environment:"staging",operator:f.document.operator,now:f.now}),/CATALOG_SCOPE_DENIED/);
 }
});
test("root sandbox: native certification, activation and approval use current catalog without staff impersonation",{skip:process.env.PIC_OPERATOR_TEST_SANDBOX!=="1"},async t=>{
 const fs=require("node:fs"),os=require("node:os"),DB=require("./helpers/db"),{createOnboarding}=require("../src/onboarding/service");assert.equal(process.getuid(),0);assert.ok(DB.available());
 const {base,target,pin}=catalogs(),extra={allow_scoped_readonly_subscriptions:true,readonly_subscription_datasets:[pin.dataset_ids[0]],readonly_subscription_department:"operations"},f=signedFixture(pin,extra);
 f.document.operator="root@"+os.hostname();f.envelope.document=f.document;f.envelope.signature=sign(null,Buffer.from(O.DOMAIN+O.canonical(f.document)),f.key.privateKey).toString("base64url");
 const dir="/etc/cosmicforge/staging/catalog-test-"+randomUUID(),trustFile="/etc/cosmicforge/staging/secrets/pic-operator-authority/public-keys.json";
 fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(require("node:path").dirname(trustFile),{recursive:true,mode:0o700});const prior=fs.existsSync(trustFile)?fs.readFileSync(trustFile):null;
 fs.writeFileSync(trustFile,JSON.stringify(f.trust),{mode:0o600});const file=dir+"/decision.json";fs.writeFileSync(file,JSON.stringify(f.envelope),{mode:0o600});
 t.after(()=>{if(prior)fs.writeFileSync(trustFile,prior);else fs.unlinkSync(trustFile);fs.rmSync(dir,{recursive:true,force:true});});
 const db=await DB.createDisposableDatabase();t.after(()=>db.drop());const id=randomUUID(),oldId=randomUUID(),newId=randomUUID(),actor="operator:"+f.document.operator;
 await db.migClient.query(`INSERT INTO hq_integration.hq_product_admins(id,product_id,display_name,service_instance_id,environment,endpoint_ref,workload_identity,approved_signer_kid,allowed_scope,lifecycle_status,requested_by) VALUES($1,'karryam','Fixture','catalog-fixture','staging','fixture','cf://staging/product-admin/karryam','fixture',$2,'DRAFT','fixture-requester')`,[id,JSON.stringify(scope)]);
 const comparison=C.compareCatalogs(base,target);assert.equal(comparison.decision,"COMPATIBLE_ADDITIVE");
 for(const [contractId,catalog,status,validator,certifier,revision] of [[oldId,base,"ACTIVE","fixture-reviewer","fixture-approver",1],[newId,target,"VALIDATED",actor,null,2]]){
  await db.migClient.query(`INSERT INTO hq_integration.hq_product_admin_contracts(id,product_admin_id,revision,protocol_major,protocol_minor,manifest_revision,manifest_digest,catalog_digest,build_sha,catalog,compatibility,status,validated_by,certified_by,certified_at,activated_at) VALUES($1,$2,$3,1,0,$3,$4,$4,'abcdef1',$5,$6,$7,$8,$9,$10,$10)`,[contractId,id,revision,C.catalogDigest(catalog),JSON.stringify(catalog),JSON.stringify(comparison),status,validator,certifier,certifier?new Date():null]);
 }
 await db.migClient.query(`UPDATE hq_integration.hq_product_admins SET lifecycle_status='ENABLED',revision=2,current_contract_id=$2,activated_at=now(),activated_by='fixture-approver',identity_verified_at=now(),manifest_expires_at=now()+interval '1 hour' WHERE id=$1`,[id,oldId]);
 for(const ds of base.datasets) await db.migClient.query(`INSERT INTO hq_integration.hq_product_admin_datasets(id,product_admin_id,contract_id,dataset_id,version,schema_id,schema_digest,privacy_class,scope_dimensions,authorized_departments,semantic_grain,units,currency,freshness_target_seconds,lineage,allowed_fields,metrics,retention_days,approval_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'PROPOSED')`,[randomUUID(),id,oldId,ds.dataset_id,ds.version,ds.schema_id,ds.schema_digest,ds.privacy_class,ds.scope_dimensions,ds.authorized_departments,ds.semantic_grain,ds.units,ds.currency,ds.freshness_target_seconds,JSON.stringify(ds.lineage),JSON.stringify(ds.allowed_fields),JSON.stringify(ds.metrics),ds.retention_days]);
 const permit=O.loadOperatorPermit(file,{environment:"staging"});assert.ok(Object.isFrozen(permit.decision.readonly_catalog_activation.dataset_ids));const workflow=createOnboarding({pool:db.pool,endpoints:new Map(),trustStore:{},environment:"staging",operatorPermit:permit});const subject={staffId:actor},ctx={correlationId:randomUUID()},input={version:"1.0.0",decision:"APPROVE"};
 await assert.rejects(workflow.approveDataset(subject,id,pin.dataset_ids[0],input,ctx),/NOT_CERTIFIED_BY_PRODUCT/);
 assert.throws(()=>workflow.approveDataset(subject,id,"karryam.unapproved",input,ctx),/DATASET_SCOPE_DENIED/);
 await workflow.certifyContract(subject,id,newId,{evidence_ref:"test:verified-readonly-source"},ctx);
 await workflow.activateContract(subject,id,newId,{expected_revision:2},ctx);
 const approved=await workflow.approveDataset(subject,id,pin.dataset_ids[0],input,ctx);assert.equal(approved.approval_status,"APPROVED");
 const ds=await db.pool.query(`SELECT contract_id FROM hq_integration.hq_product_admin_datasets WHERE id=$1`,[approved.dataset_row_id]);assert.equal(ds.rows[0].contract_id,oldId); // regression: source pointer remains old, active readiness must win
 const subscription=await workflow.createSubscription(subject,id,{dataset_id:pin.dataset_ids[0],version:"1.0.0",consumer_department:"operations",allowed_scope:scope,enabled:true},ctx);assert.match(subscription.subscription_id,/^[0-9a-f-]{36}$/);
 assert.equal(workflow.grant,undefined);assert.equal(workflow.setOperations,undefined);
 const audits=await db.pool.query(`SELECT actor_type,metadata FROM hq_integration.hq_product_admin_security_audit WHERE actor_id=$1`,[actor]);assert.ok(audits.rows.every(r=>r.actor_type==="OPERATOR"&&(r.metadata.staff_session_used===false || r.metadata.independence_exception===true)));
 await assert.rejects(workflow.activateContract(subject,id,newId,{expected_revision:3},ctx),/CONTRACT_NOT_CERTIFIED/);
 f.trust.keys["catalog-test-key"].revoked=true;fs.writeFileSync(trustFile,JSON.stringify(f.trust));await assert.rejects(workflow.get(subject,id,ctx),/OPERATOR_NOT_AUTHORIZED/);
});
