"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PINNED_BRIDGE_CONTRACT } = require("../src/bridge/contracts");

const ROOT = path.join(__dirname, "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|json|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("Karryam Admin never reaches HQ code, Prisma or operational databases", () => {
  const forbidden = [
    /central-admin-api/, /@prisma\//, /PrismaClient/, /dispatchDatabase/, /mainDatabase/, /dispatchPrisma/, /mainPrisma/,
    /DISPATCH_DATABASE_URL/, /MAIN_DATABASE_URL/, /KARRYGO_DATABASE_URL/, /\bDATABASE_URL\b(?<!ADMIN_DATABASE_URL)/,
  ];
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts")), ...walk(path.join(ROOT, "migrations"))];
  assert.ok(files.length > 15);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) assert.ok(!pattern.test(text), path.relative(ROOT, file) + " matches " + pattern);
  }
});

test("the only outbound HTTP client is the fixed bridge client (plus the database pool)", () => {
  const offenders = walk(path.join(ROOT, "src")).filter((file) => /require\("node:(?:https?|tls)"\)|\bfetch\(|axios/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/")).sort();
  // listener.js creates the inbound server; bridge/client is the only outbound HTTP caller.
  assert.deepEqual(offenders, ["src/bridge/client/index.js", "src/transport/listener.js"]);
});

test("pinned KarryGo bridge contract matches a local checkout when one is available", (t) => {
  const checkout = process.env.KARRYGO_CHECKOUT || "/home/user/cosmicforgehealthnet/karrygo";
  if (!fs.existsSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi"))) {
    // CI sets KARRYGO_REQUIRE_CHECKOUT so a missing checkout fails instead of silently skipping.
    assert.ok(process.env.KARRYGO_REQUIRE_CHECKOUT !== "1", "KARRYGO_CHECKOUT is required but not present: " + checkout);
    t.skip("KarryGo checkout not available");
    return;
  }
  for (const [rel, sha] of Object.entries(PINNED_BRIDGE_CONTRACT.artifacts)) {
    const actual = createHash("sha256").update(fs.readFileSync(path.join(checkout, rel))).digest("hex");
    assert.equal(actual, sha, "drift in " + rel);
  }
  const matrix = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi/KARRYGO_ADMIN_CAPABILITY_MATRIX.json"), "utf8"));
  const counts = {};
  for (const cap of matrix) counts[cap.state] = (counts[cap.state] || 0) + 1;
  assert.equal(matrix.length, PINNED_BRIDGE_CONTRACT.capability_matrix.total);
  assert.deepEqual(counts, PINNED_BRIDGE_CONTRACT.capability_matrix.by_state);
  const openapi = JSON.parse(fs.readFileSync(path.join(checkout, "services/admin-backoffice-service/docs/openapi/openapi.json"), "utf8"));
  assert.equal(Object.keys(openapi.paths).length, PINNED_BRIDGE_CONTRACT.openapi.path_count);
  assert.equal(openapi.info.version, PINNED_BRIDGE_CONTRACT.openapi.info_version);
});
