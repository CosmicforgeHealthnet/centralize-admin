"use strict";

// Read-only product grant views (GET /internal/pic/v1/products/{id}/grants
// and /grants/{grantId}) without a database: the real PIC HTTP app, real HQ
// delegation tokens and an in-memory stand-in for the grants and audit
// tables. The SQL itself is exercised in product-grants-read-postgres.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { randomBytes, randomUUID } = require("node:crypto");
const I = require("../../../packages/identity-and-permissions");
const { buildEndpoints, buildTrustStore } = require("../src/registry/endpoints");
const { createApp } = require("../src/api/app");

const GRANTS_TABLE = "hq_integration.hq_product_admin_grants";
const AUDIT_TABLE = "hq_integration.hq_product_admin_security_audit";
const DAY = 86400000;

// Microsecond cursor key exactly as PostgreSQL's to_char(... 'US') renders it.
const cursorTime = (date) => date.toISOString().replace("Z", "000Z");

function grantRow(overrides = {}) {
  return {
    id: randomUUID(), grant_kind: "PRODUCT", product_id: "cfmeet", staff_id: "staff-x", role: "cfmeet.viewer", effect: "ALLOW",
    actions: ["product.view"], datasets: [], scope: { market: ["GLOBAL"], organization: ["cfmeet"] }, not_before: null, expires_at: null,
    granted_by: "staff-granter", created_at: new Date(Date.now() - DAY), revoked_at: null, revoked_by: null, revocation_reason: null, ...overrides,
  };
}

function platformGrant(staffId, actions) {
  return grantRow({ grant_kind: "PLATFORM", product_id: null, staff_id: staffId, role: null, actions, scope: {}, granted_by: "operator-bootstrap", created_at: new Date(Date.now() - 2 * DAY) });
}

// Answers exactly the statements the grant views and authorization issue;
// anything else fails the test loudly.
function fakePool(grants, { auditFails = false } = {}) {
  const audits = [];
  const queries = [];
  const pool = {
    audits,
    queries,
    async query(sql, values = []) {
      queries.push(sql);
      if (sql.startsWith(`SELECT * FROM ${GRANTS_TABLE} WHERE staff_id = $1`)) return { rows: grants.filter((g) => g.staff_id === values[0]) };
      if (sql.includes(`INSERT INTO ${AUDIT_TABLE}`)) {
        if (auditFails) throw new Error("audit down");
        audits.push({ actor: values[2], product: values[3], action: values[5], outcome: values[6], reason: values[7], metadata: JSON.parse(values[8]) });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes(`FROM ${GRANTS_TABLE} WHERE grant_kind = 'PRODUCT' AND product_id = $1`) && sql.includes("ORDER BY created_at DESC, id DESC")) {
        let i = 1;
        let rows = grants.filter((g) => g.grant_kind === "PRODUCT" && g.product_id === values[0]);
        if (sql.includes("AND staff_id = $")) {
          const staffId = values[i++];
          rows = rows.filter((g) => g.staff_id === staffId);
        }
        if (sql.includes("(created_at, id) <")) {
          const [time, id] = [values[i++], values[i++]];
          rows = rows.filter((g) => cursorTime(g.created_at) < time || (cursorTime(g.created_at) === time && g.id < id));
        }
        rows.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
        return { rows: rows.slice(0, values[i]).map((g) => ({ ...g, cursor_time: cursorTime(g.created_at) })) };
      }
      if (sql.includes(`FROM ${GRANTS_TABLE} WHERE id = $1 AND grant_kind = 'PRODUCT' AND product_id = $2`)) {
        return { rows: grants.filter((g) => g.id === values[0] && g.grant_kind === "PRODUCT" && g.product_id === values[1]).map((g) => ({ ...g, cursor_time: cursorTime(g.created_at) })) };
      }
      throw new Error("unexpected query: " + sql.slice(0, 120));
    },
  };
  return pool;
}

