"use strict";

// Section 13.1 unit coverage for security-critical helpers whose failure
// branches were previously exercised only indirectly: sealed continuation
// tokens, log redaction, durable replay claims and sensitive-access records.
// No database or network: pools are minimal fakes that record queries.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { createContinuation, ContinuationError, TTL_MS } = require("../src/modules/continuation");
const { createLogger, redact } = require("../src/logger");
const { pgNonceStore, memoryNonceStore } = require("../src/security/nonce-store");
const { pgAccessLog, memoryAccessLog } = require("../src/db/access-log");

const BINDING = Object.freeze({ staff: "staff-1", capability: "customer.resources.customers.list", collection: "customers", scope: { market: "NG-LAGOS" }, filters: {} });

function reason(fn) {
  try { fn(); } catch (err) { assert.ok(err instanceof ContinuationError, String(err)); return err.reason; }
  assert.fail("expected a ContinuationError");
}

test("continuation: requires a 32-byte key", () => {
  assert.throws(() => createContinuation(randomBytes(16)), /cursor_key_required/);
  assert.throws(() => createContinuation("not-a-buffer-but-long-enough-0123456789"), /cursor_key_required/);
});

test("continuation: round trip keeps cursor, snapshot and window", () => {
  const c = createContinuation(randomBytes(32));
  const token = c.seal(BINDING, "bridge-cursor-1", "2026-11-01T00:00:00Z", { from: "a", to: "b" });
  assert.deepEqual(c.open(token, BINDING), { bridgeCursor: "bridge-cursor-1", snapshotAsOf: "2026-11-01T00:00:00Z", window: { from: "a", to: "b" } });
  const bare = c.seal(BINDING, "bridge-cursor-2");
  assert.deepEqual(c.open(bare, BINDING), { bridgeCursor: "bridge-cursor-2", snapshotAsOf: null, window: null });
});

test("continuation: unsupported source cursors are refused before sealing", () => {
  const c = createContinuation(randomBytes(32));
  for (const bad of ["", 42, null, "x".repeat(1025)]) assert.equal(reason(() => c.seal(BINDING, bad)), "SOURCE_CURSOR_UNSUPPORTED");
});

test("continuation: malformed, short, tampered and foreign-key tokens are invalid", () => {
  const c = createContinuation(randomBytes(32));
  const other = createContinuation(randomBytes(32));
  const token = c.seal(BINDING, "cursor");
  assert.equal(reason(() => c.open(42, BINDING)), "CONTINUATION_INVALID");
  assert.equal(reason(() => c.open("not base64url!*", BINDING)), "CONTINUATION_INVALID");
  assert.equal(reason(() => c.open("A".repeat(20), BINDING)), "CONTINUATION_INVALID", "decodes shorter than iv + tag");
  const raw = Buffer.from(token, "base64url");
  raw[14] ^= 0xff;
  assert.equal(reason(() => c.open(raw.toString("base64url"), BINDING)), "CONTINUATION_INVALID", "tampered ciphertext");
  assert.equal(reason(() => other.open(token, BINDING)), "CONTINUATION_INVALID", "another key");
});

test("continuation: binding mismatch never widens scope, and tokens expire", () => {
  let t = 1_000_000;
  const c = createContinuation(randomBytes(32), { now: () => t });
  const token = c.seal(BINDING, "cursor");
  assert.equal(reason(() => c.open(token, { ...BINDING, scope: { market: "GH-ACCRA" } })), "CONTINUATION_BINDING_MISMATCH");
  assert.equal(reason(() => c.open(token, { ...BINDING, staff: "staff-2" })), "CONTINUATION_BINDING_MISMATCH");
  t += TTL_MS;
  assert.equal(reason(() => c.open(token, BINDING)), "CONTINUATION_EXPIRED");
});

test("redact: sensitive keys are removed at any depth; long strings and wide arrays are bounded", () => {
  const out = redact({
    event: "x", token: "t", Authorization: "Bearer a", cookie: "c", password: "p", key: "k", key_b64url: "kb", private_key: "pk",
    nested: { signature: "s", headers: { a: 1 }, body: "raw", ok: "visible", deeper: { delegation: "d", assertion: "a", fine: 1 } },
    long: "y".repeat(500), list: Array.from({ length: 20 }, (_, i) => i), n: 3, b: false, none: null, undef: undefined,
    fn() {}, deep: { a: { b: { c: { d: { e: 1 } } } } },
  });
  for (const k of ["token", "Authorization", "cookie", "password", "key", "key_b64url", "private_key"]) assert.equal(out[k], "[redacted]", k);
  assert.equal(out.nested.signature, "[redacted]");
  assert.equal(out.nested.headers, "[redacted]");
  assert.equal(out.nested.body, "[redacted]");
  assert.equal(out.nested.ok, "visible");
  assert.equal(out.nested.deeper.delegation, "[redacted]");
  assert.equal(out.nested.deeper.assertion, "[redacted]");
  assert.equal(out.long.length, 201);
  assert.equal(out.list.length, 10);
  assert.equal(out.n, 3);
  assert.equal(out.b, false);
  assert.equal(out.none, null);
  assert.equal(out.fn, "[unsupported]");
  assert.equal(out.deep.a.b.c, "[truncated]");
  assert.equal(JSON.stringify(out).includes("Bearer"), false);
});

