"use strict";
// Root-operated first read grant, using the migration credential and an
// atomic OPERATOR audit. No staff login, MFA assertion or write grant is made.
const os=require("node:os");
const {randomUUID}=require("node:crypto");
const I=require("../../../packages/identity-and-permissions");
const ACTIONS=Object.freeze(["product.view","product.manifest.read","dataset.list","metric.read","events.status.read"]);
function validate(input,now=Date.now()) {
  const g={id:randomUUID(),grant_kind:"PRODUCT",product_id:input.product,staff_id:input.staff,role:input.product+".operations.viewer",effect:"ALLOW",actions:[...ACTIONS],datasets:input.datasets,scope:input.scope,expires_at:input.expires,revoked_at:null};
  if(I.grantErrors(g).length || !Array.isArray(g.datasets) || g.datasets.length<1 || g.datasets.length>2 || new Set(g.datasets).size!==g.datasets.length || g.datasets.some(d=>!d.startsWith(g.product_id+".")) || Object.keys(g.scope||{}).sort().join(",")!=="market,organization,tenant,zone" || Object.values(g.scope).some(v=>v.length!==1) || !(Date.parse(g.expires_at)>now && Date.parse(g.expires_at)<=now+72*3600000)) throw new Error("READ_BOOTSTRAP_INPUT_INVALID");
  return g;
}
async function run(argv=process.argv.slice(2),env=process.env) {
  if(process.platform!=="linux" || process.getuid()!==0 || env.PIC_ENVIRONMENT!=="staging" || env.PIC_EXPECT_ENVIRONMENT!=="staging") throw new Error("ROOT_STAGING_ONLY");
  const args={};for(let i=0;i<argv.length;i+=2){if(!["--product","--staff","--datasets","--scope","--expires"].includes(argv[i]) || args[argv[i]]!==undefined || !argv[i+1]) throw new Error("ARGUMENTS_INVALID");args[argv[i]]=argv[i+1];}
  const grant=validate({product:args["--product"],staff:args["--staff"],datasets:(args["--datasets"]||"").split(","),scope:JSON.parse(args["--scope"]||"null"),expires:args["--expires"]});
  const operator="root@"+os.hostname();if(grant.staff_id===operator || !env.PIC_MIGRATION_DATABASE_URL) throw new Error("BOOTSTRAP_CONFIGURATION_INVALID");
  const {Client}=require("pg");
  const db=new Client({connectionString:env.PIC_MIGRATION_DATABASE_URL,application_name:"pic-first-product-read-grant"});await db.connect();
  try {
    await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(7340117002)");
    const {rows:[product]}=await db.query("SELECT * FROM hq_integration.hq_product_admins WHERE product_id=$1 AND environment='staging' AND lifecycle_status='ENABLED' FOR UPDATE",[grant.product_id]);
    if(!product || I.DIMENSIONS.some(d=>JSON.stringify(product.allowed_scope[d])!==JSON.stringify(grant.scope[d]))) throw new Error("APPROVED_PRODUCT_SCOPE_REQUIRED");
    const {rows:[existing]}=await db.query("SELECT count(*)::int AS count FROM hq_integration.hq_product_admin_grants WHERE grant_kind='PRODUCT' AND product_id=$1",[grant.product_id]);if(existing.count) throw new Error("FIRST_PRODUCT_GRANT_ONLY");
    const {rows}=await db.query("SELECT d.dataset_id FROM hq_integration.hq_product_admin_datasets d JOIN hq_integration.hq_product_admin_subscriptions s ON s.dataset_row_id=d.id WHERE d.product_admin_id=$1 AND d.dataset_id=ANY($2) AND d.approval_status='APPROVED' AND s.enabled AND s.status='ACTIVE' AND s.consumer_department='operations'",[product.id,grant.datasets]);
    if(new Set(rows.map(r=>r.dataset_id)).size!==grant.datasets.length) throw new Error("ACTIVE_APPROVED_DATASETS_REQUIRED");
    await db.query("INSERT INTO hq_integration.hq_product_admin_grants(id,grant_kind,product_id,staff_id,role,effect,actions,datasets,scope,expires_at,granted_by) VALUES($1,'PRODUCT',$2,$3,$4,'ALLOW',$5,$6,$7,$8,$9)",[grant.id,grant.product_id,grant.staff_id,grant.role,grant.actions,grant.datasets,JSON.stringify(grant.scope),grant.expires_at,"operator:"+operator]);
    await db.query("INSERT INTO hq_integration.hq_product_admin_security_audit(actor_type,actor_id,product_id,action,outcome,metadata) VALUES('OPERATOR',$1,$2,'integration.product_read.bootstrap','RECORDED',$3)",[operator,grant.product_id,JSON.stringify({grant_ref:grant.id,staff_ref:grant.staff_id,actions:grant.actions,datasets:grant.datasets,expires_at:grant.expires_at})]);
    await db.query("COMMIT");console.log(JSON.stringify({event:"first_product_read_grant_bootstrapped",grant_id:grant.id,staff_id:grant.staff_id,datasets:grant.datasets,expires_at:grant.expires_at}));
  } catch(e){await db.query("ROLLBACK").catch(()=>{});throw e;}finally{await db.end();}
}
if(require.main===module)run().catch(e=>{console.error(JSON.stringify({event:"read_bootstrap_failed",reason:/^[A-Z_]+$/.test(e.message)?e.message:e.code||"FAILED"}));process.exitCode=1;});
module.exports={validate,ACTIONS,run};