async function start(grants, options) {
  const pool = fakePool(grants, options);
  const hqKey = randomBytes(32);
  const seen = new Set();
  const nonceStore = { async claim(ns, nonce) { const k = ns + ":" + nonce; if (seen.has(k)) return false; seen.add(k); return true; } };
  const app = createApp({
    pool, environment: "test", hqDelegationKeys: { "hq-k1": { key: hqKey } }, nonceStore,
    endpoints: buildEndpoints({ endpoints: {} }, { environment: "test" }), trustStore: buildTrustStore({ signers: {} }, { environment: "test" }),
    observability: { observeRequest() {}, render: async () => "" },
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const nowS = () => Math.floor(Date.now() / 1000);
  function call(staffId, path, { mfa = true, raw = false } = {}) {
    const fullPath = "/internal/pic/v1" + path;
    const token = I.signDelegation({ iss: "central-admin-api", aud: "product-integration-core", sub: staffId, sid: "sess-" + staffId, auth_time: nowS() - 60, mfa_at: mfa ? nowS() - 10 : null, tier: "SUPER", bnd: I.requestBinding("GET", fullPath, Buffer.alloc(0)) }, { key: hqKey, kid: "hq-k1", typ: I.TYPES.HQ, now: Date.now() });
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: fullPath, headers: raw ? {} : { "X-CF-HQ-Delegation": token } }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.end();
    });
  }
  return { pool, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

function fixture() {
  const cfmeet = Array.from({ length: 7 }, (_, n) => grantRow({ staff_id: "staff-c" + (n % 3), created_at: new Date(Date.now() - (n + 1) * 60000) }));
  // Two grants created in the same millisecond: the id tie-breaker keeps paging exact.
  const tie = new Date(Date.now() - 30 * 60000);
  cfmeet.push(grantRow({ staff_id: "staff-tie", created_at: tie }), grantRow({ staff_id: "staff-tie", created_at: tie }));
  cfmeet.push(grantRow({ staff_id: "staff-c0", revoked_at: new Date(Date.now() - 1000), revoked_by: "staff-manager", revocation_reason: "OFFBOARDED" }));
  cfmeet.push(grantRow({ staff_id: "staff-c1", expires_at: new Date(Date.now() - 1000) }));
  const karryam = [grantRow({ product_id: "karryam", staff_id: "staff-k", role: "karryam.ops.viewer", scope: { market: ["NG"], organization: ["karryam-ng"] } })];
  const platform = [
    platformGrant("staff-manager", ["integration.read", "integration.grants.manage"]),
    platformGrant("staff-reader", ["integration.read"]),
  ];
  // A Karryam-only operator: product grants on karryam, but no grants.manage.
  const karryamOperator = grantRow({ product_id: "karryam", staff_id: "staff-karryam-ops", role: "karryam.ops.viewer", actions: ["product.view", "operation.submit", "operation.read"], scope: { market: ["NG"], organization: ["karryam-ng"] } });
  return { cfmeet, karryam, all: [...cfmeet, ...karryam, ...platform, karryamOperator] };
}

test("grant views require a valid HQ delegation and integration.grants.manage with recent MFA", async () => {
  const { all } = fixture();
  const h = await start(all);
  try {
    assert.equal((await h.call("staff-manager", "/products/cfmeet/grants", { raw: true })).status, 401);
    for (const staff of ["staff-reader", "staff-karryam-ops", "staff-k", "staff-nobody"]) {
      const denied = await h.call(staff, "/products/cfmeet/grants");
      assert.equal(denied.status, 403, staff);
      assert.equal(denied.json.error.reason, "MISSING_PLATFORM_GRANT", staff);
      assert.equal((await h.call(staff, "/products/karryam/grants")).status, 403, staff + " (own product)");
    }
    const stale = await h.call("staff-manager", "/products/cfmeet/grants", { mfa: false });
    assert.equal(stale.status, 403);
    assert.equal(stale.json.error.reason, "RECENT_MFA_REQUIRED");
    const denials = h.pool.audits.filter((a) => a.outcome === "DENIED");
    assert.ok(denials.length >= 9, "every denial is audited");
    assert.ok(denials.every((a) => a.action === "integration.grants.manage"));
    assert.equal(h.pool.queries.filter((q) => q.includes("ORDER BY created_at DESC")).length, 0, "no grant rows were read for denied callers");
  } finally { await h.close(); }
});

test("listing returns only the requested product's PRODUCT grants, bounded pages, exact keyset paging", async () => {
  const { all, cfmeet } = fixture();
  const h = await start(all);
  try {
    const first = await h.call("staff-manager", "/products/cfmeet/grants?limit=4");
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.data.product_id, "cfmeet");
    assert.equal(first.json.data.limit, 4);
    assert.equal(first.json.data.grants.length, 4);
    assert.ok(first.json.data.next_cursor);
    const ids = first.json.data.grants.map((g) => g.grant_id);
    let cursor = first.json.data.next_cursor;
    while (cursor) {
      const page = await h.call("staff-manager", "/products/cfmeet/grants?limit=4&cursor=" + cursor);
      assert.equal(page.status, 200);
      assert.ok(page.json.data.grants.length <= 4);
      ids.push(...page.json.data.grants.map((g) => g.grant_id));
      cursor = page.json.data.next_cursor;
    }
    assert.equal(ids.length, cfmeet.length, "every cfmeet grant exactly once");
    assert.deepEqual([...new Set(ids)].sort(), cfmeet.map((g) => g.id).sort());

    const full = await h.call("staff-manager", "/products/cfmeet/grants");
    assert.equal(full.json.data.limit, 50, "default page size");
    assert.equal(full.json.data.next_cursor, null);
    const views = full.json.data.grants;
    assert.ok(views.every((g) => g.product_id === "cfmeet" && g.grant_kind === "PRODUCT"), "no karryam or platform grants leak");
    for (let i = 1; i < views.length; i += 1) assert.ok(views[i - 1].created_at >= views[i].created_at, "newest first");
    assert.deepEqual(views.map((g) => g.status).sort().filter((s) => s !== "ACTIVE"), ["EXPIRED", "REVOKED"]);
    assert.deepEqual(Object.keys(views[0]).sort(), ["actions", "created_at", "datasets", "effect", "expires_at", "grant_id", "grant_kind", "granted_by", "not_before", "product_id", "revocation_reason", "revoked_at", "revoked_by", "role", "scope", "staff_id", "status"]);

    const byStaff = await h.call("staff-manager", "/products/cfmeet/grants?staff_id=staff-tie");
    assert.deepEqual(byStaff.json.data.grants.map((g) => g.staff_id), ["staff-tie", "staff-tie"]);
    const karryam = await h.call("staff-manager", "/products/karryam/grants?staff_id=staff-c0");
    assert.deepEqual(karryam.json.data.grants, [], "a cfmeet staff filter on karryam returns nothing");
    const unknownProduct = await h.call("staff-manager", "/products/unknownprod/grants");
    assert.deepEqual(unknownProduct.json.data.grants, []);

    const reads = h.pool.audits.filter((a) => a.action === "integration.grant.list");
    assert.ok(reads.length >= 5, "every list is audited");
    assert.ok(reads.every((a) => a.outcome === "ALLOWED" && a.actor === "staff-manager" && /^[a-z]/.test(a.product)));
    assert.equal(reads.find((a) => a.metadata.staff_ref === "staff-tie").metadata.result_count, 2);
  } finally { await h.close(); }
});

