"use strict";

// Section 6 module reads, end to end through Protocol 1.1 against the
// disposable secure Bridge (real TLS 1.3 mTLS, HMAC v2, Ed25519). For every
// module: valid list/detail, staff/grant/scope denials, filter and
// pagination bounds, missing source, source-blocked collections, DTO shape,
// audit and sensitive-access records.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startBridgeHarness, protocolGet, opensslAvailable, SCOPE } = require("./helpers/bridge-harness");
const { MODULES, collectionsOf, capabilityMap } = require("../src/modules/catalog");
const R = require("../src/bridge/contracts/registry");

const skip = !opensslAvailable() && "openssl unavailable";
const LIST_FAMILIES = ["ResourcePage", "VerificationCasePage"];
const DETAIL_FAMILIES = ["ResourceDetail", "VerificationCaseDetail", "OperationRecord"];
const usable = (c) => c.method === "GET" && ["READ_ONLY", "AVAILABLE"].includes(c.matrix_state);
const isFamily = (c, families) => families.some((f) => JSON.stringify(c.result_schema) === JSON.stringify({ $ref: "#/components/schemas/" + f }));
const shapeHas = (c, p) => R.SHAPE_PARAMS[c.query_shape].includes(p);
const scopeQuery = (extra = {}) => ({ market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant, purpose: "support-review", ...extra });

test("module catalog: every inventory capability belongs to exactly one module and counts match the source", () => {
  const counts = {};
  for (const c of R.CAPABILITIES) counts[c.module] = (counts[c.module] || 0) + 1;
  // Every pinned capability maps to one of the 17 CF Meet modules or platform metadata.
  assert.deepEqual(Object.keys(counts).sort(), MODULES.map((m) => m.id).sort());
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), R.CAPABILITIES.length);
  const map = capabilityMap({ bridge: { enabled: false }, enabledCommands: [] });
  assert.equal(map.length, R.CAPABILITIES.length);
  assert.equal(new Set(map.map((e) => e.bridge_capability_id)).size, R.CAPABILITIES.length);
  // Source AVAILABLE never becomes executable here without enrollment and enablement.
  assert.ok(map.filter((e) => e.source_state === "AVAILABLE").every((e) => e.exposure_state !== "AVAILABLE"));
  assert.ok(map.filter((e) => e.kind === "SYNC").every((e) => e.cfmeet_capability_id === null && e.exposure_state === "INTERNAL_SYNC_ONLY"));
  // Every CF Meet scope dimension is carried on every capability.
  assert.ok(map.every((e) => e.scope_dimensions.join(",") === "market,organization,zone,tenant"));
  // Each design module (design §4) exposes exactly one read capability.
  assert.equal(MODULES.filter((m) => m.read).length, 18);
  assert.equal(new Set(MODULES.map((m) => m.read)).size, 18);
});

