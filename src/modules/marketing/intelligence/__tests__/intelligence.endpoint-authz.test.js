const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const Module = require("node:module");
const express = require("express");

const ApiError = require("../../../../shared/utils/ApiError");
const { errorHandler } = require("../../../../shared/middlewares/error.middleware");

process.env.NODE_ENV = "test";

function clearRouteCache() {
  for (const id of [
    require.resolve("../intelligence.routes"),
    require.resolve("../intelligence.controller"),
    require.resolve("../intelligence.service"),
  ]) {
    delete require.cache[id];
  }
}

function createHarness() {
  const originalLoad = Module._load;
  const serviceCalls = [];
  const rbacRequirements = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request.includes("auth.middleware")) {
      return {
        authenticate(req, res, next) {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return next(new ApiError(401, "No token provided"));
          }

          req.adminUser = {
            id: "admin-1",
            tier: req.get("x-super") === "true" ? "SUPER" : "ADMIN",
          };
          return next();
        },
      };
    }

    if (request.includes("rbac.middleware")) {
      return {
        requireSection(moduleName, section, mode = "VIEW") {
          rbacRequirements.push({ moduleName, section, mode });
          return (req, res, next) => {
            if (req.adminUser?.tier === "SUPER" || req.get("x-section-grant") === "true") {
              return next();
            }
            return next(new ApiError(403, "You do not have access to this section"));
          };
        },
      };
    }

    if (request === "./intelligence.service" || request.endsWith("/intelligence.service")) {
      return {
        async getPerformanceDashboard(query) {
          serviceCalls.push(query);
          return {
            filters: {
              from: query.from || "2026-07-01",
              to: query.to || "2026-07-31",
              platform: query.platform || "all",
            },
            summary: {
              spend: 0,
              impressions: 0,
              clicks: 0,
              signups: 0,
              activeUsers: 0,
              payments: 0,
              revenue: 0,
              cpa: 0,
              conversionRate: 0,
            },
            campaigns: [],
          };
        },
      };
    }

    return originalLoad.apply(this, arguments);
  };

  clearRouteCache();
  const router = require("../intelligence.routes");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/marketing/intelligence", router);
  app.use(errorHandler);

  return {
    app,
    serviceCalls,
    rbacRequirements,
    restore() {
      Module._load = originalLoad;
      clearRouteCache();
    },
  };
}

async function fetchFromApp(app, path, options = {}) {
  const server = app.listen(0);
  await once(server, "listening");
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  try {
    return await fetch(baseUrl + path, options);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("performance endpoint rejects missing bearer auth", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(harness.app, "/api/v1/marketing/intelligence/performance");
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
    assert.equal(harness.serviceCalls.length, 0);
  } finally {
    harness.restore();
  }
});

test("performance endpoint rejects admins without the intelligence VIEW grant", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(harness.app, "/api/v1/marketing/intelligence/performance", {
      headers: { Authorization: "Bearer test-token" },
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
    assert.deepEqual(harness.rbacRequirements[0], {
      moduleName: "marketing",
      section: "intelligence",
      mode: "VIEW",
    });
    assert.equal(harness.serviceCalls.length, 0);
  } finally {
    harness.restore();
  }
});

test("performance endpoint serves authorized admins from the dashboard service", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/v1/marketing/intelligence/performance?from=2026-07-01&to=2026-07-02&platform=Meta",
      { headers: { Authorization: "Bearer test-token", "x-section-grant": "true" } },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.message, "Marketing intelligence performance retrieved");
    assert.deepEqual(harness.serviceCalls, [
      { from: "2026-07-01", to: "2026-07-02", platform: "meta" },
    ]);
    assert.deepEqual(body.data.filters, {
      from: "2026-07-01",
      to: "2026-07-02",
      platform: "meta",
    });
  } finally {
    harness.restore();
  }
});

test("performance endpoint allows SUPER admins through section RBAC", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(harness.app, "/api/v1/marketing/intelligence/performance", {
      headers: { Authorization: "Bearer test-token", "x-super": "true" },
    });

    assert.equal(response.status, 200);
    assert.equal(harness.serviceCalls.length, 1);
  } finally {
    harness.restore();
  }
});

test("performance endpoint validates date shape before service access", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/v1/marketing/intelligence/performance?from=2026-02-31&platform=tiktok",
      { headers: { Authorization: "Bearer test-token", "x-section-grant": "true" } },
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.equal(harness.serviceCalls.length, 0);
  } finally {
    harness.restore();
  }
});

test("performance endpoint validates chronological date ranges", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/v1/marketing/intelligence/performance?from=2026-07-10&to=2026-07-01",
      { headers: { Authorization: "Bearer test-token", "x-section-grant": "true" } },
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.equal(harness.serviceCalls.length, 0);
  } finally {
    harness.restore();
  }
});