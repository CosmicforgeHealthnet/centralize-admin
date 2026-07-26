const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { closeServer } = require("../../../../../tests/helpers/server-close");
const { createExecutionRouter } = require("../execution.routes");
const { createExecutionController } = require("../execution.controller");
const { createExecutionService } = require("../execution.service");
const { errorHandler } = require("../../../../shared/middlewares/error.middleware");

process.env.NODE_ENV = "test";

function instrumentedRouter() {
  const auth = (_req, _res, next) => next();
  auth._executionAuth = true;
  const sectionGate = (module, section, mode) => {
    const middleware = (_req, _res, next) => next();
    middleware._executionRbac = { module, section, mode };
    return middleware;
  };
  const controller = Object.fromEntries(["getCapabilities", "getLifecycle", "preflight"].map((name) => {
    const handler = (_req, _res, next) => next?.();
    handler._executionController = name;
    return [name, handler];
  }));
  return createExecutionRouter({ controller, authenticateMiddleware: auth, sectionGate });
}

test("safe route inventory uses existing marketing VIEW and EDIT gates", () => {
  const router = instrumentedRouter();
  assert.equal(router.stack[0].handle._executionAuth, true);
  const routes = router.stack.filter((layer) => layer.route).map((layer) => {
    const handlers = layer.route.stack.map((entry) => entry.handle);
    return {
      method: Object.keys(layer.route.methods)[0].toUpperCase(),
      path: layer.route.path,
      rbac: handlers.find((handler) => handler._executionRbac)?._executionRbac,
      controller: handlers.find((handler) => handler._executionController)?._executionController,
    };
  });
  assert.deepEqual(routes, [
    { method: "GET", path: "/capabilities", rbac: { module: "marketing", section: "advertising-execution", mode: "VIEW" }, controller: "getCapabilities" },
    { method: "GET", path: "/lifecycle", rbac: { module: "marketing", section: "advertising-execution", mode: "VIEW" }, controller: "getLifecycle" },
    { method: "POST", path: "/preflight", rbac: { module: "marketing", section: "advertising-execution", mode: "EDIT" }, controller: "preflight" },
  ]);
});

let server;
let baseUrl;
let scaffoldServer;
let scaffoldBaseUrl;

before(async () => {
  const app = require("../../../../app");
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const scaffoldApp = express();
  scaffoldApp.use(express.json());
  scaffoldApp.use("/api/v1/marketing/advertising-execution", createExecutionRouter({
    controller: createExecutionController({ service: createExecutionService({ env: {} }) }),
    authenticateMiddleware: (req, _res, next) => { req.adminUser = { id: "test-admin" }; next(); },
    sectionGate: () => (_req, _res, next) => next(),
  }));
  scaffoldApp.use(errorHandler);
  await new Promise((resolve) => { scaffoldServer = scaffoldApp.listen(0, resolve); });
  scaffoldBaseUrl = `http://127.0.0.1:${scaffoldServer.address().port}`;
});

after(async () => {
  await closeServer(server);
  await closeServer(scaffoldServer);
});

test("advertising execution router is mounted and rejects unauthenticated callers", async () => {
  const response = await fetch(`${baseUrl}/api/v1/marketing/advertising-execution/capabilities`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
});

test("existing Marketing and Marketing Intelligence routes remain mounted", async () => {
  const [marketing, intelligence] = await Promise.all([
    fetch(`${baseUrl}/api/marketing/campaigns`),
    fetch(`${baseUrl}/api/v1/marketing/intelligence/performance`),
  ]);
  assert.equal(marketing.status, 401);
  assert.equal(intelligence.status, 401);
});

test("disabled preflight returns the stable execution error envelope", async () => {
  const response = await fetch(`${scaffoldBaseUrl}/api/v1/marketing/advertising-execution/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "META",
      connectionId: "11111111-1111-4111-8111-111111111111",
      accountId: "account-1",
      currencyCode: "USD",
      objective: "CONVERSIONS",
      operations: [{ type: "CREATE_CAMPAIGN", parameters: {} }],
    }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "EXECUTION_DISABLED");
  assert.equal(body.success, false);
});

test("raw provider mutation bodies are rejected before any capability lookup", async () => {
  const response = await fetch(`${scaffoldBaseUrl}/api/v1/marketing/advertising-execution/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "META",
      connectionId: "11111111-1111-4111-8111-111111111111",
      accountId: "account-1",
      currencyCode: "USD",
      objective: "CONVERSIONS",
      operations: [{ type: "CREATE_CAMPAIGN", parameters: { provider_payload: { campaign: {} } } }],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "RAW_PROVIDER_PAYLOAD_FORBIDDEN");
});
