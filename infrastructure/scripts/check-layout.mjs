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
  ...["healthnet-admin","karryam-admin","future-product-admins"].map(s=>"services/"+s+"/README.md")
];
const old = ["frontend","src","prisma","tests","scripts","package-lock.json"];
for(const name of required) assert.ok(exists(name), "Required monorepo path missing: "+name);
for(const name of old) assert.ok(!exists(name), "Legacy root path remains: "+name);
const mainPkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
assert.equal(mainPkg.private,true);
console.log("Monorepo structure verified: "+required.length+" required paths, no legacy active-code roots.");