test("page size and query are strictly bounded", async () => {
  const h = await start(fixture().all);
  try {
    for (const query of ["limit=0", "limit=101", "limit=1000", "limit=-1", "limit=abc", "limit=5&limit=6", "cursor=short", "cursor=" + Buffer.from(JSON.stringify(["yesterday", "x"])).toString("base64url"), "cursor=" + "A".repeat(300), "staff_id=" + encodeURIComponent("bad staff"), "product_id=karryam", "include=all"]) {
      const res = await h.call("staff-manager", "/products/cfmeet/grants?" + query);
      assert.equal(res.status, 400, query);
      assert.equal(res.json.error.code, "INVALID_REQUEST", query);
    }
    assert.equal((await h.call("staff-manager", "/products/cfmeet/grants?limit=100")).status, 200);
    assert.equal((await h.call("staff-manager", "/products/cfmeet/grants?limit=1")).json.data.grants.length, 1);
  } finally { await h.close(); }
});

test("reading one grant: 404 for unknown ids and for another product's grant", async () => {
  const { all, cfmeet, karryam } = fixture();
  const h = await start(all);
  try {
    const one = await h.call("staff-manager", "/products/cfmeet/grants/" + cfmeet[0].id);
    assert.equal(one.status, 200);
    assert.equal(one.json.data.grant_id, cfmeet[0].id);
    assert.equal(one.json.data.status, "ACTIVE");
    const unknown = await h.call("staff-manager", "/products/cfmeet/grants/" + randomUUID());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.reason, "UNKNOWN_GRANT");
    const crossProduct = await h.call("staff-manager", "/products/cfmeet/grants/" + karryam[0].id);
    assert.equal(crossProduct.status, 404, "a karryam grant is invisible under cfmeet");
    const platform = all.find((g) => g.grant_kind === "PLATFORM");
    assert.equal((await h.call("staff-manager", "/products/cfmeet/grants/" + platform.id)).status, 404, "platform grants are never served");
    assert.equal((await h.call("staff-manager", "/products/cfmeet/grants/not-a-uuid")).status, 404, "non-UUID ids do not match a route");
    assert.equal((await h.call("staff-reader", "/products/cfmeet/grants/" + cfmeet[0].id)).status, 403);
    const reads = h.pool.audits.filter((a) => a.action === "integration.grant.read");
    assert.deepEqual(reads.map((a) => a.metadata.found), [true, false, false, false]);
  } finally { await h.close(); }
});

test("grant views fail closed when the audit cannot be written", async () => {
  const h = await start(fixture().all, { auditFails: true });
  try {
    const res = await h.call("staff-manager", "/products/cfmeet/grants");
    assert.equal(res.status, 503);
    assert.equal(res.json.data, undefined, "no grant data without an audit record");
  } finally { await h.close(); }
});
