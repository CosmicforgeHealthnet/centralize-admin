"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createDependencyBoundary,
  isDependencyConnectivityError,
} = require("../src/shared/middlewares/dependency-boundary.middleware");

function response(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headersSent = false;
  return res;
}

test("dependency classifier distinguishes connectivity failures from ordinary errors", () => {
  assert.equal(isDependencyConnectivityError({ code: "P1001" }), true);
  assert.equal(isDependencyConnectivityError({ code: "ETIMEDOUT" }), true);
  assert.equal(isDependencyConnectivityError(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isDependencyConnectivityError({ cause: { code: "ECONNREFUSED" } }), true);
  assert.equal(isDependencyConnectivityError({ code: "P2002", message: "Unique constraint" }), false);
  assert.equal(isDependencyConnectivityError({ code: "P2025", message: "Record not found" }), false);
  assert.equal(isDependencyConnectivityError(new Error("Syntax error in application query")), false);
});

test("dependency gate returns 503 only after infrastructure failures and retries a single probe", () => {
  let now = 1000;
  const boundary = createDependencyBoundary({
    id: "healthnet",
    name: "HealthNet",
    failureThreshold: 2,
    openMs: 30000,
    clock: () => now,
  });
  const runGate = () => {
    const res = response();
    let received;
    boundary.gate({}, res, err => { received = err; });
    return { res, received };
  };
  const recordError = error => {
    let received;
    boundary.handleError(error, {}, response(500), err => { received = err; });
    return received;
  };

  assert.equal(runGate().received, undefined);
  assert.equal(recordError({ code: "P1001" }).statusCode, 503);
  assert.equal(runGate().received, undefined);
  const outage = recordError({ code: "ETIMEDOUT" });
  assert.equal(outage.statusCode, 503);
  assert.equal(outage.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(outage.retryable, true);

  const open = runGate();
  assert.equal(open.received.statusCode, 503);
  assert.equal(open.received.errors[0].dependency, "healthnet");

  now += 30001;
  const probe = runGate();
  assert.equal(probe.received, undefined);
  assert.equal(runGate().received.statusCode, 503);
  probe.res.emit("finish");
  assert.equal(boundary.status().state, "UNKNOWN");
  assert.equal(runGate().received, undefined);
});

test("non-connectivity failures are not disguised and do not open a circuit", () => {
  const boundary = createDependencyBoundary({ id: "x", name: "External" });
  const sqlError = { code: "P2002", message: "Unique constraint violation" };
  let forwarded;
  boundary.handleError(sqlError, {}, response(500), error => { forwarded = error; });
  assert.equal(forwarded, sqlError);
  let blocked;
  boundary.gate({}, response(), error => { blocked = error; });
  assert.equal(blocked, undefined);
});
