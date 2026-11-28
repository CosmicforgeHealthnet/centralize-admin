"use strict";

// Read-only product grant views on real PostgreSQL: the keyset cursor over
// (created_at, id) including identical timestamps, product isolation, the
// platform permission, 404s and the read audit.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { startHarness, available } = require("./helpers/harness");

const skip = !available() && "PIC_TEST_DATABASE_URL not set (disposable PostgreSQL required)";

async function insertGrant(pool, { productId, staffId, createdAt, revoked = false }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO hq_integration.hq_product_admin_grants (id, grant_kind, product_id, staff_id, role, effect, actions, scope, granted_by, created_at)
     VALUES ($1,'PRODUCT',$2,$3,$4,'ALLOW',$5,$6,'staff-requester',$7)`,
    [id, productId, staffId, productId + ".viewer", ["product.view"], JSON.stringify({ market: ["GLOBAL"], organization: [productId] }), createdAt]);
  if (revoked) await pool.query(`UPDATE hq_integration.hq_product_admin_grants SET revoked_at = now(), revoked_by = 'staff-requester', revocation_reason = 'OFFBOARDED' WHERE id = $1`, [id]);
  return id;
}

test("grant listing pages exactly through real rows, isolated per product", { skip }, async () => {
  const h = await startHarness();
  try {
    const base = Date.now() - 3600000;
    const cfmeet = [];
    for (let n = 0; n < 9; n += 1) cfmeet.push(await insertGrant(h.pool, { productId: "cfmeet", staffId: "staff-c" + (n % 2), createdAt: new Date(base + n * 1000) }));
    // Same microsecond: the id tie-breaker must still page exactly.
    const tie = new Date(base + 500).toISOString();
    for (let n = 0; n < 3; n += 1) cfmeet.push(await insertGrant(h.pool, { productId: "cfmeet", staffId: "staff-tie", createdAt: tie }));
    cfmeet.push(await insertGrant(h.pool, { productId: "cfmeet", staffId: "staff-c0", createdAt: new Date(base + 20000), revoked: true }));
    const karryam = await insertGrant(h.pool, { productId: "karryam", staffId: "staff-k", createdAt: new Date(base) });

    const ids = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await h.call("staff-requester", "GET", "/products/cfmeet/grants?limit=5" + (cursor ? "&cursor=" + cursor : ""));
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.ok(res.json.data.grants.length <= 5);
      ids.push(...res.json.data.grants.map((g) => g.grant_id));
      cursor = res.json.data.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(ids.length, cfmeet.length);
    assert.deepEqual([...ids].sort(), [...cfmeet].sort(), "every cfmeet grant exactly once, no karryam or platform grant");

    const revoked = await h.call("staff-requester", "GET", "/products/cfmeet/grants?staff_id=staff-c0&limit=100");
    assert.ok(revoked.json.data.grants.some((g) => g.status === "REVOKED" && g.revocation_reason === "OFFBOARDED"));
    assert.ok(revoked.json.data.grants.every((g) => g.staff_id === "staff-c0"));

    const one = await h.call("staff-requester", "GET", "/products/cfmeet/grants/" + cfmeet[0]);
    assert.equal(one.status, 200);
    assert.equal(one.json.data.product_id, "cfmeet");
    assert.equal((await h.call("staff-requester", "GET", "/products/cfmeet/grants/" + karryam)).status, 404, "cross-product read is a 404");
    assert.equal((await h.call("staff-requester", "GET", "/products/cfmeet/grants/" + randomUUID())).status, 404);
    assert.equal((await h.call("staff-requester", "GET", "/products/cfmeet/grants?limit=101")).status, 400);

    // Platform reviewers/approvers without grants.manage, and product-only staff, are refused.
    await h.bootstrapPlatformGrant("staff-karryam-manager", ["integration.read"]);
    for (const staff of ["staff-reviewer", "staff-approver", "staff-k", "staff-karryam-manager"]) {
      const denied = await h.call(staff, "GET", "/products/cfmeet/grants");
      assert.equal(denied.status, 403, staff);
    }
    assert.equal((await h.call("staff-requester", "GET", "/products/cfmeet/grants", undefined, { mfa: false })).status, 403, "recent MFA required");

    const { rows: audits } = await h.pool.query(`SELECT action, outcome, product_id FROM hq_integration.hq_product_admin_security_audit WHERE action IN ('integration.grant.list','integration.grant.read') ORDER BY id`);
    assert.ok(audits.length >= pages + 3);
    assert.ok(audits.every((a) => a.outcome === "ALLOWED" && a.product_id === "cfmeet"));
  } finally { await h.close(); }
});
