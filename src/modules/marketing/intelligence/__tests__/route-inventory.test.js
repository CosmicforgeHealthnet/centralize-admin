const test = require("node:test");
const assert = require("node:assert/strict");

const BASE = "/api/v1/marketing/intelligence";
const REQUIRED = [
  ["GET", "/creatives", "VIEW"], ["GET", "/creatives/:id", "VIEW"], ["POST", "/creatives/sync", "EDIT"], ["POST", "/creatives/score", "EDIT"],
  ["GET", "/recommendations", "VIEW"], ["GET", "/recommendations/:id", "VIEW"], ["POST", "/recommendations/evaluate", "EDIT"], ["PATCH", "/recommendations/:id/accept", "EDIT"], ["PATCH", "/recommendations/:id/dismiss", "EDIT"], ["POST", "/recommendations/:id/convert-to-task", "EDIT"],
  ["GET", "/alerts", "VIEW"], ["GET", "/alerts/:id", "VIEW"], ["POST", "/alerts/evaluate", "EDIT"], ["PATCH", "/alerts/:id/acknowledge", "EDIT"], ["PATCH", "/alerts/:id/resolve", "EDIT"],
  ["GET", "/experiments", "VIEW"], ["GET", "/experiments/:id", "VIEW"], ["POST", "/experiments", "EDIT"], ["PATCH", "/experiments/:id", "EDIT"], ["POST", "/experiments/:id/start", "EDIT"], ["POST", "/experiments/:id/complete", "EDIT"], ["POST", "/experiments/:id/cancel", "EDIT"],
  ["GET", "/settings", "VIEW"], ["PATCH", "/settings", "EDIT"],
  ["GET", "/evaluation-runs", "VIEW"], ["GET", "/evaluation-runs/:id", "VIEW"],
];

const APPROVED_EXTRA = new Set([
  "POST /attribution/clicks", "GET /oauth/:platform/callback", "GET /performance",
  "GET /creatives/:id/scores/latest", "GET /creatives/:id/scores", "GET /provider-validation",
  "GET /connections", "GET /connections/:id", "POST /connections", "PATCH /connections/:id",
  "POST /connections/bootstrap", "POST /connections/:id/disable", "POST /connections/:id/enable",
  "POST /connections/:id/test", "POST /connections/:id/validation-evidence", "DELETE /connections/:id",
  "GET /oauth/:platform/start", "POST /sync",
]);

function loadInstrumentedRouter() {
  const routePath = require.resolve("../intelligence.routes");
  const rbacPath = require.resolve("../../../../shared/middlewares/rbac.middleware");
  const controllerPath = require.resolve("../intelligence.controller");
  const previous = { route: require.cache[routePath], rbac: require.cache[rbacPath], controller: require.cache[controllerPath] };
  delete require.cache[routePath];
  require.cache[rbacPath] = { id: rbacPath, filename: rbacPath, loaded: true, exports: {
    requireSection: (_module, _section, mode) => { const middleware = (_req, _res, next) => next(); middleware._miRbac = mode; return middleware; },
    requireTier: (tier) => { const middleware = (_req, _res, next) => next(); middleware._miTier = tier; return middleware; },
  } };
  require.cache[controllerPath] = { id: controllerPath, filename: controllerPath, loaded: true, exports: new Proxy({}, { get: (_target, name) => { const controller = (_req, _res, next) => next?.(); controller._miController = String(name); return controller; } }) };
  const router = require(routePath);
  for (const [key, value] of Object.entries(previous)) {
    const cachePath = key === "route" ? routePath : key === "rbac" ? rbacPath : controllerPath;
    if (value) require.cache[cachePath] = value; else delete require.cache[cachePath];
  }
  return router;
}

function inventory() {
  return loadInstrumentedRouter().stack.filter((layer) => layer.route).flatMap((layer, order) => Object.keys(layer.route.methods).map((method) => {
    const handlers = layer.route.stack.map((item) => item.handle);
    return {
      order,
      method: method.toUpperCase(),
      path: layer.route.path,
      fullPath: `${BASE}${layer.route.path}`,
      rbac: handlers.find((handler) => handler._miRbac)?._miRbac || "PUBLIC",
      controller: handlers.find((handler) => handler._miController)?._miController || null,
    };
  }));
}

test("runtime router contains the exact 26 required endpoints plus 18 approved earlier-phase extensions", () => {
  const routes = inventory();
  const identities = routes.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(identities).size, identities.length, "duplicate method/path route");
  const requiredIdentities = new Set(REQUIRED.map(([method, path]) => `${method} ${path}`));
  assert.equal(requiredIdentities.size, 26);
  assert.deepEqual(identities.filter((identity) => requiredIdentities.has(identity)).sort(), [...requiredIdentities].sort());
  assert.deepEqual(new Set(identities.filter((identity) => !requiredIdentities.has(identity))), APPROVED_EXTRA);
  assert.equal(routes.length, 44);
});

test("runtime route middleware enforces VIEW on required reads and EDIT on required mutations", () => {
  const byIdentity = new Map(inventory().map((route) => [`${route.method} ${route.path}`, route]));
  for (const [method, path, rbac] of REQUIRED) {
    const route = byIdentity.get(`${method} ${path}`);
    assert.ok(route?.controller, `${method} ${path} controller`);
    assert.equal(route.rbac, rbac, `${method} ${path}`);
  }
});

test("static action routes precede dynamic resource routes and experiment actions remain distinct", () => {
  const routes = inventory();
  const position = (method, path) => routes.find((route) => route.method === method && route.path === path).order;
  assert.ok(position("POST", "/creatives/sync") < position("GET", "/creatives/:id"));
  assert.ok(position("POST", "/creatives/score") < position("GET", "/creatives/:id"));
  assert.ok(position("POST", "/recommendations/evaluate") < position("GET", "/recommendations/:id"));
  assert.ok(position("POST", "/alerts/evaluate") < position("GET", "/alerts/:id"));
  for (const action of ["start", "complete", "cancel"]) assert.ok(routes.some((route) => route.method === "POST" && route.path === `/experiments/:id/${action}`));
  assert.equal(routes.some((route) => route.path === "/:id"), false);
});

module.exports = { BASE, REQUIRED, APPROVED_EXTRA, inventory };
