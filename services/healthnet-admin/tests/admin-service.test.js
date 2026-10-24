"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createHmac } = require("node:crypto");
const { createHandler } = require("../src/app");
const { adapt } = require("../src/contracts");
const { loadConfig } = require("../src/config");

const SECRET = "a-test-only-service-secret-with-more-than-32-bytes";
const BASE = {
  NODE_ENV: "test",
  HEALTHNET_INTERNAL_JWT_SECRET: SECRET,
  HEALTHNET_ALLOW_INSECURE_UPSTREAM: "true",
  HEALTHNET_PLATFORM_ADMIN_BASE_URL: "http://127.0.0.1:3333",
  HEALTHNET_PLATFORM_ADMIN_TOKEN: "fake-owner-token",
  HEALTHNET_PLATFORM_ADMIN_METRICS_PATH: "/api/admin/v1/dashboard/metrics",
};
function sign(data = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "central-admin-hq", aud: "healthnet-admin",
    sub: "staff-123", scopes: ["healthnet:dashboard:read"],
    iat: now, exp: now + 60, ...data,
  })).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(header + "." + payload).digest("base64url");
  return header + "." + payload + "." + sig;
}
async function request(handler, path, token = null) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const res = await fetch("http://127.0.0.1:" + address.port + path, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("config never silently starts without a strong internal signing secret", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test", HEALTHNET_INTERNAL_JWT_SECRET: "short" }), /32 bytes/);
  assert.equal(loadConfig({ HEALTHNET_INTERNAL_JWT_SECRET: SECRET }).ready, false);
  assert.throws(() => loadConfig({ ...BASE, NODE_ENV: "production" }), /BASE_URL/);
  assert.throws(() => loadConfig({ ...BASE, HEALTHNET_PLATFORM_ADMIN_METRICS_PATH: "//evil.example" }), /mapping/);
});

test("live health works without a product DB and readiness truthfully reports configuration", async () => {
  const handler = createHandler({ env: { HEALTHNET_INTERNAL_JWT_SECRET: SECRET } });
  assert.equal((await request(handler, "/health/live")).status, 200);
  const ready = await request(handler, "/health/ready");
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, "NOT_CONFIGURED");
});

test("internal endpoints reject anonymous, forged, expired, wrong-audience and missing-scope tokens", async () => {
  const handler = createHandler({ env: BASE });
  assert.equal((await request(handler, "/v1/dashboard/metrics")).status, 401);
  assert.equal((await request(handler, "/v1/dashboard/metrics", sign({ aud: "other" }))).status, 401);
  assert.equal((await request(handler, "/v1/dashboard/metrics", sign({ exp: Math.floor(Date.now() / 1000) - 1 }))).status, 401);
  assert.equal((await request(handler, "/v1/dashboard/metrics", sign({ scopes: [] }))).status, 401);
  const tampered = sign().replace(/.$/, "x");
  assert.equal((await request(handler, "/v1/dashboard/metrics", tampered)).status, 401);
});

test("source offline returns structured 503 and never fake zero statistics", async () => {
  const handler = createHandler({
    env: BASE,
    fetchImpl: async () => { throw new Error("ECONNREFUSED private IP"); },
  });
  const res = await request(handler, "/v1/dashboard/metrics", sign());
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(res.body.error.retryable, true);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal("data" in res.body, false);
});

test("only owner-approved aggregate fields cross the boundary; clinical payload is dropped", async () => {
  const handler = createHandler({
    env: BASE,
    fetchImpl: async (target, options) => {
      assert.equal(target.pathname, "/api/admin/v1/dashboard/metrics");
      assert.equal(options.headers.Authorization, "Bearer fake-owner-token");
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({
        success: true, data: {
          totalDoctors: 2, totalPatients: 9, totalAppointments: 3, balance: 40,
          patientName: "SHOULD NEVER LEAVE THE SERVICE",
          clinicalRecord: { diagnosis: "DO NOT EXPOSE" },
        },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  const res = await request(handler, "/v1/dashboard/metrics", sign());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    totalAppointments: 3, totalDoctors: 2, totalPatients: 9, balance: 40,
  });
  assert.equal(JSON.stringify(res.body).includes("SHOULD NEVER"), false);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("unknown or unmapped operations fail closed", async () => {
  const handler = createHandler({ env: BASE });
  assert.equal((await request(handler, "/v1/dashboard/charts/revenue", sign())).status, 501);
  assert.equal((await request(handler, "/v1/clinical/patient/123", sign())).status, 404);
  assert.equal((await request(handler, "/v1/dashboard/metrics?url=https://bad", sign())).status, 400);
});

test("upstream programming/contract errors are not masked as offline or zero data", async () => {
  const handler = createHandler({
    env: BASE,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, data: { totalPatients: 1 } }), {
      headers: { "content-type": "application/json" },
    }),
  });
  const res = await request(handler, "/v1/dashboard/metrics", sign());
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, "CONTRACT_MISMATCH");
  assert.equal("data" in res.body, false);
});

test("safe contract adapters reject record arrays and invalid metrics", () => {
  assert.equal(adapt("/v1/dashboard/metrics", [{ name: "patient" }]), null);
  assert.equal(adapt("/v1/dashboard/metrics", {
    totalAppointments: 1, totalDoctors: -1, totalPatients: 1, balance: 0,
  }), null);
  assert.deepEqual(adapt("/v1/dashboard/charts/patients", {
    selectedMonth: "March", data: [{ month: "Mar", value: 50, patientName: "discard" }],
  }), { selectedMonth: "March", data: [{ month: "Mar", value: 50 }] });
});
