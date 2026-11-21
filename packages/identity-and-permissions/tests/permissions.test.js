"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../src");

const now = Date.parse("2026-10-30T12:00:00Z");
const nowS = Math.floor(now / 1000);
const subject = { staffId: "staff-1", tier: "EMPLOYEE", mfaAt: nowS - 30 };
const productGrant = (overrides = {}) => ({
  id: "g-1", grant_kind: "PRODUCT", staff_id: "staff-1", product_id: "synthetic-third", effect: "ALLOW",
  actions: ["product.view", "metric.read", "dataset.list"], datasets: ["synthetic.daily_activity"],
  scope: { market: ["NG"], organization: ["cosmicforge"], tenant: ["tenant-a"] }, role: "synthetic.viewer",
  expires_at: null, revoked_at: null, ...overrides,
});

test("an explicit product grant authorizes with an effective scope", () => {
  const r = I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", requestedScope: { market: "NG" }, grants: [productGrant()], now });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.effectiveScope, { market: ["NG"], organization: ["cosmicforge"], tenant: ["tenant-a"] });
  assert.equal(r.role, "synthetic.viewer");
});

test("missing product grant is denied even for SUPER, EXECUTIVE or ADMIN tiers", () => {
  for (const tier of ["SUPER", "EXECUTIVE", "ADMIN"]) {
    const r = I.authorize({ subject: { ...subject, tier }, productId: "karryam", action: "product.view", grants: [productGrant()], now });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "MISSING_PRODUCT_GRANT");
  }
});

test("missing dataset grant, cross-market and cross-tenant requests are denied", () => {
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.other", grants: [productGrant()], now }).reason, "MISSING_DATASET_GRANT");
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", requestedScope: { market: "GH" }, grants: [productGrant()], now }).reason, "SCOPE_DENIED");
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", requestedScope: { tenant: "tenant-b" }, grants: [productGrant()], now }).reason, "SCOPE_DENIED");
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", requestedScope: { zone: "z1" }, grants: [productGrant()], now }).reason, "SCOPE_DENIED");
  // Product registry scope also bounds the grant.
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", grants: [productGrant()], productScope: { market: ["GH"] }, now }).reason, "SCOPE_DENIED");
});

test("expired and revoked grants deny; explicit deny wins", () => {
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "product.view", grants: [productGrant({ expires_at: "2026-10-30T11:00:00Z" })], now }).reason, "GRANT_EXPIRED");
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "product.view", grants: [productGrant({ revoked_at: "2026-10-30T11:00:00Z" })], now }).reason, "GRANT_REVOKED");
  const denyGrant = productGrant({ id: "g-0", effect: "DENY", datasets: [] });
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "product.view", grants: [productGrant(), denyGrant], now }).reason, "EXPLICIT_DENY");
});

test("wildcards and incomplete product grants are invalid and ignored", () => {
  assert.ok(I.grantErrors(productGrant({ scope: { market: ["*"], organization: ["cosmicforge"] } })).length > 0);
  assert.ok(I.grantErrors(productGrant({ scope: { organization: ["cosmicforge"] } })).includes("PRODUCT_GRANT_REQUIRES_MARKET_AND_ORGANIZATION"));
  assert.ok(I.grantErrors(productGrant({ actions: ["integration.approve"] })).some((e) => e.startsWith("ACTION_KIND_MISMATCH")));
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "product.view", grants: [productGrant({ scope: { market: ["*"], organization: ["cosmicforge"] } })], now }).allowed, false);
});

