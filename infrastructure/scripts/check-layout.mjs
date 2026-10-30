import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const exists = (name) => fs.existsSync(path.join(root,name));
const required = [
  "apps/central-admin-web/package.json",
  "apps/central-admin-web/package-lock.json",
  "apps/central-admin-web/src/app",
  "services/central-admin-api/package.json",
  "services/central-admin-api/package-lock.json",
  "services/central-admin-api/src/server.js",
  "services/central-admin-api/prisma/schema.prisma",
  "services/central-admin-api/tests",
  "infrastructure/README.md",
  ...["marketing","hr","support","finance","analytics","verification","it-security","operations"].map(s=>"modules/"+s+"/README.md"),
  ...["identity-and-permissions","shared-ui","admin-contracts","service-clients","event-contracts"].map(s=>"packages/"+s+"/README.md"),
  ...["healthnet-admin","karryam-admin","future-product-admins"].map(s=>"services/"+s+"/README.md"),
  // Universal Product Admin Protocol v1: implemented packages and services.
  ...["identity-and-permissions","admin-contracts","service-clients","event-contracts"].flatMap(s=>["packages/"+s+"/package.json","packages/"+s+"/src/index.js","packages/"+s+"/tests"]),
  "packages/admin-contracts/openapi/product-admin-protocol-v1.openapi.json",
  ...["karryam-admin","product-integration-core"].flatMap(s=>["services/"+s+"/package.json","services/"+s+"/package-lock.json","services/"+s+"/Dockerfile","services/"+s+"/Dockerfile.dockerignore","services/"+s+"/.env.example","services/"+s+"/README.md","services/"+s+"/migrations","services/"+s+"/tests"]),
  "services/product-integration-core/migrations/001_product_admin_registry.sql",
  "services/product-integration-core/tests/conformance-synthetic-third-postgres.test.js",
  "infrastructure/product-admin/README.md",
  "docs/product-admin/README.md"
];
const old = ["frontend","src","prisma","tests","scripts","package-lock.json"];
for(const name of required) assert.ok(exists(name), "Required monorepo path missing: "+name);
for(const name of old) assert.ok(!exists(name), "Legacy root path remains: "+name);
// Shared packages stay dependency-free so every service image can carry them.
for(const s of ["identity-and-permissions","admin-contracts","service-clients","event-contracts"]){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"packages",s,"package.json"),"utf8"));
  assert.ok(!pkg.dependencies||Object.keys(pkg.dependencies).length===0,"Package must have no runtime dependencies: "+s);
}
// The existing API image must not start depending on files outside its build context.
const apiDockerignore=fs.readFileSync(path.join(root,".dockerignore"),"utf8");
assert.ok(/^packages$/m.test(apiDockerignore),"Root .dockerignore must keep packages/ out of the API image context");
const mainPkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
assert.equal(mainPkg.private,true);
console.log("Monorepo structure verified: "+required.length+" required paths, no legacy active-code roots.");
