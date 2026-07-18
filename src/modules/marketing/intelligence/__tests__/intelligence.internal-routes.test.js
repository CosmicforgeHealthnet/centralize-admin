const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const Module = require("node:module");
const express = require("express");

const { errorHandler } = require("../../../../shared/middlewares/error.middleware");

process.env.NODE_ENV = "test";

function clearRouteCache() {
  for (const id of [
    require.resolve("../internal.routes"),
    require.resolve("../intelligence.controller"),
    require.resolve("../funnel-ingestion.service"),
  ]) {
    delete require.cache[id];
  }
}

function createHarness() {
  const originalLoad = Module._load;
  const calls = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "./funnel-ingestion.service" || request.endsWith("/funnel-ingestion.service")) {
      return {
        async ingestEnvelope(envelope) {
          calls.push(envelope);
          return { id: "funnel-1" };
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  clearRouteCache();
  const router = require("../internal.routes");
  const app = express();
  app.use(express.json());
  app.use("/api/internal/marketing/intelligence", router);
  app.use(errorHandler);

  return {
    app,
    calls,
    restore() {
      Module._load = originalLoad;
      clearRouteCache();
      delete process.env.MARKETING_INTELLIGENCE_INTERNAL_SERVICE_KEY;
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

test("internal funnel endpoint rejects when service key is not configured", async () => {
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/internal/marketing/intelligence/funnel-events",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.equal(response.status, 503);
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.restore();
  }
});

test("internal funnel endpoint rejects invalid service keys", async () => {
  process.env.MARKETING_INTELLIGENCE_INTERNAL_SERVICE_KEY = "expected-key";
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/internal/marketing/intelligence/funnel-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-service-key": "wrong-key" },
        body: "{}",
      },
    );
    assert.equal(response.status, 401);
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.restore();
  }
});

test("internal funnel endpoint validates payloads before ingestion", async () => {
  process.env.MARKETING_INTELLIGENCE_INTERNAL_SERVICE_KEY = "expected-key";
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/internal/marketing/intelligence/funnel-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-service-key": "expected-key" },
        body: JSON.stringify({ eventId: "evt-1", eventType: "NOT_SUPPORTED", payload: {} }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.restore();
  }
});

test("internal funnel endpoint rejects invalid datetimes", async () => {
  process.env.MARKETING_INTELLIGENCE_INTERNAL_SERVICE_KEY = "expected-key";
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/internal/marketing/intelligence/funnel-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-service-key": "expected-key" },
        body: JSON.stringify({
          eventId: "signup:user-1",
          eventType: "USER_SIGNUP_COMPLETED",
          occurredAt: "not-a-date",
          payload: { userId: "user-1", anonId: "anon-1" },
        }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 0);
  } finally {
    harness.restore();
  }
});
test("internal funnel endpoint accepts valid service-key callbacks", async () => {
  process.env.MARKETING_INTELLIGENCE_INTERNAL_SERVICE_KEY = "expected-key";
  const harness = createHarness();
  try {
    const response = await fetchFromApp(
      harness.app,
      "/api/internal/marketing/intelligence/funnel-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-service-key": "expected-key" },
        body: JSON.stringify({
          eventId: "signup:user-1",
          eventType: "USER_SIGNUP_COMPLETED",
          occurredAt: "2026-07-15T10:00:00.000Z",
          payload: { userId: "user-1", anonId: "anon-1" },
        }),
      },
    );
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.success, true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].eventType, "USER_SIGNUP_COMPLETED");
  } finally {
    harness.restore();
  }
});