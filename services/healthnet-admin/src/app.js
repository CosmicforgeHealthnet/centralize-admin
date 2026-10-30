"use strict";

const { randomUUID } = require("node:crypto");
const { loadConfig, OPERATIONS } = require("./config");
const { isAuthorized } = require("./auth");
const { adapt } = require("./contracts");

const MAX_RESPONSE_BYTES = 1024 * 1024;
const ALLOWED_MONTH = /^(?:[1-9]|1[0-2]|January|February|March|April|May|June|July|August|September|October|November|December)$/;

function createHandler({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const config = loadConfig(env);
  function send(res, status, payload, requestId, headers = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      ...headers,
    });
    res.end(JSON.stringify(payload));
  }
  function error(res, status, code, message, requestId, retryable = false, headers = {}) {
    send(res, status, { success: false, error: { code, message, retryable, service: "healthnet-admin" }, requestId }, requestId, headers);
  }

  return async function handler(req, res) {
    const requestId = randomUUID();
    try {
      if (!req.url || !req.url.startsWith("/") || req.url.startsWith("//")) {
        return error(res, 400, "BAD_REQUEST", "Invalid request target", requestId);
      }
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      if (req.method !== "GET") {
        return error(res, 405, "METHOD_NOT_ALLOWED", "Only GET is supported", requestId, false, { Allow: "GET" });
      }

      if (pathname === "/health/live") {
        return send(res, 200, { status: "ALIVE", service: "healthnet-admin" }, requestId);
      }
      if (pathname === "/health/ready") {
        return send(res, config.ready ? 200 : 503, {
          status: config.ready ? "CONFIGURED" : "NOT_CONFIGURED",
          service: "healthnet-admin",
          upstreamReachability: "NOT_TESTED",
        }, requestId);
      }

      if (!isAuthorized(req.headers.authorization, config, now())) {
        return error(res, 401, "UNAUTHORIZED", "Internal service authorization required", requestId);
      }
      if (pathname === "/v1/capabilities") {
        return send(res, 200, {
          service: "healthnet-admin", version: "1",
          operations: Object.entries(config.routes)
            .filter(([, mapped]) => Boolean(mapped)).map(([operation]) => operation),
        }, requestId);
      }
      if (!(pathname in OPERATIONS)) {
        return error(res, 404, "NOT_FOUND", "Unknown administrative operation", requestId);
      }
      const mapped = config.routes[pathname];
      if (!mapped) {
        return error(res, 501, "OPERATION_NOT_MAPPED",
          "An authoritative HealthNet platform API contract has not been configured", requestId);
      }
      if (!config.upstream || !config.upstreamToken) {
        return error(res, 503, "DEPENDENCY_UNAVAILABLE",
          "HealthNet platform administration API is not configured", requestId, true, { "Retry-After": "30" });
      }

      const allowedQueries = pathname.endsWith("/activity") || pathname.endsWith("/patients") ? ["month"] : [];
      if ([...url.searchParams.keys()].some(key => !allowedQueries.includes(key)) ||
          url.searchParams.getAll("month").length > 1 ||
          (url.searchParams.has("month") && !ALLOWED_MONTH.test(url.searchParams.get("month")))) {
        return error(res, 400, "INVALID_QUERY", "Invalid administrative query", requestId);
      }
      const target = new URL(mapped, config.upstream);
      if (url.searchParams.has("month")) target.searchParams.set("month", url.searchParams.get("month"));

      let upstream;
      try {
        upstream = await fetchImpl(target, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
          headers: {
            Authorization: "Bearer " + config.upstreamToken,
            Accept: "application/json",
            "X-Request-Id": requestId,
          },
        });
      } catch {
        return error(res, 503, "DEPENDENCY_UNAVAILABLE",
          "HealthNet platform administration data is temporarily unavailable",
          requestId, true, { "Retry-After": "30" });
      }

      if (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) {
        upstream.body?.cancel?.().catch?.(() => {});
        return error(res, 503, "DEPENDENCY_UNAVAILABLE",
          "HealthNet platform administration data is temporarily unavailable",
          requestId, true, { "Retry-After": "30" });
      }
      if (!upstream.ok) {
        upstream.body?.cancel?.().catch?.(() => {});
        return error(res, 502, "UPSTREAM_REJECTED",
          "HealthNet platform API rejected an administrative operation", requestId);
      }
      if (!(upstream.headers.get("content-type") || "").includes("application/json")) {
        upstream.body?.cancel?.().catch?.(() => {});
        return error(res, 502, "INVALID_UPSTREAM_RESPONSE",
          "HealthNet platform returned an invalid response", requestId);
      }

      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of upstream.body) {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await upstream.body.cancel?.().catch?.(() => {});
            return error(res, 502, "INVALID_UPSTREAM_RESPONSE",
              "HealthNet platform returned an oversized response", requestId);
          }
          chunks.push(Buffer.from(chunk));
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const data = adapt(pathname, raw);
        if (!data) {
          return error(res, 502, "CONTRACT_MISMATCH",
            "HealthNet platform API response does not match its administrative contract", requestId);
        }
        return send(res, 200, {
          success: true, data, source: "healthnet-platform", retrievedAt: new Date(now()).toISOString(),
        }, requestId);
      } catch {
        return error(res, 502, "INVALID_UPSTREAM_RESPONSE",
          "HealthNet platform returned an invalid response", requestId);
      }
    } catch {
      return error(res, 500, "INTERNAL_ERROR", "HealthNet Admin could not process the request", requestId);
    }
  };
}

module.exports = { createHandler };
