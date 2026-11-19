"use strict";

// "cfmeet through HQ" (design §11): CF Meet Admin onboards through the
// generic HQ registry and serves scoped reads end to end:
//
//   HQ staff -> PIC (RBAC, MFA, scope, request-bound delegation) -> CF Meet
//   Admin (module, purpose, zone/tenant, continuation) -> disposable secure
//   CF Meet Admin Bridge (mTLS, HMAC v2, Ed25519) -> HQ response.
//
// Proves the CF Meet-specific protocol keys (q for search, parent for
// nested lists) survive every hop, and that nothing reaching the source is
// executable before certification.

const test = require("node:test");
const assert = require("node:assert/strict");
const { available } = require("./helpers/harness");
const { startCfmeetThroughHq, SCOPE, ALLOWED } = require("./helpers/cfmeet-e2e");
const { generatePki } = require("../../../packages/service-clients/tests/helpers/pki");

let opensslOk = true;
try { generatePki({ serverName: "probe.internal" }).cleanup(); } catch { opensslOk = false; }
const skip = (!available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)") || (!opensslOk && "openssl unavailable");
const query = (extra = {}) => new URLSearchParams({ ...SCOPE, purpose: "support-review", ...extra }).toString();

test("CF Meet Admin onboards through the generic registry and serves scoped reads end to end", { skip, timeout: 240000 }, async (t) => {
  const { h, fake, id } = await startCfmeetThroughHq(t);
  // Validated contract: only local approval records are executable; every
  // Bridge command stays DISABLED until operator enablement and certification.
  const detail = await h.call("staff-reviewer", "GET", "/admin/product-integrations/" + id);
  const [{ catalog }] = (await h.pool.query("SELECT catalog FROM hq_integration.hq_product_admin_contracts WHERE id = $1", [detail.json.data.contracts[0].id])).rows;
  assert.equal(catalog.product_id, "cfmeet");
  assert.deepEqual(catalog.capabilities.filter((c) => c.state === "AVAILABLE").map((c) => c.id).sort(), ["cfmeet.governance.approval.decide", "cfmeet.governance.approval.propose", "cfmeet.governance.approval.revoke"]);
  assert.ok(catalog.capabilities.filter((c) => c.kind === "COMMAND" && !c.id.startsWith("cfmeet.governance.")).every((c) => c.state === "DISABLED"));
  assert.equal(catalog.datasets.length, 9, "8 Bridge datasets + HQ-local sync health");

  const g = await h.call("staff-requester", "POST", "/admin/product-integration-grants", { grant_kind: "PRODUCT", product_id: "cfmeet", staff_id: "staff-support", role: "cfmeet.ops.viewer", actions: ["product.view", "resource.read"], scope: ALLOWED });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  const nav = await h.call("staff-support", "GET", "/products");
  assert.deepEqual(nav.json.data.products.map((p) => [p.product_id, p.available]), [["cfmeet", true]]);

  // Search list: q reaches the Bridge in the signed order.
  const users = await h.call("staff-support", "GET", "/products/cfmeet/resources/cfmeet.accounts.read/accounts.users.list?" + query({ q: "ada lovelace", limit: "5" }));
  assert.equal(users.status, 200, JSON.stringify(users.json));
  const usersCall = fake.state.requests.at(-1);
  assert.equal(usersCall.capability, "accounts.users.list");
  assert.ok(usersCall.url.endsWith("&purpose=support-review&limit=5&q=ada%20lovelace"), usersCall.url);
  assert.equal(usersCall.claims.sub, "staff-support", "the requesting staff identity reaches the Bridge assertion");
  assert.deepEqual([usersCall.claims.zone_scopes, usersCall.claims.tenant_scopes], [[SCOPE.zone], [SCOPE.tenant]]);

  // Nested list: parent fills the parent path parameter.
  const sessions = await h.call("staff-support", "GET", "/products/cfmeet/resources/cfmeet.accounts.read/accounts.sessions.list?" + query({ parent: "user-1", limit: "5" }));
  assert.equal(sessions.status, 200, JSON.stringify(sessions.json));
  assert.ok(new URL(fake.state.requests.at(-1).url, "https://b").pathname.endsWith("/accounts/users/user-1/sessions"));

  // Detail read; list-only keys are refused on details before anything leaves HQ.
  const calls = fake.state.requests.length;
  const user = await h.call("staff-support", "GET", "/products/cfmeet/resources/cfmeet.accounts.read/accounts.users.read/user-1?" + query());
  assert.equal(user.status, 200, JSON.stringify(user.json));
  assert.equal(fake.state.requests.length, calls + 1);
  const withParent = await h.call("staff-support", "GET", "/products/cfmeet/resources/cfmeet.accounts.read/accounts.users.read/user-1?" + query({ parent: "user-2" }));
  assert.equal(withParent.status, 400);
  // Out-of-scope tenant and missing MFA are refused by HQ; the Bridge sees nothing.
  const foreign = await h.call("staff-support", "GET", "/products/cfmeet/resources/cfmeet.accounts.read/accounts.users.list?" + query({ tenant: "tenant-b", limit: "5" }));
  assert.ok([403, 404].includes(foreign.status), JSON.stringify(foreign.json));
  const noMfa = await h.call("staff-support", "GET", "/products/cfmeet/resources/cfmeet.accounts.read/accounts.users.list?" + query({ limit: "5" }), undefined, { mfa: false });
  assert.ok([401, 403].includes(noMfa.status), JSON.stringify(noMfa.json));
  assert.equal(fake.state.requests.length, calls + 1, "refusals never reach the Bridge");
});
