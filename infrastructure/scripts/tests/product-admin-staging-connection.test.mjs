import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
test("connection-check never attempts root or uploads a bundle",()=>{
  assert.ok(p.includes("github.event_name == 'push' && github.ref == 'refs/heads/staging'"));
  assert.ok(p.includes('if [[ "$EVENT" == push ]]; then op=connection-check'));
  assert.ok(p.includes("options: [connection-check,"));
  assert.ok(p.includes("connection-check|preflight|status"));
  assert.ok(p.includes('if [[ "$OP" != connection-check ]]; then'));
  assert.ok(p.includes("BLOCKED_PRIVILEGED_HOST_OPERATION"));
  assert.ok(p.includes("product-admin-staging-readonly-inventory.json"));
  assert.ok(p.includes("sudo_noninteractive_listing_available"));
  assert.ok(p.includes("private_networks"));
  assert.ok(p.includes("needs.plan.outputs.operation != 'connection-check'"));
  assert.ok(!p.includes("environment: product-admin-staging"));
});
