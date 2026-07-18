const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";

const {
  SECTION8_ROUTE_DEFINITIONS,
  SECTION8_AUTH_ROUTES,
  SECTION8_PUBLIC_ROUTES,
} = require("../src/modules/marketing/social-operations/routes/social.routes");

let server;
let baseUrl;

before(async () => {
  const app = require("../src/app");
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("versioned Social Operations API is mounted and auth-protected", async () => {
  const root = await fetch(`${baseUrl}/api/v1/marketing/social`);
  assert.equal(root.status, 401);

  const connections = await fetch(`${baseUrl}/api/v1/marketing/social/connections`);
  assert.equal(connections.status, 401);

  const legacy = await fetch(`${baseUrl}/api/marketing/social/connections`);
  assert.notEqual(legacy.status, 200);
});

test("all Section 8 route definitions are present on the new base path", () => {
  assert.equal(SECTION8_ROUTE_DEFINITIONS.length, 71);
  assert.equal(SECTION8_PUBLIC_ROUTES.length, 3);
  assert.equal(SECTION8_AUTH_ROUTES.length, 68);

  const routeKeys = new Set(
    SECTION8_ROUTE_DEFINITIONS.map((route) => `${route.method.toUpperCase()} ${route.path}`),
  );

  for (const expected of [
    "GET /connections",
    "POST /connections/:provider/oauth/start",
    "GET /oauth/:provider/callback",
    "POST /posts/:id/submit",
    "POST /posts/:id/publish",
    "POST /posts/:id/schedule",
    "POST /identities/:id/sync-content",
    "POST /conversations/:id/reply",
    "POST /comments/:id/hide",
    "GET /operations",
    "PATCH /settings",
    "POST /webhooks/:provider",
  ]) {
    assert.ok(routeKeys.has(expected), `${expected} is missing`);
  }
});

test("public routes are verified rather than open trust routes", () => {
  const verificationByPath = Object.fromEntries(
    SECTION8_PUBLIC_ROUTES.map((route) => [
      `${route.method.toUpperCase()} ${route.path}`,
      route.verification,
    ]),
  );
  assert.equal(verificationByPath["GET /oauth/:provider/callback"], "state");
  assert.equal(verificationByPath["GET /webhooks/:provider"], "provider-challenge");
  assert.equal(verificationByPath["POST /webhooks/:provider"], "signature");
});

test("webhook POST rejects invalid signatures before accepting payloads", async () => {
  const response = await fetch(`${baseUrl}/api/v1/marketing/social/webhooks/META`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "evt-invalid" }),
  });
  assert.equal(response.status, 401);
});
