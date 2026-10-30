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