test("logger: writes one redacted JSON line and never throws", () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), service: "karryam-admin-test" });
  log({ event: "request", token: "secret-token-value", status: 200 });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.service, "karryam-admin-test");
  assert.equal(parsed.token, "[redacted]");
  assert.ok(parsed.ts);
  assert.equal(lines[0].includes("secret-token-value"), false);
  const throwing = createLogger({ write: () => { throw new Error("disk full"); } });
  assert.doesNotThrow(() => throwing({ event: "x" }));
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => log({ circular }));
});

function fakePool({ rowCount = 1, fail = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (fail) throw new Error("db_down");
      return { rowCount };
    },
  };
}

test("pg nonce store: malformed inputs are refused without touching the database", async () => {
  const pool = fakePool();
  const store = pgNonceStore(pool);
  assert.equal(await store.claim("Bad Namespace", "nonce-12345", Date.now() + 1000), false);
  assert.equal(await store.claim("svc", "short", Date.now() + 1000), false);
  assert.equal(await store.claim("svc", "nonce-12345", Number.NaN), false);
  assert.equal(pool.queries.length, 0);
});

test("pg nonce store: atomic claim, replay refused, expiry clamped to now, periodic cleanup", async () => {
  const fresh = fakePool({ rowCount: 1 });
  const replay = fakePool({ rowCount: 0 });
  const now = () => 5_000_000;
  assert.equal(await pgNonceStore(fresh, { now }).claim("svc", "nonce-12345", 1000), true);
  assert.equal(fresh.queries[0].params[2], 5_000_000, "an already-expired claim is stored at least until now");
  assert.equal(await pgNonceStore(replay, { now }).claim("svc", "nonce-12345", 9_000_000), false);
  const cleaning = fakePool({ rowCount: 1 });
  const store = pgNonceStore(cleaning, { cleanupEvery: 2 });
  await store.claim("svc", "nonce-a-1234", Date.now() + 1000);
  await store.claim("svc", "nonce-b-1234", Date.now() + 1000);
  assert.ok(cleaning.queries.some((q) => /^DELETE FROM karryam_admin\.request_nonces/.test(q.sql)));
});

test("pg nonce store: infrastructure failure propagates (the protocol kit fails closed)", async () => {
  await assert.rejects(pgNonceStore(fakePool({ fail: true })).claim("svc", "nonce-12345", Date.now() + 1000), /db_down/);
});

test("memory nonce store: one claim per namespace and nonce", async () => {
  const s = memoryNonceStore();
  assert.equal(await s.claim("a", "n1"), true);
  assert.equal(await s.claim("a", "n1"), false);
  assert.equal(await s.claim("b", "n1"), true);
});

test("sensitive access log: unsafe fields are dropped or refused; nothing is recorded on failure", async () => {
  const pool = fakePool();
  const log = pgAccessLog(pool);
  await log.record({ correlationId: "corr-1", staffRef: "staff-1", capabilityId: "karryam.customers.read", privacyClass: "PERSONAL", purpose: "case_review", scope: { market: "NG-LAGOS", zone: "bad zone!", tenant: 7 }, outcome: "ALLOWED", itemCount: 3 });
  const p = pool.queries[0].params;
  assert.deepEqual(p, ["corr-1", "staff-1", "karryam.customers.read", "PERSONAL", "case_review", JSON.stringify({ market: "NG-LAGOS" }), "ALLOWED", 3]);
  await log.record({ correlationId: "bad id with spaces", staffRef: "staff-1", capabilityId: "cap", privacyClass: "bad class!", purpose: "", outcome: "DENIED", itemCount: -1 });
  assert.deepEqual(pool.queries[1].params, [null, "staff-1", "cap", "UNCLASSIFIED", null, "{}", "DENIED", null]);
  for (const bad of [{ staffRef: "has space", capabilityId: "cap", outcome: "OK" }, { staffRef: "s", capabilityId: "", outcome: "OK" }, { staffRef: "s", capabilityId: "cap", outcome: "lower" }]) {
    await assert.rejects(log.record(bad), /access_log_entry_invalid/);
  }
  assert.equal(pool.queries.length, 2);
  await assert.rejects(pgAccessLog(fakePool({ fail: true })).record({ staffRef: "s", capabilityId: "cap", outcome: "OK" }), /db_down/);
  const mem = memoryAccessLog();
  await mem.record({ staffRef: "s", capabilityId: "cap", outcome: "OK" });
  assert.equal(mem.rows.length, 1);
  await assert.rejects(memoryAccessLog({ fail: true }).record({ staffRef: "s", capabilityId: "cap", outcome: "OK" }), /access_log_unavailable/);
});
