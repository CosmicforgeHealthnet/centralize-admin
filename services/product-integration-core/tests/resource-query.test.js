"use strict";

// Protocol 1.1 resource-read query forwarding (no database): what PIC passes
// to the Product Admin for list and detail reads, including the optional
// search (`q`) and nested-list (`parent`) keys.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readQuery, resourceQueryKeys, ProductError } = require("../src/api/products");

const scope = "market=GLOBAL&organization=cfmeet&zone=production&tenant=t1&purpose=support";
const reason = (fn) => { try { fn(); return null; } catch (err) { assert.ok(err instanceof ProductError); return err.reason; } };

test("list reads forward q and parent with the scope and paging keys", () => {
  const listKeys = resourceQueryKeys(false);
  for (const key of ["q", "parent", "limit", "continuation"]) assert.ok(listKeys.includes(key), key);
  const forwarded = readQuery(new URLSearchParams(scope + "&limit=25&q=ada%20lovelace&parent=user_123"), listKeys);
  assert.deepEqual(forwarded, { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "t1", purpose: "support", limit: 25, q: "ada lovelace", parent: "user_123" });
  assert.equal(readQuery(new URLSearchParams(scope + "&q=" + encodeURIComponent("Zoë Ångström 東京 a.b@c:d-e_f")), listKeys).q, "Zoë Ångström 東京 a.b@c:d-e_f", "unicode letters and digits are allowed");
  assert.deepEqual(Object.keys(readQuery(new URLSearchParams(scope), listKeys)), ["market", "organization", "zone", "tenant", "purpose"], "both stay optional");
});

test("list reads reject malformed q and parent values", () => {
  const listKeys = resourceQueryKeys(false);
  for (const bad of ["q=", "q=" + "a".repeat(129), "q=a%26b", "q=%3Cscript%3E", "q=a%2Fb", "q=a%0Ab", "q=50%25", "parent=", "parent=-lead", "parent=a%2Fb", "parent=a%20b", "parent=" + "p".repeat(129)]) {
    assert.equal(reason(() => readQuery(new URLSearchParams(scope + "&" + bad), listKeys)), "INVALID_PARAMETER", bad);
  }
  assert.equal(reason(() => readQuery(new URLSearchParams(scope + "&q=a&q=b"), listKeys)), "DUPLICATE_PARAMETER");
  assert.equal(reason(() => readQuery(new URLSearchParams(scope + "&search=a"), listKeys)), "UNKNOWN_PARAMETER", "the allowlist stays exact");
});

test("detail reads never forward q, parent, limit or continuation", () => {
  const detailKeys = resourceQueryKeys(true);
  assert.deepEqual(detailKeys, ["market", "organization", "zone", "tenant", "purpose", "start", "end"]);
  for (const extra of ["q=ada", "parent=user_123", "limit=5", "continuation=" + "c".repeat(20)]) {
    assert.equal(reason(() => readQuery(new URLSearchParams(scope + "&" + extra), detailKeys)), "UNKNOWN_PARAMETER", extra);
  }
  assert.deepEqual(readQuery(new URLSearchParams(scope), detailKeys), { market: "GLOBAL", organization: "cfmeet", zone: "production", tenant: "t1", purpose: "support" });
});
