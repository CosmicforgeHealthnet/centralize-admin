// S7 legacy cutover preparation: the inventory covers every route of the
// legacy karrygo/dispatch router, maps each to a real pinned Bridge
// capability of the right kind, the router stays unmounted, and the parity
// tool refuses a more permissive or different replacement.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { INVENTORY, report, compareResponses, comparePermissions } from "../../product-admin/release/s7-parity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const R = require(path.join(ROOT, "services/karryam-admin/src/bridge/contracts/registry"));

test("inventory covers exactly the routes declared by the legacy router", () => {
  const src = fs.readFileSync(path.join(ROOT, INVENTORY.legacy_module, "dispatch.routes.js"), "utf8");
  const declared = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
  const inventoried = INVENTORY.routes.map((r) => `${r.method} ${r.path}`).sort();
  assert.ok(declared.length >= 12);
  assert.deepEqual(inventoried, declared);
});

test("every route maps to a pinned capability of the matching kind; writes need approval capabilities", () => {
  for (const r of INVENTORY.routes) {
    const cap = R.capability(r.capability);
    assert.ok(cap, `${r.capability} is in the pinned registry`);
    assert.equal(cap.kind, r.kind, r.capability);
    if (r.method === "GET") assert.equal(r.kind, "READ", `${r.method} ${r.path}`);
    else {
      assert.equal(r.kind, "COMMAND", `${r.method} ${r.path}`);
      assert.ok(Array.isArray(r.approval) && r.approval.length === 2, "writes are two-person");
      for (const a of r.approval) assert.ok(R.capability(a), a);
    }
    assert.ok(r.parity.fields.length > 0);
  }
});

test("the legacy router is still not mounted by the API", () => {
  const app = fs.readFileSync(path.join(ROOT, "services/central-admin-api/src/app.js"), "utf8");
  assert.equal(/karrygo\/dispatch|dispatch\.routes|dispatchRoutes/.test(app), false);
  assert.equal(INVENTORY.legacy_mount, "NOT_MOUNTED");
});

test("parity: equal fields match; differences, missing captures and more permissive replacements fail", () => {
  const legacy = { "GET /trips": { status: 200, items: [{ id: "t1", status: "DONE", created_at: "2026-10-01T00:00:00Z" }] } };
  const same = { "GET /trips": { status: 200, items: [{ id: "t1", status: "DONE", created_at: "2026-10-01T00:00:00Z", extra: "ignored" }] } };
  const diff = { "GET /trips": { status: 200, items: [{ id: "t1", status: "CANCELLED", created_at: "2026-10-01T00:00:00Z" }] } };
  assert.equal(compareResponses(INVENTORY, legacy, same).find((r) => r.route === "GET /trips").result, "MATCH");
  assert.equal(compareResponses(INVENTORY, legacy, diff).find((r) => r.route === "GET /trips").result, "DIFF");
  assert.equal(compareResponses(INVENTORY, {}, {}).find((r) => r.route === "GET /bikes").result, "NOT_CAPTURED");
  const perms = comparePermissions(INVENTORY, [
    { route: "GET /trips", actor: "viewer", legacy: 200, replacement: 200 },
    { route: "PATCH /bikes/:id/approve", actor: "viewer", legacy: 200, replacement: 403 },
    { route: "GET /bikes", actor: "stranger", legacy: 403, replacement: 200 },
  ]);
  assert.deepEqual(perms.map((p) => p.result), ["EQUAL", "STRICTER", "MORE_PERMISSIVE"]);
  const r = report({ legacy, replacement: diff, permissions: [{ route: "GET /bikes", actor: "x", legacy: 403, replacement: 200 }] });
  assert.equal(r.checks.find((c) => c.id === "response_parity").status, "FAIL");
  assert.equal(r.checks.find((c) => c.id === "permission_parity").status, "FAIL");
  assert.equal(r.checks.find((c) => c.id === "observation_window_24h").status, "PENDING_EXTERNAL", "never claimed without the window");
  const none = report({});
  assert.equal(none.checks.find((c) => c.id === "response_parity").status, "PENDING_EXTERNAL");
});