for (const module of MODULES.filter((m) => m.read)) {
  const collections = collectionsOf(module);
  const lists = collections.filter((c) => usable(c) && c.path_params.length === 0 && isFamily(c, LIST_FAMILIES));
  const list = lists.find((c) => shapeHas(c, "start")) || lists[0];
  const detail = collections.find((c) => usable(c) && c.path_params.length === 1 && isFamily(c, DETAIL_FAMILIES));
  const blocked = collections.find((c) => ["BLOCKED_DEPENDENCY", "DISABLED"].includes(c.matrix_state));

  test(`${module.id}: scoped reads, denials, bounds and audit`, { skip }, async (t) => {
    const h = await startBridgeHarness(t);
    const base = `/resources/${module.read}/`;
    if (list) {
      const ok = await protocolGet(h, base + list.id, scopeQuery({ limit: 2 }));
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      const r = ok.json.result;
      assert.equal(r.module, module.id);
      assert.equal(r.collection_id, list.id);
      assert.equal(r.source.bridge_capability_id, list.id);
      assert.deepEqual(r.scope, { market: SCOPE.market, organization: SCOPE.organization, zone: SCOPE.zone, tenant: SCOPE.tenant });
      assert.ok(["LIVE", "PARTIAL_COVERAGE"].includes(r.quality));
      assert.ok(ok.json.as_of && r.observed_at === ok.json.as_of, "source observation time is reported");
      assert.ok(Array.isArray(r.data.items));
      assert.equal("next_cursor" in r.data, false, "the Bridge cursor never leaves CF Meet Admin");
      const call = h.fake.state.requests.at(-1);
      assert.equal(call.capability, list.id);
      assert.deepEqual(call.claims.permissions, [list.permission]);
      assert.deepEqual([call.claims.zone_scopes, call.claims.tenant_scopes], [[SCOPE.zone], [SCOPE.tenant]]);
      assert.ok(h.audit.rows.some((a) => a.outcome === "READ_AUTHORIZED" && a.metadata.bridge_capability === list.id));
      if (!["MINIMIZED_METADATA", "SUPPRESSED_COUNT_METADATA"].includes(list.privacy)) assert.ok(h.accessLog.rows.some((a) => a.capabilityId === list.id && a.outcome === "READ_AUTHORIZED"));

      // Pagination: opaque continuation bound to staff, scope and filters.
      if (r.continuation) {
        const next = await protocolGet(h, base + list.id, scopeQuery({ limit: 2, continuation: r.continuation }));
        assert.equal(next.status, 200, JSON.stringify(next.json));
        assert.ok(h.fake.state.requests.at(-1).url.includes("cursor="));
        const otherFilter = await protocolGet(h, base + list.id, scopeQuery({ limit: 3, continuation: r.continuation }));
        assert.equal(otherFilter.json.error.reason, "CONTINUATION_BINDING_MISMATCH");
        const otherStaff = await protocolGet(h, base + list.id, scopeQuery({ limit: 2, continuation: r.continuation }), { sub: "staff-99" });
        assert.equal(otherStaff.json.error.reason, "CONTINUATION_BINDING_MISMATCH");
        const tampered = await protocolGet(h, base + list.id, scopeQuery({ limit: 2, continuation: r.continuation.slice(0, -4) + "AAAA" }));
        assert.equal(tampered.json.error.reason, "CONTINUATION_INVALID");
      }

      const before = h.fake.state.requests.length;
      // Unauthorized staff / wrong action / unmapped grant role.
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { noDelegation: true })).json.error.reason, "DELEGATION_REQUIRED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { action: "product.view" })).json.error.reason, "DELEGATION_ACTION_MISMATCH");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { role: "cfmeet.unmapped" })).json.error.reason, "ROLE_NOT_APPROVED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { role: "SUPER" })).json.error.reason, "ROLE_NOT_APPROVED", "staff tier never authorizes");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { mfa_at: null })).json.error.reason, "RECENT_MFA_REQUIRED");
      // Cross-market, cross-organization, cross-zone and cross-tenant.
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ market: "NG-ABUJA" }))).json.error.reason, "SCOPE_NOT_ENROLLED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ organization: "other-org" }))).json.error.reason, "SCOPE_NOT_ENROLLED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { scope: { market: ["NG-ABUJA"], organization: [SCOPE.organization], zone: [SCOPE.zone], tenant: [SCOPE.tenant] } })).json.error.reason, "SCOPE_NOT_GRANTED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ tenant: "tenant-b" }))).json.error.reason, "TENANT_NOT_GRANTED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ zone: "abuja-central" }))).json.error.reason, "ZONE_NOT_GRANTED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery(), { scope: { market: [SCOPE.market], organization: [SCOPE.organization] } })).json.error.reason, "ZONE_NOT_GRANTED", "no zone grant never means every zone");
      // Invalid filters and bounds.
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ sort: "created_at" }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ limit: 101 }))).json.error.reason, "LIMIT_OUT_OF_BOUNDS");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ limit: 0 }))).json.error.reason, "LIMIT_OUT_OF_BOUNDS");
      if (shapeHas(list, "start")) assert.equal((await protocolGet(h, base + list.id, scopeQuery({ start: "2026-01-01T00:00:00Z", end: "2026-03-01T00:00:00Z" }))).json.error.reason, "TIME_WINDOW_INVALID");
      else assert.equal((await protocolGet(h, base + list.id, scopeQuery({ start: "2026-01-01T00:00:00Z" }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
      if (shapeHas(list, "q")) assert.equal((await protocolGet(h, base + list.id, scopeQuery({ q: "<script>" }))).json.error.reason, "SEARCH_INVALID");
      else assert.equal((await protocolGet(h, base + list.id, scopeQuery({ q: "ada" }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ purpose: undefined }))).json.error.reason, "PURPOSE_REQUIRED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ purpose: "case_review" }))).json.error.reason, "PURPOSE_NOT_ALLOWED");
      assert.equal((await protocolGet(h, base + list.id, scopeQuery({ purpose: "event-sync" }))).json.error.reason, "PURPOSE_NOT_ALLOWED", "worker-only purposes are not staff purposes");
      assert.equal(h.fake.state.requests.length, before, "denials never reach the Bridge");

      // Missing / failing source: honest unavailability, never an empty success.
      h.fake.state.handlers[list.id] = () => ({ status: 503, error: "owner_unavailable" });
      const down = await protocolGet(h, base + list.id, scopeQuery());
      assert.equal(down.status, 503);
      assert.equal(down.json.error.reason, "SOURCE_UNAVAILABLE");
      assert.equal(down.json.result, null);
      h.fake.state.handlers[list.id] = () => ({ status: 503, error: "blocked_policy" });
      assert.equal((await protocolGet(h, base + list.id, scopeQuery())).json.error.reason, "SOURCE_POLICY_UNAVAILABLE");
      h.fake.state.handlers[list.id] = () => ({ status: 403, error: "forbidden" });
      assert.equal((await protocolGet(h, base + list.id, scopeQuery())).json.error.reason, "SOURCE_FORBIDDEN");
      // A response outside the pinned schema is a contract mismatch, not data.
      h.fake.state.handlers[list.id] = ({ res }) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ contract_version: "1.0", product: "cfmeet", correlation_id: "00000000-0000-4000-8000-000000000001", as_of: new Date().toISOString(), freshness: "LIVE", result: { items: [{ phone: "+2340000000" }] } })); return "HANDLED"; };
      const drift = await protocolGet(h, base + list.id, scopeQuery());
      assert.equal(drift.json.error.reason, "BRIDGE_CONTRACT_MISMATCH");
      delete h.fake.state.handlers[list.id];
    }
    if (detail) {
      const id = detail.path_params[0].format === "uuid" ? "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7" : "ref-1";
      const ok = await protocolGet(h, base + detail.id + "/" + id, scopeQuery());
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.result.kind, "DETAIL");
      assert.ok(h.fake.state.requests.at(-1).url.includes("/" + id + "?"));
      assert.equal((await protocolGet(h, base + detail.id, scopeQuery())).json.error.reason, "COLLECTION_REQUIRES_RESOURCE_ID");
      if (detail.path_params[0].format === "uuid") assert.equal((await protocolGet(h, base + detail.id + "/not-a-uuid", scopeQuery())).json.error.reason, "REQUEST_OUTSIDE_PINNED_CONTRACT");
    }
    if (blocked) {
      const res = await protocolGet(h, base + blocked.id + (blocked.path_params.length ? "/ref-1" : ""), scopeQuery());
      assert.ok([403, 503].includes(res.status));
      assert.ok(["SOURCE_CAPABILITY_DISABLED", "SOURCE_BLOCKED_DEPENDENCY", "SOURCE_DISABLED"].includes(res.json.error.reason), res.json.error.reason);
    }
    // Unknown collection and a collection of another module are both refused.
    assert.equal((await protocolGet(h, base + "made.up.collection", scopeQuery())).json.error.reason, "UNKNOWN_COLLECTION");
    const foreign = R.CAPABILITIES.find((c) => c.kind === "READ" && c.module !== module.id && !(module.related || []).includes(c.id));
    assert.equal((await protocolGet(h, base + foreign.id, scopeQuery())).json.error.reason, "UNKNOWN_COLLECTION");
  });
}

