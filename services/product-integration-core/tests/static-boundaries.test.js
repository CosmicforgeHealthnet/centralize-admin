"use strict";

// Architectural guards (Section 2 and 5.10):
//  - HQ integration code contains no product-specific branch or literal;
//  - it never reaches a product bridge or an operational database;
//  - it does not depend on the Central Admin API runtime.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const files = fs.readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => path.join(SRC, f));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

test("no product-specific literals or branches in the HQ integration engine", () => {
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(code, /["'`][^"'`]*\b(karryam|karrygo|healthnet|synthetic)[^"'`]*["'`]/i, path.relative(SRC, file));
    assert.doesNotMatch(code, /product_id\s*===?\s*["'`]/, path.relative(SRC, file));
  }
});

test("no bridge paths, operational databases or Central Admin API imports", () => {
  for (const file of files) {
    const code = fs.readFileSync(file, "utf8");
    const rel = path.relative(SRC, file);
    assert.doesNotMatch(code, /\/internal\/(karryam|karrygo)-admin/i, rel);
    assert.doesNotMatch(code, /DISPATCH_DATABASE_URL|MAIN_DATABASE_URL|dispatchPrisma|mainPrisma|@prisma|generated\/(dispatch|main|admin)-client/, rel);
    assert.doesNotMatch(code, /require\([^)]*central-admin-api/, rel);
    for (const match of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const target = match[1];
      assert.ok(target.startsWith("node:") || target === "pg" || target.startsWith(".") , rel + " requires " + target);
      if (target.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), target);
        assert.ok(resolved.startsWith(path.join(__dirname, "..")) || resolved.includes(path.join("packages", "")), rel + " -> " + target);
      }
    }
  }
});

test("process environment is read only by the config and server modules", () => {
  for (const file of files) {
    const rel = path.relative(SRC, file);
    if (rel.startsWith("config") || rel.startsWith("server")) continue;
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /process\.env/, rel);
  }
});

// Section 9.5.7: the legacy Central Admin Karryam dispatch module still uses
// the Karryam Dispatch operational database directly (reads and writes).
// It is documented, not cut over: a cutover needs source API parity,
// permission/readback parity, operational testing, owner approval and
// release authorization. Until then the access must not spread.
test("legacy direct Karryam Dispatch database access stays confined to the documented legacy files", () => {
  const api = path.join(__dirname, "..", "..", "central-admin-api", "src");
  if (!fs.existsSync(api)) return;
  const allowed = new Set([
    path.join("modules", "karrygo", "dispatch", "dispatch.service.js"),
    path.join("modules", "karrygo", "dispatch", "legacy-telemetry.js"),
    path.join("shared", "config", "dispatchDatabase.js"),
  ]);
  const offenders = [];
  for (const rel of fs.readdirSync(api, { recursive: true })) {
    if (!rel.endsWith(".js") || rel.startsWith("generated") || /__tests__|\.test\.js$/.test(rel)) continue;
    const code = fs.readFileSync(path.join(api, rel), "utf8");
    if (/dispatchPrisma|DISPATCH_DATABASE_URL|generated\/dispatch-client/.test(code) && !allowed.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "new direct Karryam Dispatch database access outside the legacy module");
});
