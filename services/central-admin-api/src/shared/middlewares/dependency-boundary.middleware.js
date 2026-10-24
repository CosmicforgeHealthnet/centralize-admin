"use strict";

const ApiError = require("../utils/ApiError");

// Only infrastructure errors are treated as an unavailable dependency.
// Validation, authorization and application/query defects must not be hidden.
const TRANSIENT_CODES = new Set([
  "P1001", "P1002", "P1008", "P1017", "P2024",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "08001", "08003", "08006", "57P01", "57P02",
]);
const CONNECTIVITY_TEXT = /timeout exceeded when trying to connect|connection terminated due to connection timeout|connect ETIMEDOUT|connect ECONNREFUSED|can't reach database server|cannot reach database server|connection terminated unexpectedly/i;

function isDependencyConnectivityError(error) {
  let current = error;
  const seen = new Set();
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (TRANSIENT_CODES.has(String(current.code || ""))) return true;
    if (CONNECTIVITY_TEXT.test(String(current.message || ""))) return true;
    current = current.cause || current.originalError;
  }
  return false;
}

function createDependencyBoundary({
  id,
  name,
  failureThreshold = 2,
  openMs = 30000,
  clock = () => Date.now(),
} = {}) {
  if (!id || !name) throw new Error("Dependency id and name are required");
  let failures = 0;
  let openUntil = 0;
  let probeInFlight = false;

  function unavailable() {
    const retryAfter = Math.max(1, Math.ceil((openUntil - clock()) / 1000) || Math.ceil(openMs / 1000));
    return new ApiError(503, `${name} is temporarily unavailable. Please retry later.`, [
      { code: "DEPENDENCY_UNAVAILABLE", dependency: id, retryable: true, retryAfter },
    ]);
  }

  function success() {
    failures = 0;
    openUntil = 0;
    probeInFlight = false;
  }

  function failure() {
    failures++;
    probeInFlight = false;
    if (failures >= failureThreshold) {
      openUntil = clock() + openMs;
    }
  }

  // Mount AFTER authorization; no unrelated admin routes depend on this gate.
  function gate(req, res, next) {
    const now = clock();
    if (openUntil > now || (openUntil && probeInFlight)) return next(unavailable());
    const isProbe = Boolean(openUntil);
    if (isProbe) probeInFlight = true;
    res.once("finish", () => {
      // A genuine successful response proves this dependency is available.
      if (res.statusCode >= 200 && res.statusCode < 300) success();
      else if (isProbe && probeInFlight) {
        // Do not indefinitely hold a half-open permit after a non-dependency error.
        probeInFlight = false;
        openUntil = 0;
        failures = 0;
      }
    });
    next();
  }

  // Mount AFTER the protected routes, before the application's error handler.
  function handleError(err, req, res, next) {
    if (!isDependencyConnectivityError(err)) {
      if (probeInFlight) {
        probeInFlight = false;
        openUntil = 0;
        failures = 0;
      }
      return next(err);
    }
    failure();
    if (res.headersSent) return next(err);
    return next(unavailable());
  }

  function status() {
    const now = clock();
    return {
      dependency: id,
      state: openUntil > now ? "UNAVAILABLE" : (probeInFlight ? "CHECKING" : (failures ? "DEGRADED" : "UNKNOWN")),
      retryAfterSeconds: openUntil > now ? Math.ceil((openUntil - now) / 1000) : 0,
    };
  }

  return { gate, handleError, status };
}

// Temporary legacy database boundary. Replace with an authenticated HealthNet
// Admin service client at extraction cutover, retaining these response semantics.
const mainDbBoundary = createDependencyBoundary({
  id: "healthnet-main-db",
  name: "HealthNet data source",
});

module.exports = { createDependencyBoundary, isDependencyConnectivityError, mainDbBoundary };