test("the pricing simulator POST contract is never served as a resource read; search reads carry q", { skip }, async (t) => {
  const h = await startBridgeHarness(t);
  assert.equal((await protocolGet(h, "/resources/cfmeet.pricing.read/pricing.simulations.run", scopeQuery())).json.error.reason, "SERVED_BY_PRICING_SIMULATOR");
  const ok = await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.users.list", scopeQuery({ q: "ada lovelace", limit: 5 }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(h.fake.state.requests.at(-1).url.endsWith("&purpose=support-review&limit=5&q=ada%20lovelace"));
  assert.equal(ok.json.result.filters.q, "ada lovelace");
  // Nested collections (a parent's children) are lists addressed with `parent`.
  const sessions = await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.sessions.list", scopeQuery({ parent: "user-1", limit: 5 }));
  assert.equal(sessions.status, 200, JSON.stringify(sessions.json));
  assert.equal(sessions.json.result.kind, "LIST");
  assert.ok(new URL(h.fake.state.requests.at(-1).url, "https://b").pathname.endsWith("/accounts/users/user-1/sessions"));
  assert.equal(sessions.json.result.filters.parent, "user-1");
  const before = h.fake.state.requests.length;
  assert.equal((await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.sessions.list", scopeQuery({ limit: 5 }))).json.error.reason, "PARENT_REQUIRED");
  // A malformed parent is refused by the protocol layer (or, failing that, here).
  assert.ok(["REQUEST_TARGET_INVALID", "PARENT_REQUIRED"].includes((await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.sessions.list", scopeQuery({ parent: "../x", limit: 5 }))).json.error.reason));
  assert.equal((await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.sessions.list/user-1", scopeQuery())).json.error.reason, "COLLECTION_IS_A_NESTED_LIST");
  assert.equal((await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.users.list", scopeQuery({ parent: "user-1" }))).json.error.reason, "UNKNOWN_OR_UNSUPPORTED_PARAMETER", "flat lists take no parent");
  if (sessions.json.result.continuation) {
    const otherParent = await protocolGet(h, "/resources/cfmeet.accounts.read/accounts.sessions.list", scopeQuery({ parent: "user-2", limit: 5, continuation: sessions.json.result.continuation }));
    assert.equal(otherParent.json.error.reason, "CONTINUATION_BINDING_MISMATCH", "page 2 of one user's sessions never serves another user");
  }
  assert.equal(h.fake.state.requests.length, before, "refusals never reach the Bridge");
  const vcase = await protocolGet(h, "/resources/cfmeet.verification.read/verification.cases.read/6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", scopeQuery({ purpose: "verification-review" }));
  assert.equal(vcase.status, 200, JSON.stringify(vcase.json));
  assert.equal(vcase.json.result.data.item.product, "cfmeet");
  assert.ok(["PARTNER_GO_LIVE", "APP_REVIEW", "APP_PUBLISH"].includes(vcase.json.result.data.item.kind));
});

test("without Bridge enrollment every module read is an explicit blocked dependency", async (t) => {
  const F = require("./helpers/fixtures");
  const m = F.material();
  const app = await F.startApp(F.loadConfig(F.enabledEnv(m)));
  t.after(async () => { await app.close(); m.cleanup(); });
  const client = F.hqClient(app.target, m.hqKey);
  const uri = F.contracts.BASE_PATH + "/resources/cfmeet.meetings.read/meetings.meetings.list?market=NG-LAGOS&organization=cfmeet-ng&zone=z&tenant=t&purpose=support-review";
  const res = await client.listResources("cfmeet.meetings.read", "meetings.meetings.list", { market: "NG-LAGOS", organization: "cfmeet-ng", zone: "z", tenant: "t", purpose: "support-review" }, { delegation: F.delegation(m, { uri, action: "resource.read" }) });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.reason, "BRIDGE_TRUST_NOT_ENROLLED");
  assert.equal(res.json.result, null);
});
