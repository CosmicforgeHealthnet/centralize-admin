"use strict";

// Section 11.1/11.2: authorization intersection details and delegation key
// lifecycle (rotation overlap, expiry, emergency revocation).

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const I = require("../src");

const now = Date.parse("2026-11-01T12:00:00Z");
const nowS = Math.floor(now / 1000);
const subject = { staffId: "staff-1", tier: "SUPER", mfaAt: nowS - 30 };
const grant = (o = {}) => ({
  id: "g-" + Math.random().toString(16).slice(2), grant_kind: "PRODUCT", staff_id: "staff-1", product_id: "karryam", effect: "ALLOW",
  actions: ["resource.read", "operation.submit"], datasets: [], scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: ["lagos-island"], tenant: ["tenant-a"] },
  role: "karryam.ops", expires_at: null, revoked_at: null, not_before: null, ...o,
});
const decide = (grants, extra = {}) => I.authorize({ subject, productId: "karryam", action: "resource.read", grants, requestedScope: { market: ["NG-LAGOS"], tenant: ["tenant-a"] }, now, ...extra });

test("grant effective dates: not yet in force, in force, expired", () => {
  assert.equal(decide([grant({ not_before: new Date(now + 60000).toISOString() })]).allowed, false);
  assert.equal(decide([grant({ not_before: new Date(now - 60000).toISOString() })]).allowed, true);
  assert.equal(decide([grant({ expires_at: new Date(now).toISOString() })]).reason, "GRANT_EXPIRED");
});

test("role overlap never unions permissions: an applicable DENY from any role wins; scope never widens", () => {
  const allowA = grant({ role: "karryam.ops" });
  const allowB = grant({ role: "karryam.finance", scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"], zone: ["lagos-island"], tenant: ["tenant-a", "tenant-b"] } });
  const denyC = grant({ role: "karryam.restricted", effect: "DENY", actions: ["resource.read"] });
  assert.equal(decide([allowA, allowB]).allowed, true);
  assert.equal(decide([allowA, allowB, denyC]).reason, "EXPLICIT_DENY");
  // An expired DENY no longer applies; a revoked DENY neither.
  assert.equal(decide([allowA, { ...denyC, expires_at: new Date(now - 1).toISOString() }]).allowed, true);
  // Asking for a tenant no single grant covers is denied (no union across grants).
  assert.equal(decide([allowA], { requestedScope: { market: ["NG-LAGOS"], tenant: ["tenant-a", "tenant-b"] } }).reason, "SCOPE_DENIED");
  // Missing/empty scope never means global.
  assert.equal(decide([grant({ scope: { market: ["NG-LAGOS"], organization: ["karryam-ng"], tenant: [] } })]).allowed, false);
  // Staff tier (SUPER) never authorizes on its own.
  assert.equal(decide([]).reason, "MISSING_PRODUCT_GRANT");
});

test("sensitive actions need recent MFA even with every grant in place", () => {
  const g = grant();
  const ok = I.authorize({ subject, productId: "karryam", action: "operation.submit", grants: [g], requestedScope: { market: ["NG-LAGOS"] }, now });
  assert.equal(ok.allowed, true);
  const stale = I.authorize({ subject: { ...subject, mfaAt: nowS - 900 }, productId: "karryam", action: "operation.submit", grants: [g], requestedScope: { market: ["NG-LAGOS"] }, now });
  assert.equal(stale.reason, "RECENT_MFA_REQUIRED");
});

test("delegation keys: rotation overlap accepts both, expiry and emergency revocation refuse", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const keys = { "d-old": { key: oldKey, notAfter: new Date(now + 3600000).toISOString() }, "d-new": { key: newKey, notAfter: new Date(now + 86400000).toISOString() } };
  const bnd = I.requestBinding("GET", "/internal/product-admin/v1/manifest");
  const claims = { iss: "product-integration-core", aud: "karryam:ka-1", sub: "staff-1", sid: "s-1", auth_time: nowS - 60, mfa_at: nowS - 30, product_id: "karryam", action: "resource.read", scope: {}, role: "r", grant_id: "g", bnd };
  const sign = (kid, key) => I.signDelegation(claims, { key, kid, typ: I.TYPES.PRODUCT, now });
  const verify = (token, k = keys) => I.verifyDelegation(token, { keys: k, typ: I.TYPES.PRODUCT, issuer: "product-integration-core", audience: "karryam:ka-1", binding: bnd, now });
  // Overlap: tokens under either key verify during a controlled rotation.
  assert.equal(verify(sign("d-old", oldKey)).sub, "staff-1");
  assert.equal(verify(sign("d-new", newKey)).sub, "staff-1");
  // Emergency revocation of the old kid: refused immediately, the new kid still works.
  const revoked = { ...keys, "d-old": { ...keys["d-old"], revoked: true } };
  assert.throws(() => verify(sign("d-old", oldKey), revoked), (e) => e.reason === "KEY_REVOKED");
  assert.equal(verify(sign("d-new", newKey), revoked).sub, "staff-1");
  // Expired key, unknown key and a key from another product boundary are refused.
  assert.throws(() => verify(sign("d-old", oldKey), { "d-old": { key: oldKey, notAfter: new Date(now - 1).toISOString() } }), (e) => e.reason === "KEY_EXPIRED");
  assert.throws(() => verify(sign("d-rotated-out", oldKey)), (e) => e.reason === "KEY_UNKNOWN");
  assert.throws(() => verify(sign("d-old", randomBytes(32))), (e) => e.reason === "SIGNATURE_INVALID");
});
