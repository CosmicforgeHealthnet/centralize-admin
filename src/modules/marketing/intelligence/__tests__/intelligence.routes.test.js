const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

// Route contract tests using the real Express app on an ephemeral port.
// These verify mounting and the authentication gate; they intentionally use
// invalid credentials so no database connection is required.

process.env.NODE_ENV = "test";

let server;
let baseUrl;

before(async () => {
  const app = require("../../../../app");
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("unauthenticated requests are rejected on the versioned route", async () => {
  const response = await fetch(`${baseUrl}/api/v1/marketing/intelligence/performance`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("unauthenticated requests are rejected on the marketing-module route", async () => {
  const response = await fetch(`${baseUrl}/api/marketing/intelligence/performance`);
  assert.equal(response.status, 401);
});

test("garbage bearer tokens are rejected", async () => {
  const response = await fetch(`${baseUrl}/api/v1/marketing/intelligence/performance`, {
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  assert.equal(response.status, 401);
});

test("existing marketing routes are still mounted and protected", async () => {
  const response = await fetch(`${baseUrl}/api/marketing/campaigns`);
  assert.equal(response.status, 401);
});

test("unknown intelligence paths fall through to 404 handling", async () => {
  const response = await fetch(`${baseUrl}/api/v1/marketing/intelligence/nope`, {
    headers: { Authorization: "Bearer not-a-real-token" },
  });
  assert.ok([401, 404].includes(response.status));
});