test("sensitive actions require recent MFA; policy unavailability denies", () => {
  const platform = { id: "p-1", grant_kind: "PLATFORM", staff_id: "staff-1", product_id: null, effect: "ALLOW", actions: ["integration.approve"], datasets: [], scope: {}, expires_at: null, revoked_at: null };
  assert.equal(I.authorize({ subject, action: "integration.approve", grants: [platform], now }).allowed, true);
  assert.equal(I.authorize({ subject: { ...subject, mfaAt: nowS - 3600 }, action: "integration.approve", grants: [platform], now }).reason, "RECENT_MFA_REQUIRED");
  assert.equal(I.authorize({ subject: { ...subject, mfaAt: null }, action: "integration.approve", grants: [platform], now }).reason, "RECENT_MFA_REQUIRED");
  assert.equal(I.authorize({ subject, action: "integration.approve", grants: null, now }).reason, "POLICY_UNAVAILABLE");
  assert.equal(I.authorize({ subject, action: "wallet.refund", grants: [platform], now }).reason, "UNKNOWN_ACTION");
  const op = I.authorize({ subject, productId: "synthetic-third", action: "operation.submit", grants: [productGrant({ actions: ["operation.submit"] })], now });
  assert.equal(op.requirements.independentApproval, true);
});

test("independent actor separation", () => {
  assert.equal(I.requireIndependentActor("staff-2", ["staff-1"]), true);
  assert.equal(I.requireIndependentActor("staff-1", ["staff-1", null]), false);
});

test("delegation tokens are signed, bound, short-lived and strict", () => {
  const key = Buffer.alloc(32, 7);
  const keys = { k1: { key } };
  const binding = I.requestBinding("GET", "/internal/pic/v1/products", Buffer.alloc(0));
  const token = I.signDelegation({ iss: "central-admin-api", aud: "product-integration-core", sub: "staff-1", sid: "sess-1", auth_time: nowS - 60, mfa_at: nowS - 30, tier: "SUPER", bnd: binding }, { key, kid: "k1", typ: I.TYPES.HQ, now });
  const opts = { keys, typ: I.TYPES.HQ, issuer: "central-admin-api", audience: "product-integration-core", binding, now };
  assert.equal(I.verifyDelegation(token, opts).sub, "staff-1");
  const fail = (t, o, reason) => assert.throws(() => I.verifyDelegation(t, { ...opts, ...o }), (e) => e.reason === reason, reason);
  fail(token, { binding: I.requestBinding("POST", "/internal/pic/v1/products", Buffer.from("{}")) }, "BINDING_MISMATCH");
  fail(token, { now: now + 120000 }, "LIFETIME_INVALID");
  fail(token, { audience: "karryam" }, "AUDIENCE_INVALID");
  fail(token, { typ: I.TYPES.PRODUCT }, "HEADER_INVALID");
  fail(token, { keys: { k1: { key: Buffer.alloc(32, 8) } } }, "SIGNATURE_INVALID");
  fail(token, { keys: {} }, "KEY_UNKNOWN");
  const parts = token.split(".");
  const forged = parts[0] + "." + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url")), sub: "staff-9" })).toString("base64url") + "." + parts[2];
  fail(forged, {}, "SIGNATURE_INVALID");
  assert.throws(() => I.signDelegation({ iss: "x", aud: "y", sub: "s", sid: "s", auth_time: 1, bnd: binding, role: "SUPER" }, { key, kid: "k1", typ: I.TYPES.HQ, now }), /CLAIM_NOT_ALLOWED/);
  assert.throws(() => I.signDelegation({}, { key, kid: "k1", typ: I.TYPES.HQ, ttlSeconds: 3600 }), /TTL_INVALID/);
  assert.throws(() => I.signDelegation({}, { key: Buffer.alloc(8), kid: "k1", typ: I.TYPES.HQ }), /KEY_INVALID/);
});

test("a malformed explicit deny still denies instead of being ignored", () => {
  const allow = productGrant();
  const brokenDeny = productGrant({ id: "g-deny", effect: "DENY", actions: ["metric.read", "not.a.real.action"] });
  const r = I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", grants: [allow, brokenDeny], now });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "POLICY_INVALID");
  // An expired malformed deny no longer applies.
  const expired = productGrant({ id: "g-deny", effect: "DENY", actions: ["metric.read", "not.a.real.action"], expires_at: new Date(now - 1000).toISOString() });
  assert.equal(I.authorize({ subject, productId: "synthetic-third", action: "metric.read", datasetId: "synthetic.daily_activity", grants: [allow, expired], now }).allowed, true);
});
