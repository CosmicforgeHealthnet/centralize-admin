import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const p=fs.readFileSync(path.join(root,".github/workflows/product-admin-staging-ops.yml"),"utf8");
const original=fs.readFileSync(path.join(root,".github/workflows/staging.yml"),"utf8");
test("reuses the existing staging environment and SSH credentials",()=>{
  assert.match(p,/environment: staging\b/);
  assert.ok(p.includes("VPS_HOST: 173.249.30.55"));
  assert.ok(p.includes("VPS_USER: cf-staging-deploy"));
  assert.ok(p.includes("VPS_KEY: ${{ secrets.STAGING_SSH_KEY }}"));
  assert.ok(!p.includes("secrets.PA_STAGING_VPS_"));
  assert.ok(p.includes("cf-staging-deploy"));
  assert.ok(original.includes("cf-staging-deploy"));
});
test("pins the same client and server SSH fingerprints",()=>{
  for(const fp of ["SHA256:LSVBOgX3GxSbGvrqRUwA/BYxw2zVxdvQUQLnV6ALW+4","SHA256:sHGYhFq6RrV3KXESJX+/+89tEWQaGiSVsdkIXiFR9JQ"]) {assert.ok(p.includes(fp)); assert.ok(original.includes(fp));}
});
test("automatic staging deploy is default; explicit connection-check stays read-only",()=>{
  assert.ok(p.includes("github.event_name == 'push' && github.ref == 'refs/heads/staging'"));
  assert.ok(p.includes('if [[ "$EVENT" == push ]]; then'));
  assert.match(p, /if \[\[ "\$AUTO_DEPLOY" == false \]\]; then op=connection-check; auto=false\s+else op=deploy; auto=true; fi/);
  assert.ok(p.includes('[[ "$AUTO_CFMEET" != false ]] && cfmeet=true'));
  assert.ok(p.includes("sudo -n /usr/local/sbin/cf-product-admin-staging"));
  assert.ok(p.includes("PA_AUTO_DEPLOYMENT"));
  assert.ok(!p.includes('d="/root/.cf-product-admin-staging/$BUNDLE"'));
  assert.ok(!p.includes("  workflow_run:"));
  assert.ok(p.includes('(( ok )) || exit 1'));
  assert.ok(p.includes("options: [connection-check,"));
  assert.ok(p.includes("connection-check|preflight|status"));
  assert.ok(p.includes('if [[ "$OP" != connection-check ]]; then'));
  assert.ok(p.includes("BLOCKED_PRIVILEGED_HOST_OPERATION"));
  assert.ok(p.includes("product-admin-staging-readonly-inventory.json"));
  assert.ok(p.includes("sudo_noninteractive_listing_available"));
  assert.ok(p.includes("private_networks"));
  assert.ok(p.includes("needs.plan.outputs.operation == 'deploy'"));
  assert.ok(p.includes("No unrestricted sudo or runner-uploaded code"));
  assert.ok(!p.includes("environment: product-admin-staging"));
});

test("staging release checks the canonical API CI job, not duplicate backend runs",()=>{
  const legacy=fs.readFileSync(path.join(root,".github/workflows/social-operations-ci.yml"),"utf8");
  assert.ok(!/^      - staging$/m.test(legacy));
  assert.ok(p.includes('select(.path==".github/workflows/staging.yml")'));
  assert.ok(p.includes('select(.name=="Verify Social Operations backend")'));
  assert.ok(p.includes('case "$api_status" in success) ;; missing|pending) pending=1 ;; *) ok=0 ;; esac'));
  assert.ok(original.includes("cache-from: type=gha,scope=ca-staging-api"));
});


test("root capability rejects arbitrary operations, paths, and cross-service images",()=>{
  const helper=path.join(root,"infrastructure/product-admin/release/pa-staging-capability.py");
  const script="import runpy,sys\nv=runpy.run_path(sys.argv[1])['validate']\nd={'op':'deploy','sha':'a'*40,'pic':'ghcr.io/cosmicforgehealthnet/product-integration-core@sha256:'+'b'*64,'karryam':'ghcr.io/cosmicforgehealthnet/karryam-admin@sha256:'+'c'*64,'cfmeet':'','run':'123-1','user':'github-actions[bot]','token':'fixture_only'}\nassert v({'op':'probe'}) == {}\nassert v(d)['PA_CM_BRIDGE_MODE']=='same-host'\nfor bad in [dict(d,op='shell'),dict(d,path='/root'),dict(d,pic=d['karryam']),dict(d,sha='main'),dict(d,run='../../root'),dict(d,token='x\\ny')]:\n try: v(bad)\n except ValueError: continue\n raise AssertionError('invalid request accepted')\n";
  const result=spawnSync("python3",["-I","-c",script,helper],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
});

test("host capability checks CI provenance and immutable root-owned bundle",()=>{
  const helper=fs.readFileSync(path.join(root,"infrastructure/product-admin/release/pa-staging-capability.py"),"utf8");
  assert.ok(helper.includes('record.get("head_branch")!="staging"'));
  assert.ok(helper.includes('record.get("event")!="push"'));
  assert.ok(helper.includes('got!=expected'));
  assert.ok(helper.includes('metadata.get("sha")!=oid'));
  assert.ok(helper.includes('certify(data)'));
  const install=fs.readFileSync(path.join(root,"infrastructure/product-admin/release/install-staging-capability.sh"),"utf8");
  assert.ok(install.includes('NOPASSWD: /usr/local/sbin/cf-product-admin-staging ""'));
  assert.ok(install.includes('visudo -cf'));
});
