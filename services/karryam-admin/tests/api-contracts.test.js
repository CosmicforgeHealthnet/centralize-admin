"use strict";

// Section 10 API contracts: the generated catalog is in sync with the code,
// every Section 10.1 family maps to existing generic routes and exact pinned
// capabilities, the 17 Section 10.2 HQ Bridge contracts keep their pinned
// methods and paths, the HTTP status policy matches Section 10.3, and the
// Product Admin never forwards an arbitrary route or method.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildCatalog, SECTION_10_2, OUT } = require("../scripts/api-catalog");
const R = require("../src/bridge/contracts/registry");
const { protocolMapping, BridgeError } = require("../src/bridge/errors");
const F = require("./helpers/fixtures");

test("the committed API catalog equals the catalog generated from the code (drift detection)", () => {
  const committed = fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
  assert.equal(committed, JSON.stringify(buildCatalog(), null, 2) + "\n", "run: node services/karryam-admin/scripts/api-catalog.js");
});

test("every Section 10.1 family maps to existing protocol endpoints and exact pinned capabilities", () => {
  const catalog = buildCatalog();
  assert.equal(catalog.families.length, 11);
  for (const f of catalog.families) {
    assert.ok(f.endpoints.length > 0, f.family);
    for (const e of f.endpoints) assert.ok(F.contracts.ENDPOINTS[e.protocol_endpoint], f.family + " " + e.protocol_endpoint);
    for (const b of f.bridge_capabilities || []) {
      const cap = R.capability(b.bridge_capability_id);
      assert.ok(cap, b.bridge_capability_id);
      assert.equal(b.method, cap.method);
      assert.equal(b.bridge_path, R.BRIDGE_BASE + cap.path);
    }
  }
  // Unenrolled: nothing that reaches the source claims to be available.
  const states = catalog.families.flatMap((f) => Object.keys(f.exposure_states_unenrolled));
  assert.equal(states.includes("AVAILABLE"), false);
  assert.equal(states.includes("READ_ONLY"), false);
});

test("Section 10.2: the 17 HQ Bridge contracts keep their pinned method and path; finance stays POST", () => {
  assert.equal(SECTION_10_2.length, 17);
  for (const [id, method, suffix] of SECTION_10_2) {
    const cap = R.capability(id);
    assert.ok(cap, id);
    assert.equal(cap.method, method, id);
    assert.equal(R.BRIDGE_BASE + cap.path, "/internal/karryam-admin/v1" + suffix, id);
  }
  // A read-oriented capability whose source contract is POST is never converted to GET.
  assert.equal(R.capability("hq.finance.report").method, "POST");
  assert.equal(R.capability("hq.finance.report").kind, "READ");
  // Unknown or hand-invented capabilities cannot be addressed.
  assert.equal(R.capability("hq.finance.export"), null);
  assert.throws(() => R.requireCapability("hq.arbitrary.proxy"));
});

test("Section 10.3: HTTP status policy and source error mapping", () => {
  const S = F.contracts.ERROR_CODES;
  assert.deepEqual(
    { INVALID_REQUEST: S.INVALID_REQUEST, UNAUTHENTICATED: S.UNAUTHENTICATED, FORBIDDEN: S.FORBIDDEN, DISABLED: S.DISABLED, BLOCKED_POLICY: S.BLOCKED_POLICY, NOT_FOUND: S.NOT_FOUND, CONFLICT: S.CONFLICT, RATE_LIMITED: S.RATE_LIMITED, UNAVAILABLE: S.UNAVAILABLE },
    { INVALID_REQUEST: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, DISABLED: 403, BLOCKED_POLICY: 403, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, UNAVAILABLE: 503 });
  const map = (category) => { const [code, retryable, reason] = Object.values(protocolMapping(new BridgeError(category, {}))); return { code, retryable, reason }; };
  assert.deepEqual(map("RATE_LIMITED"), { code: "RATE_LIMITED", retryable: true, reason: "SOURCE_RATE_LIMITED" });
  assert.equal(map("VERSION_CONFLICT").code, "CONFLICT");
  // UNKNOWN_OUTCOME is an operation state, never success and never an automatic retry.
  assert.deepEqual(map("UNKNOWN_OUTCOME"), { code: "UNAVAILABLE", retryable: false, reason: "UNKNOWN_OUTCOME" });
});

test("the Product Admin serves only the fixed endpoint table: unknown paths and other methods are refused", async (t) => {
  const m = F.material();
  t.after(m.cleanup);
  const app = await F.startApp(F.loadConfig(F.enabledEnv(m)));
  t.after(app.close);
  for (const [method, path, status] of [
    ["GET", "/internal/karryam-admin/v1/hq/exports", 404],
    ["POST", "/internal/product-admin/v1/hq/finance/reports", 404],
    ["PUT", "/internal/product-admin/v1/operations", 405],
    ["DELETE", "/internal/product-admin/v1/operations/4c1e3c2a-9d7b-4f1e-8a2b-3c4d5e6f7a8b", 405],
    ["GET", "/internal/product-admin/v1/proxy?url=http://169.254.169.254/", 404],
  ]) {
    const res = await F.rawRequest(app.port, { method, path });
    assert.equal(res.status, status, method + " " + path + " " + JSON.stringify(res.json));
  }
});
